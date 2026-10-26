/**
 * `o2b brain continuity export` (Memory Observability Suite,
 * t_51959aeb): read-only trajectory export of the continuity store as
 * ATOF JSONL or ATIF v1.7 documents. Mapping decisions live in
 * docs/brainstorm/memory-observability-suite/atof-atif-mapping.md.
 *
 * Privacy: the exporter consumes the continuity read-model, which drops
 * `private` records and never un-masks redacted text, and then hands the
 * loaded records to the shared egress guard before rendering.
 *
 * The second pass is not redundant. The read model's upstream redaction
 * runs at WRITE time with the redactor's default options, so
 * `redactTokens` and `redactUrlCredentials` are both off - the two the
 * export boundary turns on precisely because a false negative there is
 * unrecoverable. A vendor key, a bare high-entropy token and a
 * `user:pass@host` URL all left through here verbatim while every other
 * export verb redacted them. Write-time coverage also says nothing about
 * a record already on disk or appended by another writer: the read model
 * never re-scans. Scanning what this verb actually READ answers both.
 *
 * The third subcommand, `promote` (issue #277), is the one that writes:
 * it re-renders `host_memory_write` records as unconfirmed preference
 * pages through the read-model, dry-run by default, sealed with an
 * approval digest an apply must carry back.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadNormalizedContinuityRecords } from "../../../core/brain/continuity/read-model.ts";
import { promoteHostMemory } from "../../../core/brain/continuity/promote-host-memory.ts";
import {
  PromoteConflictsError,
  type PromoteConflictsPartialProgress,
  type PromoteHostMemoryResult,
} from "../../../core/brain/continuity/promote-host-memory.ts";
import {
  deriveUsageSignals,
  rankByUsageDecay,
} from "../../../core/brain/continuity/usage-signal.ts";
import { renderAtofEvents } from "../../../core/brain/continuity/export-atof.ts";
import {
  EGRESS_OUTCOME,
  EGRESS_REDACTION_NOTICE,
  redactForEgress,
} from "../../../core/egress/guard.ts";
import {
  countSessionlessRecords,
  renderAtifTrajectories,
} from "../../../core/brain/continuity/export-atif.ts";
import { OPEN_SECOND_BRAIN_VERSION } from "../../../core/version.ts";
import { brainVerbContext, fail, parse, usageError } from "../helpers.ts";

const CLI_VERSION: string = OPEN_SECOND_BRAIN_VERSION;

const USAGE =
  "usage: o2b brain continuity export --format atof|atif [--session <id>] [--month YYYY-MM] [--out <dir>] [--json]\n" +
  "       o2b brain continuity rank [--kind <kind>] [--limit N] [--json]\n" +
  "       o2b brain continuity promote [--month YYYY-MM] [--apply] [--approval-digest <hex>] [--json]";

export async function cmdBrainContinuity(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "export") return exportContinuity(argv.slice(1));
  if (subcommand === "rank") return rankContinuity(argv.slice(1));
  if (subcommand === "promote") return promoteContinuity(argv.slice(1));
  return fail(USAGE);
}

function exportContinuity(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    format: { type: "string" },
    session: { type: "string" },
    month: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
  });
  const format = typeof flags["format"] === "string" ? flags["format"].trim() : "";
  if (format !== "atof" && format !== "atif") return fail(USAGE);
  const month = typeof flags["month"] === "string" ? flags["month"].trim() : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    return fail("brain continuity export: --month must look like YYYY-MM");
  }
  const session = typeof flags["session"] === "string" ? flags["session"].trim() : undefined;
  const outDir = resolve(typeof flags["out"] === "string" ? flags["out"].trim() : ".");

  const vault = brainVerbContext(flags).vault;
  const loaded = loadNormalizedContinuityRecords(vault, {
    ...(session !== undefined && session !== "" ? { sessionId: session } : {}),
    ...(month !== undefined ? { since: `${month}-01`, until: `${month}-31T23:59:59.999Z` } : {}),
  });
  // Before the directory is created: a refusal leaves no trace of a write
  // that did not happen.
  const verdict = redactForEgress("brain-continuity-export", loaded);
  if (verdict.outcome !== EGRESS_OUTCOME.released) return fail(verdict.detail);
  const records = verdict.payload;

  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  let skippedSessionless = 0;
  if (format === "atof") {
    const lines = renderAtofEvents(records);
    const path = join(outDir, `o2b-continuity-${month ?? "all"}.atof.jsonl`);
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
    written.push(path);
  } else {
    skippedSessionless = countSessionlessRecords(records);
    for (const trajectory of renderAtifTrajectories(records, { agentVersion: CLI_VERSION })) {
      const path = join(outDir, `o2b-continuity-${safeName(trajectory.session_id)}.atif.json`);
      writeFileSync(path, `${JSON.stringify(trajectory, null, 2)}\n`, "utf8");
      written.push(path);
    }
  }

  // stderr, so stdout stays byte-identical and parseable.
  if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          format,
          records: records.length,
          skipped_sessionless: skippedSessionless,
          files: written,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`exported ${records.length} record(s) as ${format}\n`);
  for (const path of written) process.stdout.write(`  ${path}\n`);
  if (skippedSessionless > 0) {
    process.stdout.write(`  skipped ${skippedSessionless} record(s) without a session id\n`);
  }
  return 0;
}

const DEFAULT_RANK_KIND = "pre_compact_extract";
const DEFAULT_RANK_LIMIT = 20;

/**
 * `o2b brain continuity rank`: list working-memory continuity records
 * ordered by usage-driven decay weight (freshest and most-recalled
 * first, stale and untouched last). Read-only; the store is never
 * mutated. Default scope is the `pre_compact_extract` working-memory
 * kind; `--kind <k>` narrows to another kind and `--all` ranks every
 * kind.
 */
