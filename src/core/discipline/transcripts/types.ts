/**
 * Per-runtime session-transcript resolver contract.
 *
 * Each runtime exports a `TranscriptRuntime` object that lists files
 * touched on the report's local day. The discipline-report layer
 * aggregates these into a `TranscriptActivity` summary which feeds
 * into the alert decision.
 *
 * A scan therefore has to say WHICH emptiness it found. The count feeds an
 * alert whose whole purpose is to notice a day with no recorded work, so
 * "this runtime is not installed", "its store is there and could not be
 * read" and "the agent genuinely did nothing" cannot share one answer: the
 * middle one is the report failing, and reporting it as the last one is the
 * report lying in the direction of reassurance.
 */

/** What a scan of one runtime's transcript store found. */
export const TRANSCRIPT_SCAN = Object.freeze({
  /** At least one transcript file falls in the window. */
  collected: "collected",
  /** The store was read end to end and holds nothing in the window. */
  idle: "idle",
  /** No store for this runtime exists here - it is not installed. */
  rootAbsent: "root_absent",
  /** A directory exists but could not be enumerated; its files are uncounted. */
  unreadable: "unreadable",
} as const);

export type TranscriptScan = (typeof TRANSCRIPT_SCAN)[keyof typeof TRANSCRIPT_SCAN];

export const TRANSCRIPT_SCANS: ReadonlyArray<TranscriptScan> = Object.freeze([
  TRANSCRIPT_SCAN.collected,
  TRANSCRIPT_SCAN.idle,
  TRANSCRIPT_SCAN.rootAbsent,
  TRANSCRIPT_SCAN.unreadable,
]);

export function isTranscriptScan(value: unknown): value is TranscriptScan {
  return typeof value === "string" && (TRANSCRIPT_SCANS as ReadonlyArray<string>).includes(value);
}

/** One runtime's answer: what it found, and what it could not look at. */
export interface TranscriptScanResult {
  readonly state: TranscriptScan;
  /** Absolute paths of transcript files inside the window. */
  readonly files: ReadonlyArray<string>;
  /**
   * Directories that exist but could not be enumerated. Carried even when
   * `state` is `collected`: a partial read that found something still found
   * less than it should have, and the count alone cannot say so.
   */
  readonly unreadable: ReadonlyArray<string>;
}

/**
 * Classify a completed walk. `rootsPresent` is whether ANY of the runtime's
 * candidate store locations exists - false means the runtime is not
 * installed here, which is the one emptiness that is not a finding.
 */
export function classifyTranscriptScan(
  rootsPresent: boolean,
  files: ReadonlyArray<string>,
  unreadable: ReadonlyArray<string>,
): TranscriptScanResult {
  const state = !rootsPresent
    ? TRANSCRIPT_SCAN.rootAbsent
    : files.length > 0
      ? TRANSCRIPT_SCAN.collected
      : unreadable.length > 0
        ? TRANSCRIPT_SCAN.unreadable
        : TRANSCRIPT_SCAN.idle;
  return Object.freeze({
    state,
    files: Object.freeze([...files]),
    unreadable: Object.freeze([...unreadable]),
  });
}

export interface TranscriptRuntime {
  readonly runtime: "claudecode" | "codex" | "cursor";
  /**
   * Default agent attribution when the transcript itself does not
   * carry an explicit identity. The aggregator surfaces this as the
   * `agentHint` in `TranscriptActivity.byRuntime[runtime]`.
   */
  readonly agentHint: string | null;
  /**
   * Walk this runtime's store for transcript files that show activity
   * inside the half-open day window `[dayStartMs, dayEndMs)`, and report
   * which emptiness produced an empty list.
   *
   * `home` and `env` together are the {@link HostContext} the runtime's
   * declared roots resolve against. Both are injectable and both default
   * to this machine: the roots live in `src/core/runtime/host-facts.ts`
   * and several of them are moved by an environment variable
   * (`$CODEX_HOME`, `$GROK_HOME`), so a scanner that took only `home`
   * could be pointed at a test fixture and still miss a relocated store
   * on a real one.
   */
  scan(
    dayStartMs: number,
    dayEndMs: number,
    home?: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): TranscriptScanResult;
  collectDetail?(
    dayStartMs: number,
    dayEndMs: number,
    home?: string,
    env?: Readonly<Record<string, string | undefined>>,
  ): TranscriptDetail | null;
}

export interface TranscriptDetail {
  readonly sessionCount: number;
  readonly messageCount: number;
}

export interface TranscriptRuntimeActivity {
  readonly runtime: string;
  readonly fileCount: number;
  /** Which emptiness (or non-emptiness) produced `fileCount`. */
  readonly scan: TranscriptScan;
  /** Directories whose contents are missing from `fileCount`. */
  readonly unreadable: ReadonlyArray<string>;
  readonly agentHint: string | null;
  readonly detail?: TranscriptDetail;
}

export interface TranscriptActivity {
  readonly byRuntime: ReadonlyArray<TranscriptRuntimeActivity>;
  readonly totalFiles: number;
  /**
   * Runtimes whose walk hit a directory it could not read, so `totalFiles`
   * is a lower bound for them rather than a measurement.
   */
  readonly unreadableRuntimes: ReadonlyArray<string>;
}
