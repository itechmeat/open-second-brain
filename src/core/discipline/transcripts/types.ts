/**
 * Per-runtime session-transcript resolver contract.
 *
 * Each runtime exports a `TranscriptRuntime` object that lists files
 * touched on the report's local day. The discipline-report layer
 * aggregates these into a `TranscriptActivity` summary which feeds
 * into the alert decision.
 */

export interface TranscriptRuntime {
  readonly runtime: "claudecode" | "codex" | "cursor";
  /**
   * Default agent attribution when the transcript itself does not
   * carry an explicit identity. The aggregator surfaces this as the
   * `agentHint` in `TranscriptActivity.byRuntime[runtime]`.
   */
  readonly agentHint: string | null;
  /**
   * Return absolute paths of transcript files that show activity
   * inside the half-open day window `[dayStartMs, dayEndMs)`.
   * `home` is injectable for tests.
   */
  collect(dayStartMs: number, dayEndMs: number, home?: string): string[];
  collectDetail?(dayStartMs: number, dayEndMs: number, home?: string): TranscriptDetail | null;
}

export interface TranscriptDetail {
  readonly sessionCount: number;
  readonly messageCount: number;
}

export interface TranscriptRuntimeActivity {
  readonly runtime: string;
  readonly fileCount: number;
  readonly agentHint: string | null;
  readonly detail?: TranscriptDetail;
}

export interface TranscriptActivity {
  readonly byRuntime: ReadonlyArray<TranscriptRuntimeActivity>;
  readonly totalFiles: number;
}
