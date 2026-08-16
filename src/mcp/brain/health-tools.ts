/**
 * Diagnostics: Brain invariant checks and the semantic-health report.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveSearchConfig } from "../../core/search/index.ts";
import { collectMaintenanceActions } from "../../core/brain/maintenance/collect.ts";
import { runDoctor } from "../../core/brain/doctor.ts";
import { applyRepair } from "../../core/brain/diagnostics.ts";
import { nextCommandField } from "../../core/brain/next-step.ts";
import { NO_EXIT_KEY, noExitReasons } from "../../core/brain/doctor-exits.ts";
import { buildOperatorSnapshot } from "../../core/brain/operator-snapshot.ts";
import { foldSemanticHealthVerdict } from "../../core/brain/health/reconcile.ts";
import {
  extractWikilinkRichBodies,
  parseWikilinkRich,
} from "../../core/brain/link-graph/parse-wikilink.ts";
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import type { DoctorIssue } from "../../core/brain/types.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceBool, coerceFormat } from "../coerce.ts";
import { vaultRelativeSafe } from "./shared.ts";

/**
 * One reported issue, as an MCP caller sees it.
 *
 * The projection is an explicit allowlist rather than a spread of the
 * record, so a field added to `DoctorIssue` reaches this surface only
 * when it is listed. `field` / `target` / `sources` (no-dead-ends, task
 * 12) are listed for exactly that reason - the CLI's `--json` renderer
 * carries them by spreading the record, and the two surfaces must not
 * disagree about what a broken-link finding contains.
 *
 * Every added key is conditional on the value being present, so an issue
 * that carries none of them produces the byte-identical payload it did
 * before they existed.
 */
function issueView(ctx: ServerContext, issue: DoctorIssue): Record<string, unknown> {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.path !== undefined ? { path: vaultRelativeSafe(ctx.vault, issue.path) } : {}),
    ...(issue.field !== undefined ? { field: issue.field } : {}),
    ...(issue.target !== undefined ? { target: issue.target } : {}),
    ...(issue.sources !== undefined ? { sources: issue.sources } : {}),
    ...nextCommandField(issue.code),
  };
}

