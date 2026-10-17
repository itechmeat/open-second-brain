import { join } from "node:path";

import { resolveSearchConfig } from "../../../core/search/index.ts";
import { runDoctor } from "../../../core/brain/doctor.ts";
import {
  reportSweptFailure,
  SWEEP_ORIGIN,
  type SweptPath,
} from "../../../core/brain/doctor/unreadable-path.ts";
import { BRAIN_ARCHIVES_REL } from "../../../core/brain/path-constants.ts";
import {
  auditArchiveStamps,
  type ArchiveStampAudit,
} from "../../../core/brain/hygiene/detectors/capture-scope.ts";
import {
  sourceArchiveStats,
  type ArchiveStats,
} from "../../../core/brain/provenance/source-archive.ts";
import { annotateEntityAliasIssues } from "../../../core/brain/doctor/entity-alias-verdicts.ts";
import { verdictFields, verdictLine } from "../../../core/decision-model/pair-verdict.ts";
import {
  applyRepair,
  type RepairConsent,
  type RepairOutcome,
} from "../../../core/brain/diagnostics.ts";
import {
  applyRemediation,
  collectDriftedSlugs,
  collectWidePermissions,
  planRemediation,
} from "../../../core/brain/health/remediation.ts";
import { loadBrainConfigDetailed, resolveHealth } from "../../../core/brain/policy.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { NO_EXIT_KEY, noExitReasons } from "../../../core/brain/doctor-exits.ts";
import type { DoctorIssue } from "../../../core/brain/types.ts";
import { advisoryIsLegal, emitNextSteps, type AdvisoryStream } from "../../advisory-rail.ts";
import {
  brainVerbContext,
  fail,
  info,
  ok,
  parse,
  readSingleLine,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

/**
 * One reported issue, machine-readable: the record the doctor produced
 * plus the structural next command when its code is registered.
 *
 * The key is spread LAST so the pre-existing field order is untouched
 * and an unregistered code produces byte-identical JSON. The builder is
 * shared with the `brain_doctor` MCP tool through `nextCommandField`, so
 * the two surfaces cannot disagree on the spelling or on which codes
 * resolve.
 */
function withNextCommand<T extends Pick<DoctorIssue, "code">>(issue: T): Record<string, unknown> {
  return { ...issue, ...nextCommandField(issue.code) };
}

/**
 * One reported issue, human-readable. `label` carries its own trailing
 * padding because the three streams have never been column-aligned and
 * this task does not change a byte of what they print; the renderer
 * exists so the three call sites stop repeating the same template.
 */
function renderIssueLine(
  label: string,
  issue: Pick<DoctorIssue, "code" | "message"> & { readonly path?: string },
): string {
  return `${label} ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}\n`;
}

/**
 * The other half of the rail's answer: why a reported code named no
 * command.
 *
 * `emitNextSteps` prints one line per exit and nothing for a code with
 * none, which left two different situations looking identical - a class
 * no single command resolves, and a class nobody has registered yet.
 * `doctor-exits.ts` publishes the first as a written reason, and this
 * prints it once per code, after the exits.
 *
 * It follows the rail's own stream discipline rather than deciding for
 * itself: on a machine stream the reasons ride in the payload instead.
 * The limit, stated: only codes the table publishes produce a line, so a
 * code forwarded into `uncertain` from another module's vocabulary stays
 * as quiet as it was - those are classified in `applier-capability.ts`.
 */
function explainMissingExits(codes: Iterable<string>, stream: AdvisoryStream): void {
  if (!advisoryIsLegal(stream)) return;
  for (const [code, reason] of noExitReasons(codes)) info(`no exit: ${code} - ${reason}`);
}

/**
 * One archive section: the counts, or the named unavailability when the
 * store itself could not be read.
 */
type ArchiveSection = (ArchiveStats & ArchiveStampAudit) | { readonly unavailable: true };

/**
 * The informational archive section (answer trust): counts only - how many
 * entries the durable source archive holds, their combined size, how many
 * stamped pages lost their entry or disagree with it, and how many entries
 * no page cites anymore. No fix verb: an archive is evidence, so pruning
 * and recapture are operator calls, and the named findings live on the
 * hygiene scan. Count-only also keeps this section from becoming a second
 * finding surface the scans would have to agree with.
 *
 * Fail-soft: the section runs AFTER the fail-soft check pass, and an
 * unreadable `Brain/.archives` used to throw past it - in `--json` mode
 * printing nothing at all. An informational section's failure is
 * uncertainty, not a failed run: the read is wrapped, the skip is named in
 * the pass's `uncertain` stream exactly as the doctor's own sweeps name
 * one, and the JSON answers `archives: { unavailable: true }`.
 */
function archiveSection(vault: string, swept: SweptPath): ArchiveSection {
  try {
    return { ...sourceArchiveStats(vault), ...auditArchiveStamps(vault) };
  } catch (err) {
    reportSweptFailure(
      join(vault, BRAIN_ARCHIVES_REL),
      "directory listing failed",
      err,
      swept,
      SWEEP_ORIGIN.root,
    );
    return { unavailable: true };
  }
}

export async function cmdBrainDoctor(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    strict: { type: "boolean" },
    json: { type: "boolean" },
    remediate: { type: "boolean" },
    repair: { type: "boolean" },
    apply: { type: "boolean" },
    // t_b6bcd984: explicit consent for `--repair --apply` in a
    // non-interactive run (the canonical upgrade ladder).
    yes: { type: "boolean" },
    agent: { type: "string" },
    "dry-run": { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);

  // `--apply` is a modifier of `--repair`; on its own it would silently
  // fall through to a read-only doctor run, so reject it up front.
  if (flags["apply"] && !flags["repair"]) {
    return usageError("--apply requires --repair");
  }

  // Guarded repair mode (O2). Opt-in and dry-run by default; `--apply`
  // performs the fixes. `--strict` stays read-only, so it can never be
  // combined with an applying repair. Plain / `--strict` doctor below is
  // untouched and byte-identical when `--repair` is absent.
  if (flags["repair"]) {
    if (flags["strict"] && flags["apply"]) {
      return usageError("cannot combine --strict (read-only) with --repair --apply");
    }
    const dryRun = !flags["apply"];
    // t_b6bcd984: fail-closed consent above the write, the canonical
    // `brain upgrade --apply` ladder. Without --yes, a --json or
    // non-TTY apply refuses before writing and logs no event; a TTY
    // run sees the dry-run preview (now with the per-file diffs) and is
    // asked once. A dry run never prompts and never gates.
    //
    // M6: the preview, the prompt and the apply all sit inside the try -
    // a preview-side failure (an unclassified repair code, a fixer that
    // cannot derive its target) is a `repair failed:` answer, not an
    // uncaught error. The apply is pinned to the approved preview: only
    // the targets the preview showed may be written, so a finding that
    // appears while the prompt waits stays for the next run instead of
    // being written behind an approval it was never shown in.
    try {
      let consent: RepairConsent | undefined;
      let approvedTargets: ReadonlyArray<string> | undefined;
      if (!dryRun) {
        if (flags["yes"]) {
          consent = "yes-flag";
        } else if (flags["json"] || !process.stdin.isTTY) {
          // M4: the refusal carries its verdict in a JSON envelope under
          // --json, on the payload stream a headless consumer parses -
          // the reserved `headless-refused` verdict, nothing written.
          if (flags["json"]) {
            process.stdout.write(
              JSON.stringify(
                {
                  consent: "headless-refused",
                  written: false,
                  error:
                    "brain doctor --repair --apply requires --yes in non-interactive mode " +
                    "(--json or non-TTY stdin); nothing was written",
                },
                null,
                2,
              ) + "\n",
            );
            return 1;
          }
          return fail(
            "brain doctor --repair --apply requires --yes in non-interactive mode " +
              "(--json or non-TTY stdin); nothing was written",
          );
        } else {
          const preview = applyRepair(vault, {
            dryRun: true,
            agent: resolveBrainAgent(flags, config),
            configPath: config,
            dbPath: resolveSearchConfig({ vault, configPath: config ?? undefined }).dbPath,
          });
          // M6: nothing to fix, nothing to approve - a prompt over an
          // empty preview asks consent for a no-op. Skip straight to the
          // apply, which reports the needs-review and unfixable classes
          // honestly and records `unchanged` as the verdict.
          if (preview.applied.length === 0) {
            consent = "unchanged";
          } else {
            renderRepair(preview, false);
            process.stderr.write("Proceed? [y/N] ");
            const ans = await readSingleLine();
            if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
              ok("repair cancelled");
              return 0;
            }
            consent = "interactive-yes";
            approvedTargets = preview.applied.map((f) => f.target);
          }
        }
      }
      const outcome = applyRepair(vault, {
        dryRun,
        agent: resolveBrainAgent(flags, config),
        configPath: config,
        dbPath: resolveSearchConfig({ vault, configPath: config ?? undefined }).dbPath,
        ...(consent === undefined ? {} : { consent }),
        ...(approvedTargets === undefined ? {} : { approvedTargets }),
      });
      return renderRepair(outcome, Boolean(flags["json"]));
    } catch (exc) {
      return fail(`repair failed: ${(exc as Error).message ?? exc}`);
    }
  }

  let result;
  try {
    result = runDoctor(vault, {
      strict: Boolean(flags["strict"]),
      dbPath: resolveSearchConfig({ vault, configPath: config ?? undefined }).dbPath,
      // Checks that read a config gate (the recall-channel coverage check reads
      // whether prompt-side recall injection is enabled) must read the SAME
      // config this invocation was pointed at. Letting them fall through to
      // default discovery would make `--config other.yaml` diagnose one file
      // and report on another.
      ...(config !== null ? { configPath: config } : {}),
    });
  } catch (exc) {
    return fail(`doctor failed: ${(exc as Error).message ?? exc}`);
  }

  // Where an advisory line may legally go. `brain` renders its own JSON,
  // so under `--json` the rail suppresses every line and the pointer
  // travels as a payload field instead. The verb never decides this for
  // itself - see `advisory-rail.ts`.
  const stream: AdvisoryStream = {
    command: "brain",
    argv,
    jsonRequested: Boolean(flags["json"]),
  };

  if (flags["remediate"]) {
    // Never auto-repair a vault that has structural errors - those need
    // an operator, and remediation assumes a parseable tree.
    if (result.errors.length > 0) {
      for (const e of result.errors) process.stdout.write(renderIssueLine("[ERROR]", e));
      const errorCodes = result.errors.map((e) => e.code);
      emitNextSteps(errorCodes, stream);
      explainMissingExits(errorCodes, stream);
      return fail("doctor found errors; remediation aborted");
    }
    try {
      return runRemediate(vault, Boolean(flags["dry-run"]), Boolean(flags["json"]), result);
    } catch (exc) {
      return fail(`remediation failed: ${(exc as Error).message ?? exc}`);
    }
  }

  // Unit F. `uncertain` is a third stream beside warnings and errors:
  // sub-operations the doctor attempted but cannot claim completed
  // cleanly. It is emitted ONLY when non-empty, so a clean vault's
  // output - JSON and human alike - is byte-identical to before, and it
  // deliberately does not feed the exit code: uncertainty is not a
  // failure, and folding it into `--strict` would turn an unreadable
  // field into a broken build.
  // A mutable copy of the pass's stream: the archive section below appends
  // its own skip to it, and `runDoctor` returned the array frozen.
  const uncertain = [...(result.uncertain ?? [])];
  // The sweep identity the archive section reports its skips under - the
  // consequence names the question an unreadable store leaves open.
  const swept: SweptPath = {
    site: "brain.doctor.archiveSection",
    consequence: "the archive counts could not be taken",
    uncertain,
  };
  // The archive section is taken ONCE, before anything is rendered or
  // derived from the streams: an unreadable store names its skip in the
  // stream above, so the failure feeds the exit census and is visible in
  // the same pass instead of one key (or one line) late.
  const section = archiveSection(vault, swept);

  // Every code the three streams reported, in the order an operator reads
  // them. Feeds both the rail and the explanation of what the rail could
  // not name, so the two can never disagree about which codes have an exit.
  const reportedCodes = [...result.errors, ...result.warnings, ...uncertain].map(
    (issue) => issue.code,
  );
  // Published reasons for the reported codes that resolve to no command.
  // Empty - hence the key absent, hence byte-identical output - whenever
  // every reported code has an exit, and on a clean vault.
  const noExit = noExitReasons(reportedCodes);

  // Optional decision-model verdicts on alias-merge candidates (use
  // `dedup`); null while off, and both renderings below are unchanged.
  const aliasVerdicts = await annotateEntityAliasIssues(vault, result.warnings, {
    configPath: config,
  });
  const warnings = aliasVerdicts === null ? result.warnings : aliasVerdicts.map((a) => a.item);
  const warningExtra = new Map<DoctorIssue, ReturnType<typeof verdictFields>>();
  const warningLine = new Map<DoctorIssue, string>();
  for (const a of aliasVerdicts ?? []) {
    if (a.verdict === null) continue;
    warningExtra.set(a.item, verdictFields(a));
    warningLine.set(a.item, verdictLine(a));
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          warnings: warnings.map((w) => ({ ...withNextCommand(w), ...warningExtra.get(w) })),
          errors: result.errors.map(withNextCommand),
          ...(uncertain.length > 0 ? { uncertain: uncertain.map(withNextCommand) } : {}),
          // Beside the streams, once per code, rather than repeated on
          // every issue record: a reason is about a CLASS, unlike a next
          // command, and two hundred malformed timestamps share one.
          ...(noExit.size > 0 ? { [NO_EXIT_KEY]: Object.fromEntries(noExit) } : {}),
          // Count-only informational archive section (answer trust): the
          // key is always present, so a caller never infers the section's
          // existence from a missing key - and when the store could not be
          // read, the key names the unavailability instead of a count.
          archives: section,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const e of result.errors) process.stdout.write(renderIssueLine("[ERROR]", e));
    for (const w of warnings) {
      process.stdout.write(renderIssueLine("[WARN] ", w));
      const line = warningLine.get(w);
      if (line !== undefined) process.stdout.write(`        ${line}\n`);
    }
    for (const u of uncertain) process.stdout.write(renderIssueLine("[UNSURE]", u));
    if (result.errors.length === 0 && result.warnings.length === 0 && uncertain.length === 0) {
      ok("brain doctor: clean");
    }
    // One line, and only when there is something to describe: a vault that
    // has never archived a source gains no line at all, and an orphaned
    // entry - evidence no page cites - is something to describe. An
    // unreadable store is already named by its `[UNSURE]` line above, so
    // it gains no counts line either.
    const archives = "unavailable" in section ? null : section;
    if (
      archives !== null &&
      (archives.entries > 0 ||
        archives.missing > 0 ||
        archives.mismatched > 0 ||
        archives.uncited > 0)
    ) {
      process.stdout.write(
        `archives: ${archives.entries} entries, ${archives.totalBytes} bytes, ` +
          `${archives.missing} missing, ${archives.mismatched} mismatched, ` +
          `${archives.uncited} uncited\n`,
      );
    }
  }

  // no-dead-ends, task 4: the exits, after the diagnosis. Errors first,
  // then warnings, then the uncertain stream - the order an operator
  // reads them in. The rail prints nothing under `--json` (the pointer
  // rode out as `next_command` above) and nothing for a code with no
  // registered signal.
  emitNextSteps(reportedCodes, stream);
  // ...and, after them, why the codes that named none have none. Without
  // this a finding with no exit and a finding whose exit nobody
  // registered read identically.
  explainMissingExits(reportedCodes, stream);

  if (result.errors.length > 0) return 1;
  if (result.warnings.length > 0 && flags["strict"]) return 2;
  return 0;
}

