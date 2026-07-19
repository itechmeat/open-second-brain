/**
 * Diagnostics-signal model + guarded repair driver (Source pipeline
 * integrity suite, O2, t_bd6cc4cb).
 *
 * This module is the ONE home for the diagnostics-signal shape the wave
 * introduced: an issue class carries its own next-command hint and, when
 * a safe deterministic repair exists, its fixer. Hints travel WITH the
 * issue definition (the {@link DIAGNOSTIC_SIGNALS} registry) so no
 * downstream formatter - not the repair preview, not the O3 operator
 * snapshot - hardcodes a command string. Detection stays in its existing
 * home: `doctor.ts` produces the issue stream and this module keys off it,
 * never re-implementing a lint.
 *
 * Repair contract:
 *   - `doctor.ts` (plain / `--strict`) is read-only and byte-identical;
 *     nothing here runs unless the operator opts in with `--repair`.
 *   - `planRepair` is a pure read: it previews what `--apply` would do.
 *   - `applyRepair({ dryRun: true })` is the preview surface (writes
 *     nothing); `{ dryRun: false }` performs the fixes and appends ONE
 *     typed `doctor-repair` event per applied fix.
 *   - Every fixer is safe, deterministic, and idempotent: a second apply
 *     finds nothing to do and writes nothing. A detected instance a fixer
 *     cannot safely repair is reported as needs-review, never silently
 *     dropped and never pretended-fixed.
 *
 * Fixers exist ONLY for issue classes the doctor already detects:
 *   - `wal-gap` closes a dangling dream workrun (an append-only,
 *     write-ahead-style checkpoint log that never reached a terminal
 *     phase) by appending the missing terminal `interrupted` marker.
 *     Additive: forensic content is preserved, the gap is closed.
 *   - `orphaned-reference` prunes a dead `evidenced_by` wikilink (a
 *     Brain-managed `pref-`/`ret-`/`sig-` target with no file) from a
 *     preference or retired record. The removed pointer is captured in
 *     the typed event, so the change is auditable and recoverable.
 *     Broken structural links (`supersedes`, `retired_by`,
 *     `superseded_by`) are reported needs-review: removing one would drop
 *     lifecycle provenance or break a required field.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeAgentArgument } from "../agent-identity.ts";
import { resolveAgentName } from "../config.ts";
import { vaultRelative } from "../path-safety.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";

import { collectAllBasenames, runDoctor } from "./doctor.ts";
import { scanDanglingWorkruns, WORKRUN_PHASE } from "./dream-workrun.ts";
import { appendLogEvent } from "./log.ts";
import { brainDirs } from "./paths.ts";
import { parsePreference, parseRetired } from "./preference.ts";
import { acquireLockSync } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";

// ----- Diagnostics-signal model --------------------------------------------

/**
 * One diagnostics signal: an issue class plus the exact CLI command an
 * operator runs next to act on it. `autoRepairable` is true only when a
 * fixer in this module can safely, idempotently repair the class.
 */
export interface DiagnosticSignal {
  /** Stable code: a doctor issue code, a fixer code, or an O3 source code. */
  readonly code: string;
  /** Short human label for the issue class. */
  readonly issueClass: string;
  /** Exact next command to run (a structural CLI string, never prose). */
  readonly nextCommand: string;
  /** True iff a fixer in this module repairs the class. */
  readonly autoRepairable: boolean;
}

/** Fixer codes (the two auto-repairable classes this release ships). */
export const REPAIR_CODE = Object.freeze({
  walGap: "wal-gap",
  orphanedReference: "orphaned-reference",
} as const);

/**
 * Registry: the single home for every issue class this wave surfaces and
 * its next-command hint. Doctor codes, fixer codes, and the O3 snapshot
 * source codes all resolve here so a hint is defined exactly once.
 */
