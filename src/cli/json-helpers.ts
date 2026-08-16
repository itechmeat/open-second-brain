const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|crypt[_-]?password)/i;
const SECRET_ASSIGNMENT_RE =
  /((?:api[_-]?key|token|secret|password|crypt[_-]?password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

/** The long flag every verb accepts to request machine-readable output. */
const JSON_FLAG = "--json";
const JSON_FLAG_ASSIGNMENT = `${JSON_FLAG}=`;

/**
 * Argv terminator. `parseFlags` treats every token after it as positional,
 * so nothing past it can be a flag.
 */
const ARGV_TERMINATOR = "--";

/**
 * True when `argv` requests JSON output as a FLAG rather than as literal
 * content.
 *
 * The scan is faithful to `parseFlags` on the one part of the grammar that
 * needs no per-verb schema: it stops at `--`, after which `o2b brain note
 * -- "--json"` is a note whose text is the flag, not a JSON request.
 *
 * The remaining ambiguity - a `--json` token sitting in the value position
 * of a value-taking flag - is undecidable here, because the two `main.ts`
 * call sites run before per-verb parsing and so have no schema. It stays
 * conservative: the token counts as a flag, which at worst adds a buffered
 * envelope. It is NOT resolved by guessing which flags take values, because
 * guessing wrong in the other direction would drop a real `--json`.
 * Consumers that need the authoritative answer must read their own parsed
 * flag - which is exactly what `advisory-rail.ts` requires of its callers.
 */
export function wantsJsonFlag(argv: ReadonlyArray<string>): boolean {
  for (const arg of argv) {
    if (arg === ARGV_TERMINATOR) return false;
    if (arg === JSON_FLAG || arg.startsWith(JSON_FLAG_ASSIGNMENT)) return true;
  }
  return false;
}

/**
 * Top-level commands that render their own JSON under `--json`. Their
 * stdout is a payload a caller parses, so it is never wrapped by
 * {@link withJsonFallback} and never safe for advisory chrome.
 */
export const COMMANDS_WITH_INTERNAL_JSON: ReadonlySet<string> = new Set([
  "status",
  "install",
  "update",
  "tool-call",
  "secrets",
  "brain",
  "search",
  "vault",
  "state",
  "discipline",
  "partner",
  "doctor",
  "onboarding",
]);

/**
 * True when `command` owns its JSON output rather than being wrapped in the
 * {@link withJsonFallback} envelope. This is the single fact table behind
 * two questions: which invocations `main` must wrap, and - via
 * `advisory-rail.ts` - which stdout streams advisory chrome would corrupt.
 * It answers the structural question only; whether the caller actually
 * asked for JSON is the caller's to supply.
 */
export function ownsInternalJson(command: string, rest: ReadonlyArray<string>): boolean {
  if (COMMANDS_WITH_INTERNAL_JSON.has(command)) return true;
  // `mcp` prints JSON only for the probe; `help` renders the manifest.
  if (command === "mcp" && rest.includes("--probe")) return true;
  return command === "help";
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretString(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
      key,
      SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSecrets(raw),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export async function withJsonFallback(
  command: string,
  run: () => Promise<number>,
): Promise<number> {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stdout += stringifyChunk(chunk);
    invokeWriteCallback(encodingOrCallback, callback);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    stderr += stringifyChunk(chunk);
    invokeWriteCallback(encodingOrCallback, callback);
    return true;
  }) as typeof process.stderr.write;

  let code: number;
  try {
    code = await run();
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  process.stdout.write(
    JSON.stringify(redactSecrets({ ok: code === 0, command, code, stdout, stderr }), null, 2) +
      "\n",
  );
  return code;
}

function redactSecretString(value: string): string {
  return value.replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]");
}

function stringifyChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

function invokeWriteCallback(encodingOrCallback: unknown, callback: unknown): void {
  if (typeof encodingOrCallback === "function") {
    encodingOrCallback();
  } else if (typeof callback === "function") {
    callback();
  }
}