/**
 * `--remediate [--dry-run]`: build a dependency-ordered plan from the
 * doctor's semantic findings plus content-hash drift, then apply the
 * auto-safe steps (or preview them under `--dry-run`). Needs-review
 * steps are always listed but never applied.
 */
function runRemediate(
  vault: string,
  dryRun: boolean,
  json: boolean,
  result: ReturnType<typeof runDoctor>,
): number {
  let stepCap = 20;
  try {
    stepCap = resolveHealth(loadBrainConfigDetailed(vault).config).remediation_step_cap;
  } catch {
    /* fall back to default cap */
  }

  const sh = result.semantic_health;
  const plan = planRemediation(
    {
      driftedSlugs: collectDriftedSlugs(vault),
      widePermissions: collectWidePermissions(vault),
      contradictions: (sh?.contradictions ?? []).map((c) => ({ aId: c.aId, bId: c.bId })),
      staleClaims: (sh?.staleClaims ?? []).map((s) => ({ id: s.id })),
      conceptGaps: (sh?.conceptGaps ?? []).map((g) => ({ term: g.term })),
    },
    { stepCap },
  );
  const outcome = applyRemediation(vault, plan, { dryRun });

  if (json) {
    process.stdout.write(JSON.stringify({ plan: plan.steps, outcome }, null, 2) + "\n");
    return 0;
  }

  const verb = dryRun ? "would apply" : "applied";
  for (const s of outcome.applied) {
    process.stdout.write(`[${verb}] ${s.code}: ${s.detail}\n`);
  }
  for (const s of outcome.skipped) {
    process.stdout.write(`[skip:${s.classification}] ${s.code}: ${s.detail}\n`);
  }
  ok(
    `remediation ${dryRun ? "dry-run" : "complete"}: ` +
      `${outcome.applied.length} ${verb}, ${outcome.skipped.length} skipped`,
  );
  return 0;
}

