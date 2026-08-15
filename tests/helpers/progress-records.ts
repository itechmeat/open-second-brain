/**
 * Read the progress stream a CLI run wrote to stderr.
 *
 * Progress shares stderr with warnings, advisory lines and the indexer's
 * `--verbose` per-file stream, so a reader selects by the envelope's own
 * schema discriminator rather than by position or by line count. That
 * discriminator is exactly why `renderProgressLine` writes `schema` on
 * every record, and reading the stream any other way here would let a
 * verb pass by emitting something that merely looks like progress.
 */

import { PROGRESS_SCHEMA } from "../../src/core/brain/progress.ts";

/**
 * A stage is an identifier from the emitting operation's own phase
 * vocabulary, never a sentence: the human line is rendered from it at the
 * edge. The census enforces this over the emission sites in `src/`; this
 * copy enforces it over what actually reached the terminal.
 */
export const STAGE_IDENTIFIER = /^[a-z0-9]+([-_][a-z0-9]+)*$/;

/** Every progress record on a stderr stream, in order. */
export function progressRecords(stderr: string): ReadonlyArray<Record<string, unknown>> {
  const out: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Another writer's brace-leading line, not a progress record. A
      // throw here would blame this reader for someone else's stderr.
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === PROGRESS_SCHEMA
    ) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
}
