/**
 * `@osb set` marker write-back engine (today-operator-surface,
 * t_d7be2a0c).
 *
 * Turns a prose marker like
 *
 *     @osb set note=[[A Paper]] field=status value=finished
 *
 * into a schema-validated frontmatter attribute mutation on the target
 * note. The engine is deliberately decoupled from the vault walker: it
 * takes the list of source files as input (the CLI verb composes walker
 * + engine), so it never scans the vault itself.
 *
 * Two modes, one shape on output:
 *
 *   - Report mode (`apply: false`) resolves each marker's target and
 *     validates the assignment against the schema pack, writing NOTHING.
 *     It works without the guardrail. Every marker gets a per-marker
 *     report entry carrying the resolved target, field, value, the
 *     prior value, and a validation verdict (or the typed failure with
 *     any candidate paths).
 *
 *   - Apply mode (`apply: true`) requires the `marker_writeback`
 *     guardrail; with the flag off the whole call throws
 *     {@link MarkerWritebackGuardrailError} naming the flag. For each
 *     valid marker it captures the prior value, writes the attribute via
 *     `assignNoteAttribute`, appends one `attribute-write` audit event,
 *     then consumes the applied marker via `rewriteMarkers`. A marker
 *     whose target does not resolve or whose value does not validate is
 *     reported and left UNCONSUMED - per-marker isolation means one bad
 *     marker never aborts the others. Any WRITE error (frontmatter, log,
 *     rewrite) propagates: the engine never silently swallows a failed
 *     mutation.
 *
 * Determinism: files are processed in the given order, markers in
 * document order, and the audit timestamp is injected via `now`. Applied
 * markers are annotated with the `@osb✓` sentinel that `discoverMarkers`
 * skips, so a second run over the same files applies nothing.
 */

import { readFileSync } from "node:fs";

import { sanitiseTextField } from "../redactor.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  assignNoteAttribute,
  AttributeVocabularyError,
  readAttributes,
  validateAttributeAssignment,
} from "./attributes.ts";
import { appendLogEvent } from "./log.ts";
import { discoverMarkers, type ParsedMarker } from "./inline.ts";
import { rewriteMarkers, type RewriteOp } from "./inline-rewrite.ts";
import { resolveNotePath } from "./note-path.ts";
import { NoteTitleResolutionError, resolveNoteTarget } from "./notes/note-title-resolver.ts";
import { loadGuardrailsConfigSafe } from "./policy.ts";
import { loadSchemaPack } from "./schema-pack.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

/** The `marker_writeback` guardrail flag name, surfaced in refusals. */
export const MARKER_WRITEBACK_GUARDRAIL = "marker_writeback";

/**
 * Max length for `prior_value` / `new_value` as sanitised onto the
 * `attribute-write` log event body. Mirrors the cap other single-line
 * Brain log fields use (e.g. `appendBrainNote`'s `NOTE_TEXT_MAX_LEN`).
 * The frontmatter attribute values themselves are already validated
 * single-line by `validateAttributeAssignment`; this is a belt-and-
 * braces cap for the log surface only.
 */
const ATTRIBUTE_LOG_VALUE_MAX_LEN = 4096;

/**
 * Stable per-marker verdict. The CLI verb renders these labels, so they
 * are part of the contract and must not drift:
 *
 *   - `would-apply`    - report mode; target resolved and the value
 *                        validated. Nothing was written.
 *   - `applied`        - apply mode; the frontmatter attribute was
 *                        written, the audit event appended, and the
 *                        marker consumed.
 *   - `applied-unconsumed` - apply mode; the frontmatter attribute WAS
 *                        written, but a post-write step failed: the audit
 *                        append threw, the consumption rewrite threw, or the
 *                        rewrite skipped a stale marker. The mutation stands
 *                        while the marker stays live, so a naive retry would
 *                        re-apply. This is surfaced honestly (not as
 *                        `applied`) so the operator can reconcile; the CLI
 *                        renders it and exits non-zero. `error` carries the
 *                        cause.
 *   - `invalid-target` - the `note=` target did not resolve (empty,
 *                        missing, or ambiguous). The marker is left
 *                        unconsumed; `candidates` lists the ambiguous
 *                        matches when the failure was ambiguity.
 *   - `invalid-field`  - the target resolved but the assignment failed
 *                        schema validation (undeclared type/field,
 *                        empty/multi-line/comma value, or an untyped
 *                        note). The marker is left unconsumed.
 */
