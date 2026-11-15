/**
 * `signal-exit` 3.x ships no types. The one call this codebase makes:
 * register a handler that runs on any process exit, a fatal signal
 * included, and get back a function that removes it.
 */
declare module "signal-exit" {
  export default function onExit(
    callback: (code: number | null, signal: string | null) => void,
    options?: { readonly alwaysLast?: boolean },
  ): () => void;
}
