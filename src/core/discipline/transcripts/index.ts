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
import {
  TRANSCRIPT_SCAN,
  type TranscriptActivity,
  type TranscriptRuntime,
  type TranscriptRuntimeActivity,
} from "./types.ts";

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
  /**
   * The environment the declared roots resolve against. Carried beside
   * `home` because several roots are moved by a variable rather than by
   * the home directory (`$CODEX_HOME`, `$GROK_HOME`), and a caller that
   * could only inject `home` would silently miss a relocated store.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runtimes?: ReadonlyArray<TranscriptRuntime>;
}

/**
 * Run every registered runtime's scan. A runtime that throws is reported as
 * `unreadable` naming the failure, never dropped: the aggregate feeds an
 * alert whose absence of evidence must not be produced by the aggregator
 * itself.
 */
export function collectTranscriptActivity(opts: CollectTranscriptOpts): TranscriptActivity {
  const runtimes = opts.runtimes ?? DEFAULT_TRANSCRIPT_RUNTIMES;
  const byRuntime: TranscriptRuntimeActivity[] = [];
  const unreadableRuntimes: string[] = [];
  let total = 0;
  for (const r of runtimes) {
    let scan;
    try {
      scan = r.scan(opts.dayStartMs, opts.dayEndMs, opts.home, opts.env);
    } catch (err) {
      scan = {
        state: TRANSCRIPT_SCAN.unreadable,
        files: [],
        unreadable: [`${r.runtime}: ${(err as Error).message}`],
      };
    }
    let detail = null;
    try {
      detail = r.collectDetail?.(opts.dayStartMs, opts.dayEndMs, opts.home, opts.env) ?? null;
    } catch {
      // The detail pass is an enrichment of a count that already stands; its
      // failure is reported by the scan state, not by losing the count.
    }
    byRuntime.push({
      runtime: r.runtime,
      fileCount: scan.files.length,
      scan: scan.state,
      unreadable: scan.unreadable,
      agentHint: r.agentHint,
      ...(detail ? { detail } : {}),
    });
    if (scan.unreadable.length > 0) unreadableRuntimes.push(r.runtime);
    total += scan.files.length;
  }
  return { byRuntime, totalFiles: total, unreadableRuntimes };
}
