/**
 * `o2b brain lessons` - operator-approved lesson promotion (t_1e952e43,
 * task C2). Thin CLI wrapper over the promotion kernel
 * (`src/core/brain/lessons-promotion.ts`); qualification, rendering and
 * the approval ledger all live there. This verb adds only the operator
 * surfaces: listing, the consent ladder, and managed-block maintenance.
 *
 * Subcommands:
 *
 *   - `candidates` is READ-ONLY: the promotable set, every blocked lesson
 *     with its single named reason, and the resolved promotion scopes.
 *     It writes nothing - no rules file, no ledger, no log event.
 *   - `approve <pref-id>` follows the install consent ladder: plan-only
 *     by default (target files and the block diff), `--apply` executes,
 *     a headless `--apply` without `--yes` refuses with exit 6, an
 *     interactive `--apply` without `--yes` asks once. Before any write,
 *     the plan for EVERY affected target is computed and every writer
 *     refusal is fired (the same dry pre-pass refresh-blocks runs), so a
 *     refusal on one target refuses the whole verb and no target is left
 *     written and unmanaged. The ledger row is recorded only AFTER the
 *     rules-block writes landed, so a refused approve lifts nothing -
 *     not even a prior denial. Every rules-file byte goes through the
 *     shared writer (`src/core/install/rules-block.ts`); this verb never
 *     writes a rules file itself.
 *   - `deny <pref-id>` records the decision and appends the log event,
 *     gated by the same ladder because a denial is a state change too;
 *     it never writes a rules file.
 *   - `refresh-blocks` re-renders the managed lessons blocks from the
 *     currently qualified set. It is a dry preview by default, is a
 *     named no-op when no block exists under management (it never
 *     CREATES a block - creation is approve's write), drops a lesson
 *     whose approval went stale by name, and stamps `lastPromotedAt`
 *     on the rows whose content a write delivered.
 *
 * Trust boundary: these verbs are operator-only. No MCP tool and no hook
 * or dream path reaches them; an agent-facing surface that could approve
 * its own lessons is a design defect regardless of what tests say.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { computeContentHash } from "../../../core/brain/content-hash.ts";
import {
  LESSON_PROMOTION_BLOCKED,
  currentApprovalFor,
  gatherLessonsPromotionInputs,
  lessonPromotionCandidates,
  lessonsBlockLimit,
  markLessonPromoted,
  readLessonApprovals,
  recordLessonApproval,
  renderLessonsBlockBody,
  type LessonApprovalRow,
  type LessonPromotionCandidate,
} from "../../../core/brain/lessons-promotion.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { BRAIN_LOG_EVENT_KIND, type BrainLogEventKind } from "../../../core/brain/types.ts";
import { AGENT_INSTRUCTION_FILES } from "../../../core/brain/writeback-contract.ts";
import { renderPrefLink } from "../../../core/brain/wikilink.ts";
import {
  FUTURE_ANCHOR_ALLOWANCE_MS,
  RULES_BLOCK_ERROR_KIND,
  RULES_BLOCK_ID,
  RulesBlockError,
  readRulesBlock,
  removeRulesBlock,
  writeRulesBlock,
} from "../../../core/install/rules-block.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  parse,
  readSingleLine,
  renderUnifiedDiff,
  resolveBrainAgent,
  usageError,
  writeJson,
} from "../helpers.ts";

/**
 * Every code this verb family returns, named once so the docblock, the
 * returns and the tests read one table. `consentRefused` is 6, the
 * install ladder's reserved verdict (`INSTALL_EXIT.consentRefused`), so
 * every consent-bearing surface in the tool answers with the same number.
 */
export const LESSONS_EXIT = Object.freeze({
  ok: 0,
  runtimeError: 1,
  usage: 2,
  consentRefused: 6,
} as const);

/**
 * Clock slack between the ledger's promotion stamp and a file mtime,
 * mirroring the rules-block writer's own slack: a write landing within a
 * second of its record must not read as a later hand edit. The writer
 * enforces this on its write path; the same slack guards the removal
 * path here, where the writer deliberately carries no divergence gate.
 */
const REMOVAL_MTIME_SLACK_MS = 1000;

