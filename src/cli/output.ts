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
  process.stderr.write(`error: failed to ${action}: ${describeErrorChain(exc)}\n`);
  return 1;
}

/** Upper bound on the `cause` chain rendered, since a chain can be cyclic. */
const CAUSE_RENDER_LIMIT = 4;

/**
 * An error's message PLUS the chain of causes underneath it.
 *
 * Every catch arm in this CLI used to render `(exc as Error).message` and
 * stop, which discards exactly the half of the error that says what actually
 * happened. GitHub #167 is the case that made this expensive rather than
 * untidy: the snapshot gate's id-exhaustion error attached the real failure
 * as `cause`, the operator was shown only the summary, and the summary was
 * wrong - the message described a full archive directory while the cause said
 * `mkdir Brain/.snapshots` had failed. An error that constructs a `cause`
 * has already decided the detail is load-bearing; the renderer is not the
 * place to overrule it.
 *
 * A cause whose text the outer message already carries is skipped, because
 * the common wrapper re-states its cause and `X: Y; caused by: Y` reads as
 * two failures. The walk is bounded for the same reason the `cause` walk in
 * `fs-atomic.ts` is: a chain can be made cyclic, and a hang while reporting
 * an error is worse than a truncated report.
 */
export function describeErrorChain(exc: unknown): string {
  let rendered = messageOf(exc);
  let current: unknown = (exc as { readonly cause?: unknown })?.cause;
  // The bound counts LINKS WALKED, not lines printed: a chain of repeated
  // messages is skipped for being redundant, and counting only what is
  // printed would let such a chain spin forever if it were cyclic.
  for (let depth = 0; depth < CAUSE_RENDER_LIMIT; depth += 1) {
    if (current === undefined || current === null) break;
    const text = messageOf(current);
    if (text.length > 0 && !rendered.includes(text)) rendered += `; caused by: ${text}`;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return rendered;
}

/** One error's own text, for anything a `throw` can carry. */
function messageOf(exc: unknown): string {
  const message = (exc as Error | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : String(exc);
}
