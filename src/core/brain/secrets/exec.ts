/**
 * Secret exec path (write-time-integrity-governance, t_0b134404):
 * use a credential without it ever entering an agent's context. The
 * command must match the secret's allowlist (glob patterns declared
 * at set time by the operator - the capability gate), the value is
 * injected into the subprocess env only, and captured stdout/stderr
 * pass through the redactor with the resolved value as a known
 * literal before reaching the caller. Denials are audited as
 * `secret_exec_denied`.
 */

import { redactRawOutput } from "../../redactor.ts";
import { appendAuditRecord } from "../../reliability/audit.ts";
import { escapeRegex } from "../../strings.ts";
import { brainDirsForWrite } from "../paths.ts";
import { join } from "node:path";
import { resolveSecretForExec, type SecretAuditContext } from "./store.ts";

export class SecretExecDeniedError extends Error {
  readonly secret: string;
  readonly command: string;
  readonly allow: ReadonlyArray<string>;

  constructor(secret: string, command: string, allow: ReadonlyArray<string>) {
    super(
      allow.length === 0
        ? `secret "${secret}" has an empty allowlist - exec is denied entirely`
        : `command does not match the allowlist of secret "${secret}": ${allow.join(", ")}`,
    );
    this.name = "SecretExecDeniedError";
    this.secret = secret;
    this.command = command;
    this.allow = allow;
  }
}

export interface RunWithSecretResult {
  readonly exitCode: number;
  /** Captured stdout, redacted (secret literal + standard patterns). */
  readonly stdout: string;
  /** Captured stderr, redacted the same way. */
  readonly stderr: string;
}

/**
 * Glob match over ARGV segments, not the joined command line.
 *
 * The pattern is whitespace-split into tokens; each token globs against
 * the argv element at its position (`*` is the only metacharacter, and a
 * trailing standalone `*` matches one-or-more remaining elements, which
 * is the historical "this binary, any arguments" intent). Matching
 * segments rather than `argv.join(" ")` matters because a joined string
 * cannot see argument boundaries: the pattern `curl * https://internal`
 * would be satisfied by the single argument `https://evil https://internal`,
 * and the curl that actually spawns would fetch both URLs. The spawn
 * itself is safe (argv array, no shell) - this guard is about which argv
 * shapes the operator meant to allow.
 */
export function matchesAllowlist(
  allow: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
): boolean {
  return allow.some((pattern) => {
    const tokens = pattern
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return false;
    const trailingStar = tokens[tokens.length - 1] === "*";
    if (trailingStar) tokens.pop();
    // Fixed tokens must align element-for-element; a trailing `*` then
    // needs at least one element left to consume.
    if (argv.length < tokens.length) return false;
    if (trailingStar && argv.length === tokens.length) return false;
    if (!trailingStar && argv.length !== tokens.length) return false;
    for (let i = 0; i < tokens.length; i++) {
      if (!globElement(tokens[i]!, argv[i]!)) return false;
    }
    return true;
  });
}

function globElement(pattern: string, element: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$");
  return re.test(element);
}

/**
 * Baseline variables the subprocess receives. Deliberately minimal:
 * inheriting the full parent env would hand an allowlisted command
 * every credential the o2b process happens to carry (provider keys,
 * CI tokens) and echo them back through captured output where the
 * redactor only guarantees the requested secret literal. The child
 * gets just enough to execute (binary resolution, temp dirs, locale)
 * plus exactly one extra variable - the secret.
 */
const SAFE_BASE_ENV = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

/**
 * Run `argv` with the secret injected as its declared env var.
 * Allowlist-gated, audited both ways, output redacted. The subprocess
 * env is built from a minimal safe baseline - never the full parent
 * environment.
 */
export async function runWithSecret(
  vault: string,
  name: string,
  argv: ReadonlyArray<string>,
  ctx: SecretAuditContext,
): Promise<RunWithSecretResult> {
  if (argv.length === 0) throw new Error("secret run: a command is required after --");
  const command = argv.join(" ");
  // The audit trail is long-lived. The custody store's own secret never
  // reaches argv, but an agent may pass some OTHER credential as a bare
  // positional argument; scrub the logged command through the bare-token
  // and infra passes so a foreign secret is not persisted in cleartext.
  // The raw `command` still drives the allowlist match and the denial error
  // (the agent already holds its own input).
  const auditCommand = redactRawOutput(command, {
    redactTokens: true,
    redactInfra: true,
    maxInput: Number.POSITIVE_INFINITY,
  });
  const resolved = resolveSecretForExec(vault, name, ctx);
  if (!matchesAllowlist(resolved.allow, argv)) {
    appendAuditRecord(join(brainDirsForWrite(vault).log, "secret-custody"), {
      timestamp: ctx.now.toISOString(),
      actor: ctx.agent,
      action: "secret_exec_denied",
      target: resolved.name,
      ok: false,
      details: { command: auditCommand, allow: resolved.allow },
    });
    throw new SecretExecDeniedError(resolved.name, command, resolved.allow);
  }

  appendAuditRecord(join(brainDirsForWrite(vault).log, "secret-custody"), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action: "secret_exec_started",
    target: resolved.name,
    ok: true,
    details: { command: auditCommand, env_var: resolved.env_var },
  });

  const childEnv: Record<string, string> = {};
  for (const key of SAFE_BASE_ENV) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv[resolved.env_var] = resolved.value;
  const proc = Bun.spawn([...argv], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const literals = [resolved.value];
  // The returned output rides into model context, where a literal scrub
  // alone only stops the exact spelling: `printf '%s' "$KEY" | base64`
  // returns a transformed echo of the secret. The bare-token pass also
  // runs here, on the same reasoning the audit record above already
  // applies - the allowlist bounds what the child may be, not what it
  // may echo.
  return {
    exitCode,
    stdout: redactRawOutput(stdout, { literals, redactTokens: true }),
    stderr: redactRawOutput(stderr, { literals, redactTokens: true }),
  };
}
