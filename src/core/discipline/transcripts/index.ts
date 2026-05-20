/**
 * Aggregator for per-runtime transcript activity used by the
 * discipline report (v0.10.11).
 *
 * Each runtime resolver returns a list of files touched in the day
 * window. The aggregator sums them and surfaces a
 * `transcriptConfirmed` flag the renderer can show next to an
 * `alert` row — confirming that the proxy activity signal is not
 * a false positive from disk-time drift alone.
 */

import { claudeCodeTranscript } from "./claude-code.ts";
import { codexTranscript } from "./codex.ts";
import { cursorTranscript } from "./cursor.ts";
import type { TranscriptActivity, TranscriptRuntime } from "./types.ts";

export { claudeCodeTranscript, codexTranscript, cursorTranscript };
export type { TranscriptActivity, TranscriptRuntime };

export const DEFAULT_TRANSCRIPT_RUNTIMES: ReadonlyArray<TranscriptRuntime> = [
  claudeCodeTranscript,
  codexTranscript,
  cursorTranscript,
];

export interface CollectTranscriptOpts {
  readonly dayStartMs: number;
  readonly dayEndMs: number;
  readonly home?: string;
  readonly runtimes?: ReadonlyArray<TranscriptRuntime>;
}

export function collectTranscriptActivity(
  opts: CollectTranscriptOpts,
): TranscriptActivity {
  const runtimes = opts.runtimes ?? DEFAULT_TRANSCRIPT_RUNTIMES;
  const byRuntime = [];
  let total = 0;
  for (const r of runtimes) {
    const files = r.collect(opts.dayStartMs, opts.dayEndMs, opts.home);
    const detail = r.collectDetail?.(opts.dayStartMs, opts.dayEndMs, opts.home) ?? null;
    byRuntime.push({
      runtime: r.runtime,
      fileCount: files.length,
      agentHint: r.agentHint,
      ...(detail ? { detail } : {}),
    });
    total += files.length;
  }
  return { byRuntime, totalFiles: total };
}