/** One planned change to one managed rules file, before consent. */
interface RefreshAction {
  readonly target: string;
  readonly kind: "write" | "remove";
  /** The canonical body, for `write` actions. */
  readonly body: string;
  /** The ownership stamp the writer's hand-edit gate compares against. */
  readonly installedAtMs: number | null;
}

/** A target that carries no block refresh may touch, reported by name. */
interface RefreshSkip {
  readonly target: string;
  readonly reason: string;
}

export async function cmdBrainLessons(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "candidates":
      return lessonsCandidates(rest);
    case "approve":
      return await lessonsApprove(rest);
    case "deny":
      return await lessonsDeny(rest);
    case "refresh-blocks":
      return await lessonsRefreshBlocks(rest);
    default:
      return usageError(
        "brain lessons requires a subcommand: candidates | approve <pref-id> | deny <pref-id> | " +
          "refresh-blocks",
      );
  }
}

// ----- Shared helpers ---------------------------------------------------------

/** The qualification split plus the vault inputs it derived from. */
interface Qualification {
  readonly inputs: ReturnType<typeof gatherLessonsPromotionInputs>;
  readonly promotable: ReadonlyArray<LessonPromotionCandidate>;
  readonly blocked: ReadonlyArray<{ readonly prefId: string; readonly reason: string }>;
}

/** Gather the vault inputs and split qualification against `approvals`. */
function qualify(
  vault: string,
  configPath: string,
  approvals: ReadonlyArray<LessonApprovalRow>,
): Qualification {
  const inputs = gatherLessonsPromotionInputs(vault, { configPath });
  const { promotable, blocked } = lessonPromotionCandidates(
    inputs.preferences,
    inputs.lessons,
    approvals,
    { enabledScopes: inputs.scopes.scopes },
  );
  return { inputs, promotable, blocked };
}

/**
 * The agent rules files a promotion may touch, in the fixed
 * `AGENT_INSTRUCTION_FILES` order. An explicit `--target` must name one
 * of them - an arbitrary path would put a rules-file write outside the
 * audited file set. The default is the files that exist at the vault
 * root (discovery by existence, never glob), so a plain `approve` plans
 * against the files the operator actually has.
 */
function resolveTargets(
  vault: string,
  explicit: ReadonlyArray<string>,
): { readonly targets: ReadonlyArray<string> } | { readonly error: string } {
  for (const name of explicit) {
    if (!(AGENT_INSTRUCTION_FILES as ReadonlyArray<string>).includes(name)) {
      return {
        error: `--target must be one of ${AGENT_INSTRUCTION_FILES.join(", ")}, got ${name}`,
      };
    }
  }
  if (explicit.length > 0) return { targets: explicit };
  return { targets: AGENT_INSTRUCTION_FILES.filter((name) => existsSync(join(vault, name))) };
}

/**
 * The qualified lessons whose approval covers `file`: promotion honours
 * the per-file targets an approval named, so a lesson approved for one
 * rules file never rides into another.
 */
function qualifiedForFile(
  promotable: ReadonlyArray<LessonPromotionCandidate>,
  approvals: ReadonlyArray<LessonApprovalRow>,
  file: string,
): ReadonlyArray<LessonPromotionCandidate> {
  return promotable.filter((candidate) => {
    const row = currentApprovalFor(approvals, candidate.prefId);
    return row !== null && row.decision === "approved" && row.targets.includes(file);
  });
}

/** Canonical block body for one target file, or null when nothing qualifies. */
function canonicalBodyFor(
  promotable: ReadonlyArray<LessonPromotionCandidate>,
  approvals: ReadonlyArray<LessonApprovalRow>,
  file: string,
  vault: string,
): string | null {
  const qualified = qualifiedForFile(promotable, approvals, file);
  if (qualified.length === 0) return null;
  return renderLessonsBlockBody(qualified, { limit: lessonsBlockLimit(vault) });
}

/** The consent verdict this invocation will record, in the shared vocabulary. */
function consentVerdict(yes: boolean): LessonApprovalRow["decidedBy"] {
  return yes ? "yes-flag" : "interactive-yes";
}