export type MarkerWritebackStatus =
  | "would-apply"
  | "applied"
  | "applied-unconsumed"
  | "invalid-target"
  | "invalid-field";

/** One per-marker result row. Frozen. */
export interface MarkerWritebackEntry {
  readonly status: MarkerWritebackStatus;
  /** Vault-relative path of the source file the marker lives in. */
  readonly sourcePath: string;
  /** 1-based line the marker starts on in the source file. */
  readonly sourceLine: number;
  /** Verbatim `note=` target text from the marker. */
  readonly rawTarget: string;
  /** Field being written (normalized when validated, else the raw marker field). */
  readonly field: string;
  /** Value being written (normalized when validated, else the raw marker value). */
  readonly value: string;
  /** Resolved vault-relative target path, or `null` when unresolved. */
  readonly resolvedPath: string | null;
  /** Prior value of the field (`null` when absent or unresolved). */
  readonly priorValue: string | null;
  /** Failure message for `invalid-*`; `null` on success rows. */
  readonly error: string | null;
  /** Typed resolution error code for `invalid-target`; `null` otherwise. */
  readonly errorCode: string | null;
  /** Candidate paths for an ambiguous target; empty otherwise. */
  readonly candidates: ReadonlyArray<string>;
}

/** Frozen envelope returned by {@link applyMarkerWritebacks}. */
export interface MarkerWritebackReport {
  /** Whether this was an apply run. */
  readonly apply: boolean;
  /** Resolved state of the `marker_writeback` guardrail at call time. */
  readonly guardrailEnabled: boolean;
  /** Per-marker rows, in file-then-document order. */
  readonly entries: ReadonlyArray<MarkerWritebackEntry>;
  /** Count of `applied` rows. */
  readonly appliedCount: number;
  /** Count of `would-apply` rows. */
  readonly pendingCount: number;
  /** Count of `invalid-target` + `invalid-field` rows. */
  readonly failedCount: number;
  /**
   * Count of `applied-unconsumed` rows: mutations that landed but whose
   * marker was not consumed (audit or rewrite failed / stale-skipped). A
   * non-zero value is an operator hazard the CLI turns into a non-zero exit.
   */
  readonly unconsumedCount: number;
}

export interface MarkerWritebackOptions {
  /** Vault-relative note paths to scan for `set` markers. */
  readonly files: ReadonlyArray<string>;
  /** When `true`, write the mutations; when `false`, produce a dry-run report. */
  readonly apply: boolean;
  /** Agent identity stamped onto each audit event. */
  readonly agent: string;
  /** Injected clock for deterministic audit timestamps. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Thrown when apply mode is requested but the `marker_writeback`
 * guardrail is off. Mirrors the refusal style of the derived-fact tool:
 * the feature is not enabled, so nothing is written.
 */
export class MarkerWritebackGuardrailError extends Error {
  readonly flag = MARKER_WRITEBACK_GUARDRAIL;