async function toolBrainDoctor(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const strict = coerceBool(args, "strict");
  const format = coerceFormat(args);

  // Guarded repair mode (O2). Opt-in and dry-run by default; `apply`
  // performs the fixes. `strict` stays read-only and cannot apply.
  const repair = coerceBool(args, "repair");
  const apply = coerceBool(args, "apply");
  // `apply` is a modifier of `repair`; on its own it would silently return
  // read-only diagnostics, so reject it up front.
  if (apply && !repair) {
    throw new Error("brain_doctor: apply requires repair");
  }
  if (repair) {
    if (strict && apply) {
      throw new Error("brain_doctor: cannot combine strict (read-only) with repair + apply");
    }
    const outcome = applyRepair(ctx.vault, {
      dryRun: !apply,
      ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
      // The repair branch returns HERE, before the diagnostic streams
      // below are filtered - so until this argument existed a scoped
      // caller both read and REWROTE another owner's preferences
      // (a-label-is-not-a-boundary, U3). The scope bounds the plan, so
      // the write is bounded too, not just the report.
      ownerScope: gatedOwnerScopeView(ctx.vault, ctx.agentName).scope,
    });
    return { format, repair: outcome };
  }

  const result = runDoctor(ctx.vault, {
    strict,
    dbPath: resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined })
      .dbPath,
    // Same reason as the CLI verb: a check that reads a config gate must read
    // the config this server was started against, not whatever default
    // discovery would find.
    ...(ctx.configPath !== null ? { configPath: ctx.configPath } : {}),
  });

  // Every issue names the artifact it is about - `path`, `target`, the
  // referencing `sources`, and the message prose that repeats them - so
  // an unscoped report enumerated another owner's preferences, retired
  // pages and inbox signals by path (a-label-is-not-a-boundary, U3).
  // Filtered BEFORE `ok` is decided: an `ok: false` beside an empty error
  // list would say a hidden artifact is broken without naming it, which
  // is the existence leak with the evidence removed.
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  /** Generic over the three streams: they share the naming fields, not a type. */
  const visibleIssues = <
    T extends {
      readonly message: string;
      readonly path?: string;
      readonly target?: string;
      readonly sources?: ReadonlyArray<string>;
    },
  >(
    issues: ReadonlyArray<T>,
  ): ReadonlyArray<T> =>
    view.keep(issues, (i) => [
      i.path === undefined ? undefined : vaultRelativeSafe(ctx.vault, i.path),
      i.target,
      ...(i.sources ?? []),
      // The semantic-health codes (`low-evidence-confirmed`,
      // `batch-concept-inflation`) carry NO structured target - they name
      // their subjects inside the message, as `[[pref-x]]`. Read through
      // the shared wikilink lexer rather than by matching prose, so this
      // is a structural read of the same link syntax the rest of the
      // vault uses and no natural-language pattern is involved.
      ...extractWikilinkRichBodies(i.message).map((b) => parseWikilinkRich(b).target),
    ]);
  const errors = visibleIssues(result.errors);
  const warnings = visibleIssues(result.warnings);
  const uncertain = result.uncertain === undefined ? undefined : visibleIssues(result.uncertain);

  // Decide a single ok flag — `strict` only changes the CLI exit code,
  // so we mirror that semantic here: with `strict`, warnings demote ok
  // to false. Errors always do.
  const ok = errors.length === 0 && (!strict || warnings.length === 0);

  // Why a reported code carries no `next_command`. Without it the field's
  // absence has two readings - a class no single command resolves, and a
  // class nobody has registered - and an agent cannot tell them apart.
  // Resolved through the same table the CLI renderer reads.
  const noExit = noExitReasons([...errors, ...warnings, ...(uncertain ?? [])].map((i) => i.code));

  return {
    format,
    ok,
    strict,
    // no-dead-ends, task 4: `next_command` is the structural CLI string
    // the diagnostics registry holds for this code, resolved through the
    // same `nextCommandField` the `o2b brain doctor --json` renderer
    // uses so the two surfaces cannot drift. Absent - not null - for a
    // code with no registered signal, because there is no honest command
    // to name and a generic one would be invented.
    errors: errors.map((i) => issueView(ctx, i)),
    warnings: warnings.map((i) => issueView(ctx, i)),
    // v0.10.15: ranked maintenance actions surfaced as a parallel
    // signal to errors/warnings. The list is independent of `strict`
    // because nothing here downgrades the `ok` flag - actions are
    // suggestions, not invariant violations.
    suggested_actions: view
      .keep(collectMaintenanceActions(ctx.vault), (a) => [a.target])
      .map((a) => ({
        id: a.id,
        category: a.category,
        title: a.title,
        impact: a.impact,
        ...(a.target !== undefined ? { target: a.target } : {}),
      })),
    // v0.10.16: trust-layer fields. `trust_verdict` is always populated
    // by runDoctor; `verification_delta_summary` only when the caller
    // threads a dream summary through (not exposed via this tool's
    // surface, so it stays absent here). `instruction_file_warnings`
    // surfaces vault-root instruction files exceeding the configured
    // ceiling.
    ...(result.trust_verdict !== undefined ? { trust_verdict: result.trust_verdict } : {}),
    instruction_file_warnings: (result.instruction_file_warnings ?? []).map((w) => ({
      path: w.path,
      lines: w.lines,
      ceiling: w.ceiling,
    })),
    // context-integrity-gates: the third diagnostic stream. Frontmatter
    // lines the scanner dropped, lineage-ledger findings, an unmarked
    // vault root and stale writer locks all land in `uncertain`, and
    // until now the CLI was its only reader - so an agent driving the
    // doctor over MCP could not see any of them. A named failure no
    // consumer reads is still a silent failure.
    //
    // Omitted when empty, mirroring the CLI and `runDoctor` itself, so a
    // clean vault's payload is byte-identical to the pre-`uncertain`
    // shape. Additive-safe: this tool declares no `outputSchema`, so no
    // structured-output contract constrains the key set.
    ...(uncertain !== undefined && uncertain.length > 0
      ? {
          uncertain: uncertain.map((u) => ({
            code: u.code,
            ...(u.path !== undefined ? { path: vaultRelativeSafe(ctx.vault, u.path) } : {}),
            message: u.message,
            ...nextCommandField(u.code),
          })),
        }
      : {}),
    // Once per code, beside the streams rather than on every issue: a
    // reason is about a CLASS, unlike a next command, and two hundred
    // malformed timestamps share one. Absent when every reported code has
    // an exit, so a clean payload is byte-identical to the pre-task shape.
    ...(noExit.size > 0 ? { [NO_EXIT_KEY]: Object.fromEntries(noExit) } : {}),
  };
}