function rankContinuity(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  });

  const all = flags["all"] === true;
  const kind = typeof flags["kind"] === "string" ? flags["kind"].trim() : DEFAULT_RANK_KIND;
  let limit = DEFAULT_RANK_LIMIT;
  if (typeof flags["limit"] === "string") {
    const parsed = Number(flags["limit"]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return usageError("brain continuity rank: --limit must be a positive integer");
    }
    limit = parsed;
  }

  const vault = brainVerbContext(flags).vault;
  const records = loadNormalizedContinuityRecords(vault, all ? {} : { kind });
  const signals = deriveUsageSignals(vault);
  const ranked = rankByUsageDecay(records, signals, Date.now()).slice(0, limit);

  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: all ? "all" : kind,
          total: records.length,
          ranked: ranked.map((entry) => ({
            id: entry.record.id,
            kind: entry.record.kind,
            created_at: entry.record.createdAt,
            weight: entry.weight,
            access_count: entry.accessCount,
            last_access_at:
              entry.lastAccessAtMs !== null ? new Date(entry.lastAccessAtMs).toISOString() : null,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (ranked.length === 0) {
    process.stdout.write(`no ${all ? "" : `${kind} `}continuity records to rank\n`);
    return 0;
  }
  process.stdout.write(`ranked ${ranked.length} of ${records.length} record(s) by usage decay\n`);
  for (const entry of ranked) {
    const lastAccess =
      entry.lastAccessAtMs !== null ? new Date(entry.lastAccessAtMs).toISOString() : "never";
    const preview = previewText(entry.record.payload);
    process.stdout.write(
      `  ${entry.weight.toFixed(3)}  ${entry.record.kind}  uses=${entry.accessCount}  last=${lastAccess}${preview}\n`,
    );
  }
  return 0;
}

function previewText(payload: Readonly<Record<string, unknown>>): string {
  const text = payload["text"];
  if (typeof text !== "string" || text.length === 0) return "";
  const trimmed = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `  ${trimmed.replace(/\s+/g, " ")}`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/**
 * `o2b brain continuity promote`: re-render `host_memory_write` records
 * as unconfirmed preference pages (issue #277). Dry-run by default - it
 * plans, seals the plan and prints the digest, and writes nothing.
 * `--apply` lands the plan; non-interactively it must carry the dry
 * run's digest via `--approval-digest`, exactly as import-claude-memory
 * does, so what lands is what was reviewed.
 */
function promoteContinuity(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    month: { type: "string" },
    apply: { type: "boolean" },
    "approval-digest": { type: "string" },
    json: { type: "boolean" },
  });
  const month = typeof flags["month"] === "string" ? flags["month"].trim() : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    return usageError("brain continuity promote: --month must look like YYYY-MM");
  }
  const mode = flags["apply"] === true ? "apply" : "dry-run";
  const approvalDigest =
    typeof flags["approval-digest"] === "string" ? flags["approval-digest"].trim() : undefined;
  // A dry run COMPUTES a digest; it cannot consume one. Refuse the
  // pairing by name instead of silently dropping the value.
  if (mode !== "apply" && approvalDigest !== undefined) {
    return usageError(
      "brain continuity promote: --approval-digest applies to --apply; " +
        "a dry run computes a digest, it does not consume one",
    );
  }
  if (mode === "apply" && approvalDigest === undefined && !process.stdin.isTTY) {
    return usageError(
      "brain continuity promote: --apply requires --approval-digest in non-interactive " +
        "mode (run the default dry run first, then apply with the digest it prints)",
    );
  }

  const vault = brainVerbContext(flags).vault;
  const asJson = flags["json"] === true;
  try {
    const res = promoteHostMemory({
      vault,
      mode,
      ...(month !== undefined ? { month } : {}),
      ...(approvalDigest !== undefined ? { approvalDigest } : {}),
    });
    if (asJson) process.stdout.write(`${renderPromoteJson(month, res)}\n`);
    else if (mode === "dry-run") printPromotePlan(res);
    else {
      printPromoteApply(
        res.applied,
        res.skipped,
        res.skippedUnchanged,
        res.snapshotRunId,
        res.redactedCount,
        res.privateCount,
        res.total,
        res.conflicts,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof PromoteConflictsError) {
      // The safe writes already landed; report the applied progress, then
      // the conflicts, and exit 2.
      const partial = err.partial;
      if (asJson && partial !== null) {
        process.stdout.write(`${renderPromotePartialJson(month, partial, err.conflicts)}\n`);
      } else {
        if (partial !== null) {
          printPromoteApply(
            partial.applied,
            partial.skipped,
            partial.skippedUnchanged,
            partial.snapshotRunId,
            partial.redactedCount,
            partial.privateCount,
            partial.total,
            err.conflicts,
          );
        }
        process.stderr.write("conflicts:\n");
        for (const c of err.conflicts) {
          process.stderr.write(
            `  ${c.prefId} already exists in Brain but is not in ` +
              `Brain/.imports/host-memory-promotions.json (${c.basename})\n`,
          );
        }
      }
      return 2;
    }
    return fail(`brain continuity promote: ${(err as Error).message}`);
  }
}

function renderPromoteJson(month: string | undefined, res: PromoteHostMemoryResult): string {
  return JSON.stringify(
    {
      mode: res.mode,
      month: month ?? null,
      total: res.total,
      counts: {
        plans: res.plans.length,
        applied: res.applied.length,
        skipped: res.skipped.length,
        skipped_unchanged: res.skippedUnchanged.length,
        conflicts: res.conflicts.length,
        private_dropped: res.privateCount,
        redacted: res.redactedCount,
      },
      digest: res.digest,
      snapshot: res.snapshotRunId,
      plans: res.plans.map((p) => ({ id: p.basename, pref_id: p.prefId, action: p.action })),
      skipped: res.skipped.map((s) => ({ id: s.id, reason: s.reason })),
      applied: res.applied.map((p) => ({ id: p.basename, pref_id: p.prefId, action: p.action })),
    },
    null,
    2,
  );
}

/** The conflict-path envelope: the same keys, built from the partial progress. */
function renderPromotePartialJson(
  month: string | undefined,
  partial: PromoteConflictsPartialProgress,
  conflicts: PromoteConflictsError["conflicts"],
): string {
  return JSON.stringify(
    {
      mode: "apply",
      month: month ?? null,
      total: partial.total,
      counts: {
        plans: partial.applied.length + partial.skippedUnchanged.length + conflicts.length,
        applied: partial.applied.length,
        skipped: partial.skipped.length,
        skipped_unchanged: partial.skippedUnchanged.length,
        conflicts: conflicts.length,
        private_dropped: partial.privateCount,
        redacted: partial.redactedCount,
      },
      digest: partial.digest,
      snapshot: partial.snapshotRunId,
      plans: [],
      skipped: partial.skipped.map((s) => ({ id: s.id, reason: s.reason })),
      applied: partial.applied.map((p) => ({
        id: p.basename,
        pref_id: p.prefId,
        action: p.action,
      })),
      conflicts: conflicts.map((p) => ({ id: p.basename, pref_id: p.prefId, action: p.action })),
    },
    null,
    2,
  );
}

function printPromotePlan(res: PromoteHostMemoryResult): void {
  process.stdout.write(
    `promote plan: ${res.plans.length} actionable, ${res.skipped.length} skipped\n`,
  );
  if (res.privateCount > 0 || res.redactedCount > 0) {
    process.stdout.write(
      `  saw ${res.total} record(s): ${res.privateCount} private dropped, ` +
        `${res.redactedCount} redacted (masked text promoted)\n`,
    );
  }
  process.stdout.write(`approval-digest: ${res.digest}\n`);
  for (const p of res.plans) process.stdout.write(`  ${p.action} ${p.prefId} (${p.basename})\n`);
  for (const s of res.skipped) process.stdout.write(`  SKIP  ${s.id}: ${s.reason}\n`);
}

function printPromoteApply(
  applied: ReadonlyArray<{ prefId: string }>,
  skipped: ReadonlyArray<{ id: string; reason: string }>,
  skippedUnchanged: ReadonlyArray<unknown>,
  snapshotRunId: string | null,
  redactedCount: number,
  privateCount: number,
  total: number,
  conflicts: ReadonlyArray<unknown>,
): void {
  process.stdout.write(
    `applied: ${applied.length}; unchanged: ${skippedUnchanged.length}; skipped: ${skipped.length}\n`,
  );
  if (privateCount > 0 || redactedCount > 0) {
    process.stdout.write(
      `  saw ${total} record(s): ${privateCount} private dropped, ` +
        `${redactedCount} redacted (masked text promoted)\n`,
    );
  }
  if (snapshotRunId) process.stdout.write(`snapshot: ${snapshotRunId}\n`);
  for (const s of skipped) process.stdout.write(`  SKIP  ${s.id}: ${s.reason}\n`);
  if (conflicts.length > 0) process.stdout.write(`conflicts: ${conflicts.length}\n`);
}