  constructor(message: string) {
    super(message);
    this.name = "MarkerWritebackGuardrailError";
  }
}

interface AppliedMarker {
  readonly originText: string;
  readonly signalId: string;
  /** Index into `entries` of this marker's row, so its status can be
   * downgraded to `applied-unconsumed` if consumption does not confirm. */
  readonly entryIndex: number;
}

/**
 * Apply (or report on) every `@osb set` marker found in `opts.files`.
 * See the module header for the mode contract.
 */
export async function applyMarkerWritebacks(
  vault: string,
  opts: MarkerWritebackOptions,
): Promise<MarkerWritebackReport> {
  const guardrailEnabled = loadGuardrailsConfigSafe(vault).marker_writeback;
  if (opts.apply && !guardrailEnabled) {
    throw new MarkerWritebackGuardrailError(
      `marker write-back apply mode is off; enable guardrails.${MARKER_WRITEBACK_GUARDRAIL} in _brain.yaml`,
    );
  }

  const pack = loadSchemaPack(vault);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const entries: MarkerWritebackEntry[] = [];

  for (const file of opts.files) {
    const absSource = resolveNotePath(vault, file, { mustExist: true });
    const content = readFileSync(absSource, "utf8");
    const setMarkers = discoverMarkers(content).filter(
      (marker): marker is ParsedMarker => marker.kind === "set",
    );
    const applied: AppliedMarker[] = [];

    for (const marker of setMarkers) {
      const rawTarget = marker.note ?? "";
      const rawField = marker.field ?? "";
      const rawValue = marker.value ?? "";

      // ---- 1. Resolve the target, fail-closed. -------------------------
      let resolvedPath: string;
      try {
        resolvedPath = resolveNoteTarget(vault, rawTarget);
      } catch (err) {
        if (err instanceof NoteTitleResolutionError) {
          entries.push(
            makeEntry({
              status: "invalid-target",
              sourcePath: file,
              sourceLine: marker.originLine,
              rawTarget,
              field: rawField,
              value: rawValue,
              resolvedPath: null,
              priorValue: null,
              error: err.message,
              errorCode: err.code,
              candidates: err.candidates,
            }),
          );
          continue;
        }
        throw err;
      }

      // ---- 2. Validate the assignment against the schema pack. ---------
      // Read the target's own type; `validateAttributeAssignment` (the
      // shared entry point `assignNoteAttribute` uses) fail-closes on an
      // undeclared type/field or a malformed value. Report mode calls it
      // too so a dry-run verdict is honest.
      const [metadata] = parseFrontmatter(resolveNotePath(vault, resolvedPath));
      const rawType = metadata["type"];
      if (typeof rawType !== "string" || rawType.trim().length === 0) {
        entries.push(
          makeEntry({
            status: "invalid-field",
            sourcePath: file,
            sourceLine: marker.originLine,
            rawTarget,
            field: rawField,
            value: rawValue,
            resolvedPath,
            priorValue: null,
            error: `note declares no type in frontmatter: ${resolvedPath}`,
            errorCode: null,
            candidates: [],
          }),
        );
        continue;
      }

      let normalizedField: string;
      let normalizedValue: string;
      try {
        const assignment = validateAttributeAssignment(pack, rawType, rawField, rawValue);
        normalizedField = assignment.field;
        normalizedValue = assignment.value;
      } catch (err) {
        if (err instanceof AttributeVocabularyError) {
          entries.push(
            makeEntry({
              status: "invalid-field",
              sourcePath: file,
              sourceLine: marker.originLine,
              rawTarget,
              field: rawField,
              value: rawValue,
              resolvedPath,
              priorValue: null,
              error: err.message,
              errorCode: null,
              candidates: [],
            }),
          );
          continue;
        }
        throw err;
      }

      const priorValue = readAttributes(metadata)[normalizedField] ?? null;

      // ---- 3. Report mode stops here - nothing is written. -------------
      if (!opts.apply) {
        entries.push(
          makeEntry({
            status: "would-apply",
            sourcePath: file,
            sourceLine: marker.originLine,
            rawTarget,
            field: normalizedField,
            value: normalizedValue,
            resolvedPath,
            priorValue,
            error: null,
            errorCode: null,
            candidates: [],
          }),
        );
        continue;
      }

      // ---- 4. Apply mode: write, audit, mark for consumption. ----------
      // The frontmatter WRITE itself still propagates on failure - a
      // mutation that never landed is a hard error, not a partial state.
      assignNoteAttribute(vault, resolvedPath, {
        field: normalizedField,
        value: normalizedValue,
        pack,
      });
      // Post-write steps are hardened per marker. Once the attribute is on
      // disk, an audit-append failure must NOT throw the whole run: the
      // mutation already stands, so we surface an honest `applied-unconsumed`
      // row (mutation landed, marker still live) and leave the marker
      // unconsumed for the operator to reconcile, rather than either losing
      // the record silently or aborting the remaining markers.
      let auditError: string | null = null;
      try {
        appendLogEvent(vault, {
          timestamp: nowIso,
          eventType: BRAIN_LOG_EVENT_KIND.attributeWrite,
          agent: opts.agent,
          body: {
            note: resolvedPath,
            field: normalizedField,
            // Sanitised for the LOG surface only (best-effort secret
            // redaction, matching apply-evidence's use of
            // `sanitiseTextField`); the frontmatter mutation above already
            // wrote `normalizedValue` verbatim, so redaction here never
            // touches the actual data write.
            prior_value: sanitiseTextField(priorValue ?? "null", {
              maxLen: ATTRIBUTE_LOG_VALUE_MAX_LEN,
              singleLine: true,
            }),
            new_value: sanitiseTextField(normalizedValue, {
              maxLen: ATTRIBUTE_LOG_VALUE_MAX_LEN,
              singleLine: true,
            }),
            source_path: file,
            source_line: String(marker.originLine),
            agent: opts.agent,
          },
        });
      } catch (err) {
        auditError = (err as Error).message ?? String(err);
      }

      if (auditError !== null) {
        entries.push(
          makeEntry({
            status: "applied-unconsumed",
            sourcePath: file,
            sourceLine: marker.originLine,
            rawTarget,
            field: normalizedField,
            value: normalizedValue,
            resolvedPath,
            priorValue,
            error: `attribute written but audit append failed; marker left unconsumed: ${auditError}`,
            errorCode: null,
            candidates: [],
          }),
        );
        // Deliberately NOT added to `applied`, so the consumption rewrite
        // leaves the marker live for a retry.
        continue;
      }

      const entryIndex = entries.length;
      applied.push({ originText: marker.originText, signalId: resolvedPath, entryIndex });
      entries.push(
        makeEntry({
          status: "applied",
          sourcePath: file,
          sourceLine: marker.originLine,
          rawTarget,
          field: normalizedField,
          value: normalizedValue,
          resolvedPath,
          priorValue,
          error: null,
          errorCode: null,
          candidates: [],
        }),
      );
    }

    // ---- 5. Consume exactly the applied markers in this file. ----------
    // Rewrite at the END of this file's own iteration, before any later
    // source file runs. A later source whose `set` marker targets a note
    // processed earlier grows that note's frontmatter by a line, shifting
    // every body-marker line in it; `rewriteMarkers` trusts
    // `op.marker.originLine` verbatim, so deferring this past the later
    // mutation would point the rewrite at a stale line. Consuming now
    // keeps the line live.
    //
    // Re-discover from the freshly-written file so line numbers are
    // correct even when a marker's target was the source file itself (a
    // frontmatter write shifts body lines). Match applied markers to the
    // fresh ones by verbatim text, FIFO, so identical markers pair off
    // deterministically.
    if (opts.apply && applied.length > 0) {
      const fresh = discoverMarkers(readFileSync(absSource, "utf8")).filter(
        (marker): marker is ParsedMarker => marker.kind === "set",
      );
      const queue = [...applied];
      const ops: RewriteOp[] = [];
      const consumedIndices = new Set<number>();
      for (const marker of fresh) {
        const idx = queue.findIndex((entry) => entry.originText === marker.originText);
        if (idx < 0) continue;
        const [match] = queue.splice(idx, 1);
        ops.push({ marker, signalId: match!.signalId });
        consumedIndices.add(match!.entryIndex);
      }
      // Sequential by design: this file's markers must be consumed before a
      // later source mutates and line-shifts this note, or the rewrite would
      // land on a stale line.
      let rewriteError: string | null = null;
      try {
        // oxlint-disable-next-line no-await-in-loop
        await rewriteMarkers(absSource, ops);
      } catch (err) {
        rewriteError = (err as Error).message ?? String(err);
      }

      // Downgrade any applied marker whose consumption is not confirmed:
      // the rewrite threw (nothing consumed in this file), or the marker was
      // stale-skipped (its text no longer matched a live marker so no op was
      // emitted). The mutation already stands, so the honest status is
      // `applied-unconsumed` - a retry would re-apply otherwise.
      for (const entry of applied) {
        if (rewriteError === null && consumedIndices.has(entry.entryIndex)) continue;
        const reason =
          rewriteError !== null
            ? `attribute written but marker consumption failed; marker left unconsumed: ${rewriteError}`
            : "attribute written but the marker was not found for consumption (source changed); left unconsumed";
        const prior = entries[entry.entryIndex]!;
        entries[entry.entryIndex] = makeEntry({
          ...prior,
          status: "applied-unconsumed",
          error: reason,
        });
      }
    }
  }

  let appliedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let unconsumedCount = 0;
  for (const entry of entries) {
    switch (entry.status) {
      case "applied":
        appliedCount++;
        break;
      case "would-apply":
        pendingCount++;
        break;
      case "applied-unconsumed":
        unconsumedCount++;
        break;
      default:
        // invalid-target, invalid-field
        failedCount++;
    }
  }

  return Object.freeze({
    apply: opts.apply,
    guardrailEnabled,
    entries: Object.freeze(entries),
    appliedCount,
    pendingCount,
    failedCount,
    unconsumedCount,
  });
}

function makeEntry(entry: MarkerWritebackEntry): MarkerWritebackEntry {
  return Object.freeze({ ...entry, candidates: Object.freeze([...entry.candidates]) });
}