/**
 * Render the guarded repair outcome. Dry-run lists what `--apply` would
 * do, with the unified diff of each fixable file under its line
 * (t_b6bcd984); apply lists what was done. Needs-review instances and
 * unfixable classes always print with their next-command hint (supplied
 * by the diagnostics-signal definition, never hardcoded here).
 */
function renderRepair(outcome: RepairOutcome, json: boolean): number {
  if (json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
    return 0;
  }

  const verb = outcome.dryRun ? "would fix" : "fixed";
  for (const f of outcome.applied) {
    process.stdout.write(`[${verb}] ${f.code}: ${f.detail}\n`);
    if (f.diff) {
      for (const d of f.diff.split("\n")) process.stdout.write(`  ${d}\n`);
    }
  }
  for (const r of outcome.needsReview) {
    process.stdout.write(
      `[needs-review] ${r.code}: ${r.detail}${r.reason ? ` (${r.reason})` : ""}\n`,
    );
  }
  for (const u of outcome.unfixable) {
    process.stdout.write(`[not auto-repairable] ${u.code} x${u.count}: run \`${u.nextCommand}\`\n`);
  }
  if (
    outcome.applied.length === 0 &&
    outcome.needsReview.length === 0 &&
    outcome.unfixable.length === 0
  ) {
    ok("brain doctor --repair: nothing to fix");
    return 0;
  }
  ok(
    `repair ${outcome.dryRun ? "dry-run" : "complete"}: ` +
      `${outcome.applied.length} ${verb}, ${outcome.needsReview.length} needs-review, ` +
      `${outcome.unfixable.length} not auto-repairable`,
  );
  return 0;
}
