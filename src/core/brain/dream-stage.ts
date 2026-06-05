/**
 * Staged dream pipeline (t_ae8a8ec0, article: Hermes Dreaming).
 *
 * `dream()` promotes inline; `brain_review_candidates` previews; the
 * snapshot layer rolls back after the fact. What was missing is a
 * REVIEWABLE artifact between "the engine planned this" and "the
 * engine wrote this": a persisted, discardable proposal bundle an
 * operator (or watchdog) can diff, validate, apply, or throw away as
 * a unit.
 *
 * The cardinal rule: dream() stays the ONLY promotion engine.
 *
 *   - `stageDream` runs the engine in dry-run mode and persists the
 *     clock-normalized plan projection plus the scanned sources under
 *     `Brain/dream/staged/<run-id>/` (manifest.json / REPORT.md /
 *     sources.jsonl / proposals.jsonl).
 *   - `validateDreamBundle` recomputes the dry-run plan and compares
 *     projections - equality proves the vault has not drifted since
 *     staging (the engine is deterministic for fixed inputs + clock-
 *     relevant state).
 *   - `applyDreamBundle` re-validates with the SAME `now` it will run
 *     with, then executes `dream()` live; determinism guarantees the
 *     live run performs exactly the staged plan. Drift at any point
 *     aborts before a single write.
 *
 * The projection deliberately drops run ids, timestamps, and any
 * field that legitimately varies with the wall clock without changing
 * the plan (e.g. quarantine `age_days` - threshold crossings still
 * surface because `failed_gates` flips).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { appendMetric } from "./metrics.ts";
import { brainDirs } from "./paths.ts";
import { dream, type DreamOptions, type DreamRunSummary } from "./dream.ts";
import { isoSecond } from "./time.ts";

export const DREAM_STAGE_SCHEMA_VERSION = "o2b.dream-stage.v1";

/**
 * Clock-normalized projection of a dream plan. Every array is sorted
 * so equality is insensitive to scan order; no run ids or timestamps.
 */
export interface DreamStagePlan {
  readonly changed: boolean;
  readonly new_unconfirmed: ReadonlyArray<string>;
  readonly confirmed: ReadonlyArray<string>;
  readonly retired: ReadonlyArray<{ id: string; reason: string }>;
  readonly contradictions: ReadonlyArray<string>;
  readonly moved_to_processed: ReadonlyArray<string>;
  readonly suppressed: ReadonlyArray<string>;
  readonly quarantined: ReadonlyArray<{ topic: string; failed_gates: ReadonlyArray<string> }>;
  readonly gated_retires: ReadonlyArray<{ pref_id: string; attempted_reason: string }>;
}

export interface DreamStageSource {
  readonly path: string;
  readonly sha256: string;
}

export interface DreamStageBundle {
  readonly runId: string;
  /** Absolute bundle directory. */
  readonly dir: string;
  readonly plan: DreamStagePlan;
  readonly sources: ReadonlyArray<DreamStageSource>;
}

export interface DreamStageValidation {
  readonly valid: boolean;
  /** Human-readable drift lines; empty when valid. */
  readonly drift: ReadonlyArray<string>;
  readonly staged: DreamStagePlan | null;
  readonly recomputed: DreamStagePlan | null;
}

export interface DreamStageApplyOutcome {
  readonly applied: boolean;
  readonly validation: DreamStageValidation;
  /** Present iff applied. */
  readonly summary?: DreamRunSummary;
}

export interface DreamBundleInfo {
  readonly runId: string;
  readonly status: "staged" | "applied";
  readonly stagedAt: string;
  readonly proposals: number;
  readonly sources: number;
}

export interface DreamStageOptions {
  readonly now: Date;
  /** Forwarded to the underlying dream pass. */
  readonly safeguard?: DreamOptions["safeguard"];
  readonly agentName?: string;
}

