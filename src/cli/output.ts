/**
 * Shared output helpers for the `o2b` CLI.
 *
 * Centralises the repeated stdout/stderr write patterns so every
 * subcommand uses the same shape for success, error, info, and JSON
 * output.
 */

/** Emit a state-changing command's status line on stdout. */
export function ok(line: string): void {
  process.stdout.write(line + (line.endsWith("\n") ? "" : "\n"));
}

/** Emit minimal JSON for `--json` on state-changing commands. */
export function okJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
}

/** Write an error message to stderr and return exit code 1. */
export function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

/** Emit an informational line on stdout (no `error:` prefix). */
export function info(message: string): void {
  process.stdout.write(message + (message.endsWith("\n") ? "" : "\n"));
}

/**
 * Render `payload` as pretty-printed JSON with sorted keys, plus a
 * trailing newline. Centralises the format so subcommands don't each
 * repeat the same `JSON.stringify(...) + "\n"` boilerplate.
 */
export function writeJson(
  payload: unknown,
  replacer?: ((key: string, value: unknown) => unknown) | null,
): void {
  process.stdout.write(JSON.stringify(payload, replacer ?? undefined, 2) + "\n");
}

/**
 * Render a uniform `error: failed to <action>: <reason>\n` message on
 * stderr and return exit-code 1. Use as the `return failWith(...)` last
 * expression of a catch arm so the subcommand keeps its single-exit shape.
 */
export function failWith(action: string, exc: unknown): number {
  const reason = (exc as Error)?.message ?? String(exc);
  process.stderr.write(`error: failed to ${action}: ${reason}\n`);
  return 1;
}