export const DIAGNOSTIC_SIGNALS: ReadonlyMap<string, DiagnosticSignal> = new Map(
  (
    [
      // --- Auto-repairable fixer classes ---
      {
        code: REPAIR_CODE.walGap,
        issueClass: "dangling dream workrun (WAL gap)",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      {
        code: REPAIR_CODE.orphanedReference,
        issueClass: "orphaned evidence reference",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      // --- Doctor issue classes the fixers back (kept for hint lookup) ---
      {
        code: "dangling-workrun",
        issueClass: "dangling dream workrun (WAL gap)",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      {
        code: "broken-wikilink",
        issueClass: "broken frontmatter reference",
        nextCommand: "o2b brain doctor --repair --apply",
        autoRepairable: true,
      },
      // --- Detected-but-not-auto-repairable doctor classes ---
      {
        code: "config-missing",
        issueClass: "missing Brain config",
        nextCommand: "o2b brain init",
        autoRepairable: false,
      },
      {
        code: "config-invalid",
        issueClass: "invalid Brain config",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "schema-version-unknown",
        issueClass: "unknown schema version",
        nextCommand: "o2b brain upgrade --apply",
        autoRepairable: false,
      },
      {
        code: "principle-corrupted",
        issueClass: "corrupted preference principle",
        nextCommand: "o2b brain upgrade --apply",
        autoRepairable: false,
      },
      {
        code: "content-hash-drift",
        issueClass: "content-hash drift",
        nextCommand: "o2b brain doctor --remediate",
        autoRepairable: false,
      },
      {
        code: "duplicate-preferences",
        issueClass: "duplicate preferences",
        nextCommand: "o2b brain merge <keep> <drop>",
        autoRepairable: false,
      },
      {
        code: "orphan-evidence",
        issueClass: "orphaned apply-evidence artifact",
        nextCommand: "o2b brain audit",
        autoRepairable: false,
      },
      {
        code: "broken-backlinks",
        issueClass: "broken Brain backlink",
        nextCommand: "o2b brain backlinks",
        autoRepairable: false,
      },
      {
        code: "sync-conflict-log",
        issueClass: "sync-conflict log copy",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "contradictory-preferences",
        issueClass: "contradictory preferences",
        nextCommand: "o2b brain health",
        autoRepairable: false,
      },
      {
        code: "stale-claim",
        issueClass: "stale confirmed preference",
        nextCommand: "o2b brain stale",
        autoRepairable: false,
      },
      // --- O3 operator-snapshot source classes ---
      {
        code: "doctor-errors",
        issueClass: "doctor errors",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "doctor-warnings",
        issueClass: "doctor warnings",
        nextCommand: "o2b brain doctor",
        autoRepairable: false,
      },
      {
        code: "semantic-health",
        issueClass: "semantic-health findings",
        nextCommand: "o2b brain health",
        autoRepairable: false,
      },
      {
        code: "hygiene-findings",
        issueClass: "hygiene findings",
        nextCommand: "o2b brain hygiene scan",
        autoRepairable: false,
      },
      {
        code: "stale-notes",
        issueClass: "stale entries",
        nextCommand: "o2b brain stale",
        autoRepairable: false,
      },
      {
        code: "review-queue",
        issueClass: "review candidates pending",
        nextCommand: "o2b brain dream --dry-run",
        autoRepairable: false,
      },
      {
        code: "state-file",
        issueClass: "state-file health",
        nextCommand: "o2b brain init",
        autoRepairable: false,
      },
    ] satisfies ReadonlyArray<DiagnosticSignal>
  ).map((s) => [s.code, Object.freeze(s)]),
);

/**
 * Resolve a signal by code. Unknown codes fall back to a generic
 * doctor-run hint so a newly-added lint still renders a next command
 * without a formatter having to invent one.
 */
export function resolveSignal(code: string): DiagnosticSignal {
  const known = DIAGNOSTIC_SIGNALS.get(code);
  if (known) return known;
  return Object.freeze({
    code,
    issueClass: code,
    nextCommand: "o2b brain doctor",
    autoRepairable: false,
  });
}

// ----- Repair plan shapes ---------------------------------------------------

/** One planned fix (applicable) or a detected-but-needs-review instance. */
export interface RepairItem {
  /** Fixer code ({@link REPAIR_CODE}). */
  readonly code: string;
  /** Stable, vault-relative target identifier the fix acts on. */
  readonly target: string;
  /** True when a fixer can safely apply this; false = needs-review. */
  readonly applicable: boolean;
  /** One-line human description of the planned action. */
  readonly detail: string;
  /** Why the instance is needs-review (present iff `applicable` is false). */
  readonly reason?: string;
}

/** A detected issue class with no fixer, aggregated for the preview. */
export interface UnfixableClass {
  readonly code: string;
  readonly issueClass: string;
  readonly count: number;
  readonly nextCommand: string;
}

export interface RepairPlan {
  /** Every fixer finding: applicable fixes plus needs-review instances. */
  readonly fixes: ReadonlyArray<RepairItem>;
  /** Detected classes no fixer addresses, each with its next command. */
  readonly unfixable: ReadonlyArray<UnfixableClass>;
}

// ----- Fixers ---------------------------------------------------------------

/**
 * A fixer owns one auto-repairable class. `coversDoctorCode` is the
 * doctor issue code the fixer represents, so the planner can exclude that
 * code from the needs-a-different-tool `unfixable` list without parsing
 * doctor messages.
 */
interface Fixer {
  readonly code: string;
  readonly coversDoctorCode: string;
  plan(vault: string): RepairItem[];
  /** Apply one applicable item. Returns null on an idempotent no-op. */
  apply(vault: string, item: RepairItem): AppliedFix | null;
}

/** Separator between the parts of an `orphaned-reference` target id. */
const TARGET_SEP = "::";
/** Raw frontmatter key for the derived evidence list. */
const EVIDENCED_BY_KEY = "_evidenced_by";
/** Brain-managed id prefixes: only these are pruned as orphaned. */
const BRAIN_ID_RE = /^(pref|ret|sig)-/;

function isBrokenBrainRef(raw: string, known: ReadonlySet<string>): string | null {
  const target = normaliseWikilinkTarget(raw);
  if (!target) return null;
  if (!BRAIN_ID_RE.test(target)) return null; // external / non-Brain link: leave it
  if (known.has(target)) return null;
  return target;
}

const walGapFixer: Fixer = {
  code: REPAIR_CODE.walGap,
  coversDoctorCode: "dangling-workrun",
  plan(vault: string): RepairItem[] {
    return scanDanglingWorkruns(vault).map((path) => {
      const rel = vaultRelative(path, vault);
      return {
        code: REPAIR_CODE.walGap,
        target: rel,
        applicable: true,
        detail: `close dangling workrun ${rel} with a terminal 'interrupted' marker`,
      };
    });
  },
  apply(vault: string, item: RepairItem): AppliedFix | null {
    const path = join(vault, item.target);
    if (!existsSync(path)) return null;

    let handle: ReturnType<typeof acquireLockSync>;
    try {
      handle = acquireLockSync(path);
    } catch {
      return null; // contended: leave for a later run
    }
    try {
      // Re-check under the lock so two concurrent repairs cannot both observe
      // the run as dangling and append duplicate terminal markers (idempotent).
      if (!scanDanglingWorkruns(vault).some((p) => vaultRelative(p, vault) === item.target)) {
        return null;
      }
      const line =
        JSON.stringify({
          phase: WORKRUN_PHASE.interrupted,
          at: new Date().toISOString(),
          reason: "closed by doctor --repair",
        }) + "\n";
      const existing = readFileSync(path, "utf8");
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(path, prefix + line, "utf8");
      return {
        code: item.code,
        target: item.target,
        detail: item.detail,
      };
    } finally {
      handle.release();
    }
  },
};

const orphanedReferenceFixer: Fixer = {
  code: REPAIR_CODE.orphanedReference,
  coversDoctorCode: "broken-wikilink",
  plan(vault: string): RepairItem[] {
    const known = collectAllBasenames(vault);
    const items: RepairItem[] = [];
    const dirs = brainDirs(vault);

    walkBrainRecords(dirs.preferences, "pref-", (path) => {
      const pref = parsePreference(path);
      const rel = vaultRelative(path, vault);
      for (const raw of pref.evidenced_by) {
        const dead = isBrokenBrainRef(raw, known);
        if (dead) items.push(evidencePrune(rel, dead));
      }
      if (pref.supersedes) {
        const dead = isBrokenBrainRef(pref.supersedes, known);
        if (dead) items.push(structuralReview(rel, "supersedes", dead));
      }
    });

    walkBrainRecords(dirs.retired, "ret-", (path) => {
      const ret = parseRetired(path);
      const rel = vaultRelative(path, vault);
      for (const raw of ret.evidenced_by) {
        const dead = isBrokenBrainRef(raw, known);
        if (dead) items.push(evidencePrune(rel, dead));
      }
      const retiredBy = isBrokenBrainRef(ret.retired_by, known);
      if (retiredBy) items.push(structuralReview(rel, "retired_by", retiredBy));
      if (ret.superseded_by) {
        const dead = isBrokenBrainRef(ret.superseded_by, known);
        if (dead) items.push(structuralReview(rel, "superseded_by", dead));
      }
    });

    return items;
  },
  apply(vault: string, item: RepairItem): AppliedFix | null {
    const [rel, field, dead] = item.target.split(TARGET_SEP);
    if (rel === undefined || field !== EVIDENCED_BY_KEY || dead === undefined) return null;
    const path = join(vault, rel);
    if (!existsSync(path)) return null;
    const known = collectAllBasenames(vault);

    let handle: ReturnType<typeof acquireLockSync>;
    try {
      handle = acquireLockSync(path);
    } catch {
      return null; // contended: leave for a later run
    }
    try {
      const [meta, body] = parseFrontmatter(path);
      const arr = meta[EVIDENCED_BY_KEY];
      if (!Array.isArray(arr)) return null;
      const next = arr.filter((raw) => {
        if (typeof raw !== "string") return true;
        const broken = isBrokenBrainRef(raw, known);
        return broken !== dead; // drop exactly the still-dead target
      });
      if (next.length === arr.length) return null; // idempotent no-op
      meta[EVIDENCED_BY_KEY] = next;
      // Keep the human `## Origin` prose consistent: drop the matching
      // `- [[dead]]` bullet so the same dead target cannot re-surface as a
      // body-side broken-backlink after the frontmatter is pruned.
      const nextBody = removeOriginBullet(body, dead);
      writeFrontmatterAtomic(path, meta, nextBody, { overwrite: true });
      return { code: item.code, target: item.target, detail: item.detail };
    } finally {
      handle.release();
    }
  },
};

function evidencePrune(rel: string, dead: string): RepairItem {
  return {
    code: REPAIR_CODE.orphanedReference,
    target: [rel, EVIDENCED_BY_KEY, dead].join(TARGET_SEP),
    applicable: true,
    detail: `prune orphaned evidence [[${dead}]] from ${rel}`,
  };
}

function structuralReview(rel: string, field: string, dead: string): RepairItem {
  return {
    code: REPAIR_CODE.orphanedReference,
    target: [rel, field, dead].join(TARGET_SEP),
    applicable: false,
    detail: `${rel} has a broken '${field}' link [[${dead}]]`,
    reason:
      "removing a structural lifecycle link would drop provenance or break a required field; " +
      "reconcile it manually",
  };
}

/**
 * Remove every `- [[<dead>...]]` bullet from a preference/retired body so
 * the `## Origin` prose stops naming a target the frontmatter no longer
 * references. Only bullet lines whose wikilink normalises to `dead` are
 * dropped; all other body content is preserved verbatim.
 */
function removeOriginBullet(body: string, dead: string): string {
  const lines = body.split("\n");
  let inOrigin = false;
  const kept = lines.filter((line) => {
    // Track section boundaries so a matching bullet outside `## Origin` (in
    // Notes, How-to-apply, or any other section) is never dropped.
    if (/^#{1,6}\s+/.test(line)) {
      inOrigin = /^##\s+Origin\s*$/.test(line);
      return true;
    }
    if (!inOrigin) return true;
    const m = /^\s*-\s+(\[\[.+?\]\])\s*$/.exec(line);
    if (!m) return true;
    return normaliseWikilinkTarget(m[1]!) !== dead;
  });
  return kept.join("\n");
}

/** Iterate `<prefix>*.md` records under `dir`, skipping unparseable files. */
function walkBrainRecords(dir: string, prefix: string, cb: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith(prefix)) continue;
    try {
      cb(join(dir, name));
    } catch {
      // schema error - surfaced by the doctor, not this fixer's concern
    }
  }
}

const FIXERS: ReadonlyArray<Fixer> = Object.freeze([walGapFixer, orphanedReferenceFixer]);
const FIXER_BY_CODE: ReadonlyMap<string, Fixer> = new Map(FIXERS.map((f) => [f.code, f]));
const COVERED_DOCTOR_CODES: ReadonlySet<string> = new Set(FIXERS.map((f) => f.coversDoctorCode));

// ----- Planner --------------------------------------------------------------

/**
 * Preview what a repair would do. Pure read: runs the doctor to enumerate
 * detected classes, gathers every fixer's findings, and aggregates the
 * classes no fixer addresses (each with its next-command hint).
 */
export function planRepair(vault: string): RepairPlan {
  const fixes: RepairItem[] = [];
  for (const fixer of FIXERS) fixes.push(...fixer.plan(vault));

  const doctor = runDoctor(vault);
  const counts = new Map<string, number>();
  for (const issue of [...doctor.errors, ...doctor.warnings]) {
    if (COVERED_DOCTOR_CODES.has(issue.code)) continue;
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  const unfixable: UnfixableClass[] = [...counts.entries()]
    .map(([code, count]) => {
      const sig = resolveSignal(code);
      return {
        code,
        issueClass: sig.issueClass,
        count,
        nextCommand: sig.nextCommand,
      };
    })
    .toSorted((a, b) => a.code.localeCompare(b.code));

  return Object.freeze({ fixes: Object.freeze(fixes), unfixable: Object.freeze(unfixable) });
}

// ----- Apply ----------------------------------------------------------------

export interface AppliedFix {
  readonly code: string;
  readonly target: string;
  readonly detail: string;
  /** Absolute path of the log file the typed event landed in (apply only). */
  readonly logPath?: string;
}

export interface RepairOutcome {
  readonly dryRun: boolean;
  /** Fixes that were (or, under dry-run, would be) applied. */
  readonly applied: ReadonlyArray<AppliedFix>;
  /** Detected-but-needs-review instances a fixer will not touch. */
  readonly needsReview: ReadonlyArray<RepairItem>;
  /** Detected classes no fixer addresses. */
  readonly unfixable: ReadonlyArray<UnfixableClass>;
}

export interface ApplyRepairOptions {
  /** True previews without writing; false performs the fixes. */
  readonly dryRun: boolean;
  /** Wall clock for the typed event timestamps. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Agent identity recorded on each event. Resolver default when blank. */
  readonly agent?: string;
  /** Config path for the agent-name resolver. */
  readonly configPath?: string;
}

/**
 * Run the guarded repair. `dryRun: true` returns exactly what would be
 * applied and writes nothing; `dryRun: false` performs each applicable
 * fix and appends one typed `doctor-repair` event per fix that actually
 * changed disk. Idempotent: a second non-dry-run call finds nothing to do.
 */
export function applyRepair(vault: string, opts: ApplyRepairOptions): RepairOutcome {
  const plan = planRepair(vault);
  const needsReview = plan.fixes.filter((f) => !f.applicable);
  const applicable = plan.fixes.filter((f) => f.applicable);

  if (opts.dryRun) {
    const applied = applicable.map((f) => ({ code: f.code, target: f.target, detail: f.detail }));
    return Object.freeze({
      dryRun: true,
      applied: Object.freeze(applied),
      needsReview: Object.freeze(needsReview),
      unfixable: plan.unfixable,
    });
  }

  const agent = normalizeAgentArgument(opts.agent ?? null) ?? resolveAgentName(opts.configPath);
  const timestamp = isoSecond(opts.now ?? new Date());
  const applied: AppliedFix[] = [];
  for (const item of applicable) {
    const fixer = FIXER_BY_CODE.get(item.code);
    if (!fixer) continue;
    const result = fixer.apply(vault, item);
    if (!result) continue; // idempotent no-op: nothing changed, no event
    const res = appendLogEvent(vault, {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.doctorRepair,
      body: { code: result.code, target: result.target, detail: result.detail, agent },
    });
    applied.push({ ...result, logPath: res.logPath });
  }

  return Object.freeze({
    dryRun: false,
    applied: Object.freeze(applied),
    needsReview: Object.freeze(needsReview),
    unfixable: plan.unfixable,
  });
}
