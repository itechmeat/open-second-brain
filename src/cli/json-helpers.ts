const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|crypt[_-]?password)/i;
const SECRET_ASSIGNMENT_RE =
  /((?:api[_-]?key|token|secret|password|crypt[_-]?password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;

export function wantsJsonFlag(argv: ReadonlyArray<string>): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
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