/** Sorted-copy helper keeping projections order-insensitive. */
function sorted<T>(values: ReadonlyArray<T>, key: (v: T) => string): T[] {
  return [...values].toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The comparable plan projection of one dream summary. */
export function projectDreamPlan(summary: DreamRunSummary): DreamStagePlan {
  return Object.freeze({
    changed: summary.changed,
    new_unconfirmed: Object.freeze([...summary.new_unconfirmed].toSorted()),
    confirmed: Object.freeze([...summary.confirmed].toSorted()),
    retired: Object.freeze(
      sorted(
        summary.retired.map((r) => ({ id: r.id, reason: String(r.reason) })),
        (r) => r.id,
      ),
    ),
    contradictions: Object.freeze([...summary.contradictions].toSorted()),
    moved_to_processed: Object.freeze([...summary.moved_to_processed].toSorted()),
    suppressed: Object.freeze([...summary.suppressed].toSorted()),
    quarantined: Object.freeze(
      sorted(
        summary.quarantined.map((q) => ({
          topic: q.topic,
          failed_gates: Object.freeze([...q.failed_gates].toSorted()),
        })),
        (q) => q.topic,
      ),
    ),
    gated_retires: Object.freeze(
      sorted(
        summary.gated_retires.map((g) => ({
          pref_id: g.pref_id,
          attempted_reason: String(g.attempted_reason),
        })),
        (g) => g.pref_id,
      ),
    ),
  });
}

function stagedRoot(vault: string): string {
  return join(vault, "Brain", "dream", "staged");
}

function appliedRoot(vault: string): string {
  return join(vault, "Brain", "dream", "applied");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Active inbox signals (not processed/) with content hashes. */
function scanSources(vault: string): DreamStageSource[] {
  const inbox = brainDirs(vault).inbox;
  if (!existsSync(inbox)) return [];
  const out: DreamStageSource[] = [];
  for (const entry of readdirSync(inbox, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = join(inbox, entry.name);
    try {
      out.push({ path: `Brain/inbox/${entry.name}`, sha256: sha256(readFileSync(abs, "utf8")) });
    } catch {
      // A torn read shows up as plan drift later, not as a stage crash.
    }
  }
  return out.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

/** Flatten one plan into proposal records for proposals.jsonl. */
function planToProposals(plan: DreamStagePlan): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const id of plan.new_unconfirmed) rows.push({ type: "create_preference", id });
  for (const id of plan.confirmed) rows.push({ type: "confirm_preference", id });
  for (const r of plan.retired)
    rows.push({ type: "retire_preference", id: r.id, reason: r.reason });
  for (const id of plan.moved_to_processed) rows.push({ type: "process_signal", id });
  for (const id of plan.suppressed) rows.push({ type: "suppress_signal", id });
  for (const q of plan.quarantined) {
    rows.push({ type: "quarantine_cluster", topic: q.topic, failed_gates: q.failed_gates });
  }
  for (const g of plan.gated_retires) {
    rows.push({ type: "gate_retire", pref_id: g.pref_id, attempted_reason: g.attempted_reason });
  }
  for (const topic of plan.contradictions) rows.push({ type: "open_contradiction", topic });
  return rows;
}

const section = (title: string, lines: ReadonlyArray<string>): string[] =>
  lines.length === 0 ? [] : [`## ${title}`, "", ...lines.map((l) => `- ${l}`), ""];

function renderReport(runId: string, stagedAt: string, plan: DreamStagePlan): string {
  return [
    `# Dream stage ${runId}`,
    "",
    "Auto-generated by `o2b brain dream stage`. Do not edit - validate",
    "before apply; discard to drop the whole bundle.",
    "",
    `Staged at: ${stagedAt}`,
    `Planned changes: ${plan.changed ? "yes" : "none"}`,
    "",
    ...section("Would create (unconfirmed)", plan.new_unconfirmed),
    ...section("Would confirm", plan.confirmed),
    ...section(
      "Would retire",
      plan.retired.map((r) => `${r.id} (${r.reason})`),
    ),
    ...section("Would move to processed", plan.moved_to_processed),
    ...section("Would suppress", plan.suppressed),
    ...section(
      "Quarantined clusters",
      plan.quarantined.map((q) => `${q.topic} (failed: ${q.failed_gates.join(", ")})`),
    ),
    ...section(
      "Gated retires",
      plan.gated_retires.map((g) => `${g.pref_id} (${g.attempted_reason})`),
    ),
    ...section("Open contradictions", plan.contradictions),
  ].join("\n");
}

/**
 * Run the engine in dry-run mode and persist the proposal bundle.
 * Read-only against live Brain state.
 */
export function stageDream(vault: string, opts: DreamStageOptions): DreamStageBundle {
  const summary = dream(vault, {
    now: opts.now,
    dryRun: true,
    ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
    ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
  });
  const plan = projectDreamPlan(summary);
  const sources = scanSources(vault);
  const stagedAt = isoSecond(opts.now);
  const runId = `stage-${stagedAt.replaceAll(/[:T]/g, "").replace("Z", "")}`;
  const dir = join(stagedRoot(vault), runId);
  mkdirSync(dir, { recursive: true });

  const proposals = planToProposals(plan);
  const proposalsBody = proposals.map((p) => JSON.stringify(p)).join("\n") + "\n";
  const sourcesBody =
    sources.length === 0 ? "" : sources.map((s) => JSON.stringify(s)).join("\n") + "\n";

  atomicWriteFileSync(join(dir, "proposals.jsonl"), proposalsBody);
  atomicWriteFileSync(join(dir, "sources.jsonl"), sourcesBody);
  atomicWriteFileSync(join(dir, "REPORT.md"), renderReport(runId, stagedAt, plan) + "\n");
  atomicWriteFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        schema: DREAM_STAGE_SCHEMA_VERSION,
        run_id: runId,
        staged_at: stagedAt,
        proposals: proposals.length,
        sources: sources.length,
        plan,
        plan_hash: sha256(JSON.stringify(plan)),
        sources_hash: sha256(sourcesBody),
      },
      null,
      2,
    ) + "\n",
  );

  try {
    appendMetric(vault, {
      surface: "dream_stage",
      runAt: stagedAt,
      payload: {
        action: "stage",
        run_id: runId,
        proposals: proposals.length,
        sources: sources.length,
        changed: plan.changed,
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }

  return Object.freeze({ runId, dir, plan, sources: Object.freeze(sources) });
}

/** Parse one bundle manifest; null on any defect (fail-soft reads). */
function readManifest(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const m = parsed as Record<string, unknown>;
    if (m["schema"] !== DREAM_STAGE_SCHEMA_VERSION) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Recompute the dry-run plan and compare it to the staged one.
 * `now` should be the clock the eventual apply will run with - the
 * comparison is only meaningful for the run it gates.
 */
export function validateDreamBundle(
  vault: string,
  runId: string,
  opts: DreamStageOptions,
): DreamStageValidation {
  const dir = join(stagedRoot(vault), runId);
  const manifest = readManifest(dir);
  if (manifest === null) {
    return Object.freeze({
      valid: false,
      drift: Object.freeze([`no staged bundle named ${runId} (or its manifest is unreadable)`]),
      staged: null,
      recomputed: null,
    });
  }
  const staged = manifest["plan"] as DreamStagePlan;
  const summary = dream(vault, {
    now: opts.now,
    dryRun: true,
    ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
    ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
  });
  const recomputed = projectDreamPlan(summary);

  const drift: string[] = [];
  const keys = Object.keys(recomputed) as Array<keyof DreamStagePlan>;
  for (const key of keys) {
    const before = JSON.stringify(staged[key] ?? null);
    const after = JSON.stringify(recomputed[key]);
    if (before !== after) drift.push(`${key}: staged ${before} -> now ${after}`);
  }
  return Object.freeze({
    valid: drift.length === 0,
    drift: Object.freeze(drift),
    staged,
    recomputed,
  });
}

/**
 * Re-validate, then run the engine live. The bundle archives under
 * `Brain/dream/applied/<run-id>/` with `applied_at` stamped into the
 * manifest. A failed validation aborts before any write.
 */
export function applyDreamBundle(
  vault: string,
  runId: string,
  opts: DreamStageOptions,
): DreamStageApplyOutcome {
  const validation = validateDreamBundle(vault, runId, opts);
  if (!validation.valid) {
    return Object.freeze({ applied: false, validation });
  }
  const summary = dream(vault, {
    now: opts.now,
    ...(opts.safeguard !== undefined ? { safeguard: opts.safeguard } : {}),
    ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
  });

  const dir = join(stagedRoot(vault), runId);
  const manifest = readManifest(dir);
  const appliedDir = join(appliedRoot(vault), runId);
  mkdirSync(appliedRoot(vault), { recursive: true });
  if (manifest !== null) {
    atomicWriteFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, applied_at: isoSecond(opts.now) }, null, 2) + "\n",
    );
  }
  renameSync(dir, appliedDir);

  try {
    appendMetric(vault, {
      surface: "dream_stage",
      runAt: isoSecond(opts.now),
      payload: {
        action: "apply",
        run_id: runId,
        changed: summary.changed,
        new_unconfirmed: summary.new_unconfirmed.length,
        confirmed: summary.confirmed.length,
        retired: summary.retired.length,
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }

  return Object.freeze({ applied: true, validation, summary });
}

/** Remove one staged bundle. True when it existed. */
export function discardDreamBundle(vault: string, runId: string): boolean {
  const dir = join(stagedRoot(vault), runId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Staged + applied bundles, newest staged_at first. */
export function listDreamBundles(vault: string): DreamBundleInfo[] {
  const out: DreamBundleInfo[] = [];
  for (const [root, status] of [
    [stagedRoot(vault), "staged"],
    [appliedRoot(vault), "applied"],
  ] as const) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readManifest(join(root, entry.name));
      if (manifest === null) continue;
      out.push({
        runId: entry.name,
        status,
        stagedAt: String(manifest["staged_at"] ?? ""),
        proposals: Number(manifest["proposals"] ?? 0),
        sources: Number(manifest["sources"] ?? 0),
      });
    }
  }
  return out.toSorted((a, b) => (a.stagedAt > b.stagedAt ? -1 : 1));
}
