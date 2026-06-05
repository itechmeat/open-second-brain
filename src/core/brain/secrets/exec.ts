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
import { brainDirs } from "../paths.ts";
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

/** Glob match: `*` is the only metacharacter, everything else literal. */
export function matchesAllowlist(allow: ReadonlyArray<string>, command: string): boolean {
  return allow.some((pattern) => {
    const re = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    return re.test(command);
  });
}

/**
 * Run `argv` with the secret injected as its declared env var.
 * Allowlist-gated, audited both ways, output redacted. The o2b
 * process's own env is passed through untouched minus nothing - the
 * subprocess inherits it plus exactly one extra variable.
 */
export async function runWithSecret(
  vault: string,
  name: string,
  argv: ReadonlyArray<string>,
  ctx: SecretAuditContext,
): Promise<RunWithSecretResult> {
  if (argv.length === 0) throw new Error("secret run: a command is required after --");
  const command = argv.join(" ");
  const resolved = resolveSecretForExec(vault, name, ctx);
  if (!matchesAllowlist(resolved.allow, command)) {
    appendAuditRecord(join(brainDirs(vault).log, "secret-custody"), {
      timestamp: ctx.now.toISOString(),
      actor: ctx.agent,
      action: "secret_exec_denied",
      target: resolved.name,
      ok: false,
      details: { command, allow: resolved.allow },
    });
    throw new SecretExecDeniedError(resolved.name, command, resolved.allow);
  }

  appendAuditRecord(join(brainDirs(vault).log, "secret-custody"), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action: "secret_exec_started",
    target: resolved.name,
    ok: true,
    details: { command, env_var: resolved.env_var },
  });

  const proc = Bun.spawn([...argv], {
    env: { ...process.env, [resolved.env_var]: resolved.value },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const literals = [resolved.value];
  return {
    exitCode,
    stdout: redactRawOutput(stdout, { literals }),
    stderr: redactRawOutput(stderr, { literals }),
  };
}