/**
 * The install ladder's headless gate: an `--apply` without `--yes` on a
 * `--json` or non-TTY run refuses before anything is written, with the
 * reserved `headless-refused` verdict on the stream a headless consumer
 * parses (stdout under `--json`, stderr otherwise) and exit 6.
 */
function refuseHeadless(json: boolean, context: string): number {
  const refusal =
    `this command requires --yes in non-interactive mode (--json or non-TTY stdin); ` +
    `nothing was written (${context})`;
  if (json) {
    writeJson({ consent: "headless-refused", written: false, error: refusal });
  } else {
    process.stderr.write(`error: ${refusal}\n`);
  }
  return LESSONS_EXIT.consentRefused;
}

/**
 * One rules-block writer refusal, named by kind so failures stay legible
 * ("user-modified-block: ..."). Duck-typed on the `kind` property rather
 * than only `instanceof`, so the name survives even when the error object
 * crossed a module-registry boundary.
 */
function rulesBlockErrorLine(err: unknown): string {
  if (err instanceof RulesBlockError) return `${err.kind}: ${err.message}`;
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { kind?: unknown }).kind === "string" &&
    err instanceof Error
  ) {
    return `${(err as unknown as { kind: string }).kind}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The latest promotion stamp among the approval rows covering `file`, as
 * epoch ms - the ownership record the writer's hand-edit gate compares
 * the file mtime against. No stamped row returns null, which makes the
 * writer refuse to overwrite a diverged block nobody recorded. A stamp
 * further than the shared clock-skew allowance into the future is
 * ignored as if unparsable: the ledger is agent-writable state, and a
 * future-stamped record would make every operator hand-edit read as a
 * canonical move under an untouched file - the fail-closed direction is
 * "no trustworthy record".
 */
function installedAtMsFor(
  approvals: ReadonlyArray<LessonApprovalRow>,
  file: string,
): number | null {
  let latest: number | null = null;
  for (const row of approvals) {
    if (row.decision !== "approved" || !row.targets.includes(file)) continue;
    if (row.lastPromotedAt === null) continue;
    const ms = Date.parse(row.lastPromotedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > Date.now() + FUTURE_ANCHOR_ALLOWANCE_MS) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Whether a managed file looks hand-edited since its last recorded
 * promotion, with the same slack the writer grants its own writes. A
 * null stamp means no recorded promotion, so the block cannot be proven
 * ours and counts as touched - the fail-closed direction.
 */
function touchedSincePromotion(installedAtMs: number | null, file: string): boolean {
  if (installedAtMs === null) return true;
  try {
    const mtimeMs = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (mtimeMs === undefined) return true;
    return mtimeMs > installedAtMs + REMOVAL_MTIME_SLACK_MS;
  } catch {
    return true;
  }
}

/** Append a lessons log event; a failed append warns, it never fails the verb. */
function appendLessonsEvent(
  vault: string,
  eventType: BrainLogEventKind,
  body: Record<string, string>,
): void {
  try {
    appendLogEvent(vault, { timestamp: isoSecond(new Date()), eventType, body });
  } catch (err) {
    process.stderr.write(`warning: append ${eventType} log failed: ${(err as Error).message}\n`);
  }
}

/** The per-target block diff lines an approve plan (or prompt) shows. */
function approvePlanLines(
  vault: string,
  prefId: string,
  promotable: ReadonlyArray<LessonPromotionCandidate>,
  approvals: ReadonlyArray<LessonApprovalRow>,
  targets: ReadonlyArray<string>,
): string[] {
  const lines: string[] = [
    `approve plan for ${prefId} (nothing written until --apply):`,
    `  targets: ${targets.join(", ")}`,
  ];
  for (const target of targets) {
    const file = join(vault, target);
    const body = canonicalBodyFor(promotable, approvals, target, vault);
    const current = readRulesBlock(file, RULES_BLOCK_ID.lessons);
    if (body === null) {
      lines.push(`  ${target}: no qualified lesson covers this file (no change)`);
      continue;
    }
    if (current === null) {
      lines.push(`  ${target}: creates the managed lessons block:`);
      lines.push(indentDiff(renderUnifiedDiff("", body, `${target} lessons block`)));
      continue;
    }
    if (current.replace(/\s+$/, "") === body.replace(/\s+$/, "")) {
      lines.push(`  ${target}: block already current (no change)`);
      continue;
    }
    lines.push(`  ${target}: updates the managed lessons block:`);
    lines.push(indentDiff(renderUnifiedDiff(current, body, `${target} lessons block`)));
  }
  return lines;
}

/** Indent a unified diff one level, so plan output nests under its file line. */
function indentDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** The provisional row a qualification simulation runs against. */
function provisionalRow(
  prefId: string,
  targets: ReadonlyArray<string>,
  liveHash: string,
): LessonApprovalRow {
  return {
    prefId,
    decision: "approved",
    decidedAt: isoSecond(new Date()),
    decidedBy: "yes-flag",
    approvedContentHash: liveHash,
    targets,
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  };
}

/** One rules-file write through the K1 writer, with the ownership stamp. */
function writeBlock(
  file: string,
  body: string,
  opts: {
    readonly dryRun: boolean;
    readonly force: boolean;
    readonly installedAtMs: number | null;
  },
): { readonly changed: boolean } {
  const result = writeRulesBlock(file, RULES_BLOCK_ID.lessons, body, {
    dryRun: opts.dryRun,
    force: opts.force,
    ...(opts.installedAtMs !== null ? { installedAtMs: opts.installedAtMs } : {}),
  });
  return { changed: result.changed };
}

// ----- candidates -------------------------------------------------------------

function lessonsCandidates(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const json = flags["json"] === true;
  const ledger = readLessonApprovals(vault);
  const { inputs, promotable, blocked } = qualify(vault, config, ledger);
  if (json) {
    okJson({
      command: "brain lessons candidates",
      promotable: promotable.map((candidate) => ({
        prefId: candidate.prefId,
        principle: candidate.principle,
        scope: candidate.scope,
        tier: candidate.tier,
        confidence: candidate.confidence,
      })),
      blocked: blocked.map((entry) => ({ prefId: entry.prefId, reason: entry.reason })),
      scopes: { count: inputs.scopes.count, origin: inputs.scopes.origin },
    });
  } else {
    const lines = [
      `promotion scopes: ${inputs.scopes.count === 0 ? "(none - promotion disabled)" : inputs.scopes.scopes.join(", ")}` +
        ` (origin: ${inputs.scopes.origin})`,
      `promotable: ${promotable.length}; blocked: ${blocked.length}`,
    ];
    for (const candidate of promotable) {
      lines.push(
        `  promotable  ${candidate.prefId} (scope: ${candidate.scope}, tier: ${candidate.tier}, ` +
          `confidence: ${candidate.confidence})`,
      );
    }
    for (const entry of blocked) {
      lines.push(`  blocked     ${entry.prefId} (${entry.reason})`);
    }
    ok(lines.join("\n"));
  }
  return LESSONS_EXIT.ok;
}

// ----- approve ----------------------------------------------------------------

async function lessonsApprove(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    target: { type: "string-array" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const apply = flags["apply"] === true;
  const yes = flags["yes"] === true;
  const force = flags["force"] === true;
  const json = flags["json"] === true;
  const rawId = positional[0]?.trim() ?? "";
  if (rawId === "") {
    return usageError("brain lessons approve requires a preference id: approve <pref-id>");
  }
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);
  const prefId = rawId.startsWith("pref-") ? rawId : `pref-${rawId}`;

  const targets = resolveTargets(vault, (flags["target"] as ReadonlyArray<string>) ?? []);
  if ("error" in targets) return usageError(targets.error);

  const ledger = readLessonApprovals(vault);
  const previous = currentApprovalFor(ledger, prefId);
  const inputs = gatherLessonsPromotionInputs(vault, { configPath: config });
  const pref = inputs.preferences.find((entry) => entry.id === prefId);
  if (pref === undefined) {
    process.stderr.write(
      `error: no readable preference named ${prefId} under ${join(vault, "Brain", "preferences")}\n`,
    );
    return LESSONS_EXIT.usage;
  }
  if (targets.targets.length === 0) {
    return fail(
      `no agent rules file found at the vault root (${AGENT_INSTRUCTION_FILES.join(", ")}); ` +
        "pass --target to name one",
    );
  }
  const liveHash = computeContentHash(pref.principle, pref.scope);

  // The decision is simulated first - a provisional approved row pinning
  // the live hash replaces any prior row (the state table's latest
  // decision wins, so a re-approve lifts a denial) - so the verb names
  // the gate that still refuses BEFORE any ledger row or log event is
  // recorded. An approval never rescues an unqualified lesson.
  const simulated = [
    ...ledger.filter((row) => row.prefId !== prefId),
    provisionalRow(prefId, targets.targets, liveHash),
  ];
  const sim = lessonPromotionCandidates(inputs.preferences, inputs.lessons, simulated, {
    enabledScopes: inputs.scopes.scopes,
  });
  const verdict = sim.blocked.find((entry) => entry.prefId === prefId);
  if (verdict !== undefined) {
    return fail(
      `${prefId} is not promotable: ${verdict.reason} - approve records an approval only for a ` +
        "lesson that qualifies now (confirmed, high confidence, preferred tier, enabled scope)",
    );
  }

  // The plan render is a refusal surface too (a target with malformed
  // markers, or a lesson whose scope cannot render as one block line):
  // it refuses BEFORE consent, never with a crash past it.
  let planLines: string[];
  try {
    planLines = approvePlanLines(vault, prefId, sim.promotable, simulated, targets.targets);
  } catch (err) {
    return fail(rulesBlockErrorLine(err));
  }
  if (!apply) {
    if (json) {
      writeJson({
        command: "brain lessons approve",
        prefId,
        apply: false,
        targets: targets.targets,
        plan: planLines,
      });
    } else {
      ok(planLines.join("\n"));
    }
    return LESSONS_EXIT.ok;
  }

  // Consent above the write lane, the install ladder verbatim.
  if (!yes) {
    if (json || !process.stdin.isTTY) {
      return refuseHeadless(json, `approving ${prefId} into agent rules files`);
    }
    process.stderr.write(planLines.join("\n") + "\n");
    process.stderr.write("Proceed? [y/N] ");
    const ans = await readSingleLine();
    if (ans.trim().toLowerCase() !== "y" && ans.trim().toLowerCase() !== "yes") {
      ok("approval cancelled; nothing was written");
      return LESSONS_EXIT.ok;
    }
  }

  // The dry pre-pass, the same pure-plan discipline the installer and
  // refresh-blocks hold: the plan for EVERY affected target is computed
  // and every writer refusal is fired BEFORE any write lands. A refusal
  // on any target refuses the whole verb, so a multi-target approve can
  // never leave an earlier target written, approved-shaped, and managed
  // by nothing (the ledger row lands only after every write succeeds).
  const prePassRefusals: string[] = [];
  for (const target of targets.targets) {
    let body: string | null;
    try {
      body = canonicalBodyFor(sim.promotable, simulated, target, vault);
    } catch (err) {
      prePassRefusals.push(`${target}: ${rulesBlockErrorLine(err)}`);
      continue;
    }
    if (body === null) continue; // unreachable: the approved lesson qualifies
    try {
      writeBlock(join(vault, target), body, {
        dryRun: true,
        force,
        installedAtMs: installedAtMsFor(ledger, target),
      });
    } catch (err) {
      prePassRefusals.push(`${target}: ${rulesBlockErrorLine(err)}`);
    }
  }
  if (prePassRefusals.length > 0) {
    return fail(
      `approve refused before any write:\n` +
        prePassRefusals.map((line) => `  ${line}`).join("\n") +
        "\nnothing was written and no approval was recorded",
    );
  }

  const written: string[] = [];
  try {
    for (const target of targets.targets) {
      const body = canonicalBodyFor(sim.promotable, simulated, target, vault);
      if (body === null) continue; // unreachable: the approved lesson qualifies
      const result = writeBlock(join(vault, target), body, {
        dryRun: false,
        force,
        installedAtMs: installedAtMsFor(ledger, target),
      });
      if (result.changed) written.push(target);
    }
  } catch (err) {
    return fail(rulesBlockErrorLine(err));
  }

  // The row lands only after every write succeeded: a refused approve
  // lifts nothing, and a denial that was on disk stays on disk.
  const now = new Date();
  const consent = consentVerdict(yes);
  recordLessonApproval(vault, {
    prefId,
    decision: "approved",
    decidedAt: isoSecond(now),
    decidedBy: consent,
    approvedContentHash: liveHash,
    targets: targets.targets,
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: written.length > 0 ? isoSecond(now) : (previous?.lastPromotedAt ?? null),
  });
  appendLessonsEvent(vault, BRAIN_LOG_EVENT_KIND.lessonsApproved, {
    pref: renderPrefLink({ id: prefId }),
    targets: targets.targets.join(", "),
    approved_content_hash: liveHash,
    consent,
    agent,
  });
  if (written.length > 0) {
    appendLessonsEvent(vault, BRAIN_LOG_EVENT_KIND.lessonsPromoted, {
      targets: written.join(", "),
      prefs: renderPrefLink({ id: prefId }),
      agent,
    });
  }

  if (json) {
    okJson({
      command: "brain lessons approve",
      prefId,
      consent,
      recorded: true,
      written: written.length > 0,
      targets: targets.targets,
      changed: written,
    });
  } else {
    ok(
      `approved: ${prefId} (targets: ${targets.targets.join(", ")}; ` +
        `${written.length > 0 ? `wrote ${written.join(", ")}` : "block already current"})`,
    );
  }
  return LESSONS_EXIT.ok;
}

// ----- deny -------------------------------------------------------------------

async function lessonsDeny(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const apply = flags["apply"] === true;
  const yes = flags["yes"] === true;
  const json = flags["json"] === true;
  const rawId = positional[0]?.trim() ?? "";
  if (rawId === "") {
    return usageError("brain lessons deny requires a preference id: deny <pref-id>");
  }
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);
  const prefId = rawId.startsWith("pref-") ? rawId : `pref-${rawId}`;

  const inputs = gatherLessonsPromotionInputs(vault, { configPath: config });
  const pref = inputs.preferences.find((entry) => entry.id === prefId);
  if (pref === undefined) {
    process.stderr.write(
      `error: no readable preference named ${prefId} under ${join(vault, "Brain", "preferences")}\n`,
    );
    return LESSONS_EXIT.usage;
  }
  const liveHash = computeContentHash(pref.principle, pref.scope);

  if (!apply) {
    const line =
      `would record a denial for ${prefId} (no rules file is written; ` + "pass --apply to record)";
    if (json) {
      writeJson({
        command: "brain lessons deny",
        prefId,
        apply: false,
        written: false,
        plan: line,
      });
    } else {
      ok(line);
    }
    return LESSONS_EXIT.ok;
  }

  // Consent gates the ledger write: a denial is a state change the
  // operator owns, so the same ladder sits above it.
  if (!yes) {
    if (json || !process.stdin.isTTY) {
      return refuseHeadless(json, `denying ${prefId}`);
    }
    process.stderr.write(`Record the denial of ${prefId}? No rules file is written. [y/N] `);
    const ans = await readSingleLine();
    if (ans.trim().toLowerCase() !== "y" && ans.trim().toLowerCase() !== "yes") {
      ok("denial cancelled; nothing was recorded");
      return LESSONS_EXIT.ok;
    }
  }

  const now = new Date();
  const consent = consentVerdict(yes);
  recordLessonApproval(vault, {
    prefId,
    decision: "denied",
    decidedAt: isoSecond(now),
    decidedBy: consent,
    approvedContentHash: liveHash,
    targets: [],
    blockId: RULES_BLOCK_ID.lessons,
    lastPromotedAt: null,
  });
  appendLessonsEvent(vault, BRAIN_LOG_EVENT_KIND.lessonsDenied, {
    pref: renderPrefLink({ id: prefId }),
    consent,
    agent,
  });

  if (json) {
    okJson({ command: "brain lessons deny", prefId, consent, recorded: true, targets: [] });
  } else {
    ok(`denied: ${prefId} (recorded; a managed block drops it on the next refresh-blocks run)`);
  }
  return LESSONS_EXIT.ok;
}

// ----- refresh-blocks -----------------------------------------------------------

async function lessonsRefreshBlocks(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const apply = flags["apply"] === true;
  const yes = flags["yes"] === true;
  const force = flags["force"] === true;
  const json = flags["json"] === true;
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveBrainAgent(flags, config);

  const ledger = readLessonApprovals(vault);
  const { promotable, blocked } = qualify(vault, config, ledger);
  const stale = blocked
    .filter((entry) => entry.reason === LESSON_PROMOTION_BLOCKED.staleApproval)
    .map((entry) => entry.prefId);

  // Under management = an approved decision named the file AND the file
  // carries the lessons pair. Discovery by existence over the fixed list,
  // never glob; refresh never creates a block.
  const universe = (AGENT_INSTRUCTION_FILES as ReadonlyArray<string>).filter((name) =>
    ledger.some((row) => row.decision === "approved" && row.targets.includes(name)),
  );
  const skips: RefreshSkip[] = [];
  const errors: string[] = [];
  const actions: RefreshAction[] = [];
  for (const target of universe) {
    const file = join(vault, target);
    if (!existsSync(file)) {
      skips.push({ target, reason: "no such file at the vault root (refresh never creates it)" });
      continue;
    }
    let extracted: string | null;
    try {
      extracted = readRulesBlock(file, RULES_BLOCK_ID.lessons);
    } catch (err) {
      errors.push(`${target}: ${rulesBlockErrorLine(err)}`);
      continue;
    }
    if (extracted === null) {
      skips.push({ target, reason: "no managed lessons block (refresh never creates one)" });
      continue;
    }
    let body: string | null;
    try {
      body = canonicalBodyFor(promotable, ledger, target, vault);
    } catch (err) {
      // A canonical body that cannot render (a lesson whose scope could
      // forge a marker line) is a named per-target error, not a crash.
      errors.push(`${target}: ${rulesBlockErrorLine(err)}`);
      continue;
    }
    const installedAtMs = installedAtMsFor(ledger, target);
    if (body === null) {
      // Removal is the empty qualified set's only honest render. The
      // writer carries no divergence gate on removal, so the same
      // hand-edit slack guards it here: refuse unless --force.
      if (touchedSincePromotion(installedAtMs, file) && !force) {
        errors.push(
          `${target}: ${RULES_BLOCK_ERROR_KIND.userModifiedBlock}: appears hand-edited since the ` +
            "last promotion; refusing to remove the block. Re-run with --force to remove it anyway",
        );
        continue;
      }
      actions.push({ target, kind: "remove", body: "", installedAtMs });
      continue;
    }
    actions.push({ target, kind: "write", body, installedAtMs });
  }
  if (errors.length > 0) {
    process.stderr.write(errors.map((line) => `error: ${line}`).join("\n") + "\n");
    return LESSONS_EXIT.runtimeError;
  }

  const staleLines = stale.map(
    (id) => `stale approval: ${id} - the approved text moved; approve again to re-pin it`,
  );

  if (actions.length === 0) {
    const lines = [
      "no lessons block under management - refresh never creates a block; approve a lesson first",
      ...skips.map((skip) => `  ${skip.target}: ${skip.reason}`),
      ...staleLines,
    ];
    if (json) {
      writeJson({
        command: "brain lessons refresh-blocks",
        apply,
        changed: [],
        removed: [],
        skips,
        stale,
      });
    } else {
      ok(lines.join("\n"));
    }
    return LESSONS_EXIT.ok;
  }

  // Dry pass first: it computes (and refuses) exactly like the real pass,
  // so the operator sees the true plan and a refusal lands before any
  // consent is asked. A writer refusal here is the verdict for the whole
  // run - named by kind on stderr, nothing written, exit 1.
  let dry: RefreshPassResult;
  try {
    dry = runRefreshPass(vault, actions, { dryRun: true, force });
  } catch (err) {
    process.stderr.write(`error: ${rulesBlockErrorLine(err)}\n`);
    return LESSONS_EXIT.runtimeError;
  }
  const planLines = [
    `refresh plan for ${actions.length} managed block(s)${apply ? "" : " (dry run; pass --apply to write)"}:`,
    ...dry.changed.map((target) => `  ${target}: would write the managed lessons block`),
    ...dry.unchanged.map((target) => `  ${target}: block already current (no change)`),
    ...dry.removed.map(
      (target) => `  ${target}: would remove the block (no qualified lessons remain)`,
    ),
    ...skips.map((skip) => `  ${skip.target}: ${skip.reason}`),
    ...staleLines,
  ];

  if (!apply) {
    if (json) {
      writeJson({
        command: "brain lessons refresh-blocks",
        apply: false,
        wouldChange: dry.changed,
        wouldRemove: dry.removed,
        skips,
        stale,
      });
    } else {
      ok(planLines.join("\n"));
    }
    return LESSONS_EXIT.ok;
  }

  // Consent above the write lane, the install ladder verbatim.
  if (!yes) {
    if (json || !process.stdin.isTTY) {
      return refuseHeadless(json, "refreshing the managed lessons blocks");
    }
    process.stderr.write(planLines.join("\n") + "\n");
    process.stderr.write("Proceed? [y/N] ");
    const ans = await readSingleLine();
    if (ans.trim().toLowerCase() !== "y" && ans.trim().toLowerCase() !== "yes") {
      ok("refresh cancelled; nothing was written");
      return LESSONS_EXIT.ok;
    }
  }

  let real: RefreshPassResult;
  try {
    real = runRefreshPass(vault, actions, { dryRun: false, force });
  } catch (err) {
    process.stderr.write(`error: ${rulesBlockErrorLine(err)}\n`);
    return LESSONS_EXIT.runtimeError;
  }

  // Stamp the rows whose content a write actually delivered, then append
  // the promotion event. A removal stamps nothing: dropping a lesson is
  // derived-state maintenance, not a delivery.
  const now = new Date();
  const stamped = new Set<string>();
  for (const target of real.changed) {
    for (const candidate of qualifiedForFile(promotable, ledger, target)) {
      stamped.add(candidate.prefId);
    }
  }
  for (const prefId of stamped) {
    markLessonPromoted(vault, prefId, now);
  }
  if (real.changed.length > 0) {
    appendLessonsEvent(vault, BRAIN_LOG_EVENT_KIND.lessonsPromoted, {
      targets: real.changed.join(", "),
      prefs: [...stamped].map((id) => renderPrefLink({ id })).join("\n"),
      agent,
    });
  }

  if (json) {
    okJson({
      command: "brain lessons refresh-blocks",
      consent: consentVerdict(yes),
      changed: real.changed,
      removed: real.removed,
      current: real.unchanged,
      skips,
      stale,
      stamped: [...stamped],
    });
  } else {
    const lines = [
      ...real.changed.map((target) => `wrote: ${target}`),
      ...real.removed.map((target) => `removed the lessons block from: ${target}`),
      ...real.unchanged.map((target) => `already current: ${target}`),
      ...skips.map((skip) => `skipped: ${skip.target} (${skip.reason})`),
      ...staleLines,
      ...(stamped.size > 0 ? [`stamped lastPromotedAt: ${[...stamped].join(", ")}`] : []),
    ];
    ok(lines.join("\n"));
  }
  return LESSONS_EXIT.ok;
}

/** The outcome of one refresh pass, targets grouped by what happened. */
interface RefreshPassResult {
  readonly changed: string[];
  readonly unchanged: string[];
  readonly removed: string[];
}

/** One pass over the planned actions, dry or real; refusals propagate. */
function runRefreshPass(
  vault: string,
  actions: ReadonlyArray<RefreshAction>,
  opts: { readonly dryRun: boolean; readonly force: boolean },
): RefreshPassResult {
  const changed: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  for (const action of actions) {
    const file = join(vault, action.target);
    if (action.kind === "write") {
      const result = writeBlock(file, action.body, {
        dryRun: opts.dryRun,
        force: opts.force,
        installedAtMs: action.installedAtMs,
      });
      if (result.changed) changed.push(action.target);
      else unchanged.push(action.target);
    } else {
      const result = removeRulesBlock(file, RULES_BLOCK_ID.lessons, { dryRun: opts.dryRun });
      if (result.removed) removed.push(action.target);
      else unchanged.push(action.target);
    }
  }
  return { changed, unchanged, removed };
}