// ----- brain_health --------------------------------------------------------

async function toolBrainHealth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const format = coerceFormat(args);
  const result = runDoctor(ctx.vault);
  const sh = result.semantic_health;
  // Three of the four finding families name preferences by id, and the
  // batch-inflation family names their topics as well
  // (a-label-is-not-a-boundary, U3). A finding whose members are not all
  // visible is dropped WHOLE rather than trimmed: its `count` and its
  // `topics` describe the batch the detector measured, so a batch of five
  // reported as four is not a narrower true finding, it is a false one.
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const contradictions = view.keep(sh?.contradictions ?? [], (c) => [c.aId, c.bId]);
  const conceptGaps = sh?.conceptGaps ?? [];
  const staleClaims = view.keep(sh?.staleClaims ?? [], (s) => [s.id]);
  const batchInflation = view.keep(sh?.batchInflation ?? [], (b) => b.ids);
  return {
    format,
    // Folded over the FILTERED families, through the same arithmetic
    // that produced the unfiltered one. `sh.verdict` summarises findings
    // this caller may not see, so shipping it beside the emptied arrays
    // said `watch` with nothing to point at - which tells the caller a
    // hidden artifact tripped a detector, the existence leak with the
    // evidence removed. `toolBrainDoctor` above recomputes its `ok` for
    // exactly this reason.
    verdict: foldSemanticHealthVerdict({
      contradictions,
      conceptGaps,
      staleClaims,
      batchInflation,
    }),
    contradictions: contradictions.map((c) => ({
      a: c.aId,
      b: c.bId,
      ...(c.scope !== null ? { scope: c.scope } : {}),
      jaccard: c.jaccard,
      a_sign: c.aSign,
      b_sign: c.bSign,
    })),
    // A term and its frequency; the only family that names no artifact.
    concept_gaps: conceptGaps.map((g) => ({
      term: g.term,
      frequency: g.frequency,
    })),
    stale_claims: staleClaims.map((s) => ({
      id: s.id,
      last_evidence_at: s.lastEvidenceAt,
      age_days: s.ageDays,
    })),
    batch_inflation: batchInflation.map((b) => ({
      ids: b.ids,
      window_start: b.windowStart,
      window_end: b.windowEnd,
      count: b.count,
      topics: b.topics,
    })),
    ...(sh?.suppressed
      ? {
          suppressed: {
            concept_gaps: sh.suppressed.conceptGaps,
            batch_inflation: sh.suppressed.batchInflation,
            baseline: sh.suppressed.baseline,
          },
        }
      : {}),
  };
}

// ----- brain_status --------------------------------------------------------

async function toolBrainStatus(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const format = coerceFormat(args);
  const snapshot = await buildOperatorSnapshot(
    ctx.vault,
    ctx.configPath !== null ? { configPath: ctx.configPath } : {},
  );
  return { format, ...snapshot };
}

// ----- Serializers ---------------------------------------------------------

export const HEALTH_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_doctor",
    description:
      "Validate `Brain/` invariants (status-vs-folder, frontmatter, duplicate ids, ISO, log headers). Read-only by default; `repair` previews safe fixes for detected classes (WAL gaps, orphaned references), `repair`+`apply` performs them and logs one event per fix.",
    inputSchema: {
      type: "object",
      properties: {
        strict: {
          type: "boolean",
          description: "When true, warnings demote `ok` to false (CLI exit-code parity).",
        },
        repair: {
          type: "boolean",
          description:
            "Preview safe fixes for issue classes the doctor detects (dry-run). Read-only unless `apply` is also set.",
        },
        apply: {
          type: "boolean",
          description:
            "With `repair`, perform the fixes and log one typed event per fix; otherwise `repair` is a dry-run preview.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDoctor,
  },
  {
    name: "brain_health",
    description:
      "Semantic-health report: contradictory confirmed preferences (opposite sign, same subject), recurring concepts with no dedicated preference, stale evidence, and preference-confirmation bursts (batch inflation). Per-domain findings plus a clean/watch/investigate verdict. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainHealth,
  },
  {
    name: "brain_status",
    description:
      "Unified operator status snapshot: composes doctor, semantic health, hygiene, stale scan, review candidates, active profile, and state-file health. Every problem carries the exact next command to run; a healthy vault reports all-clear. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainStatus,
  },
]);
