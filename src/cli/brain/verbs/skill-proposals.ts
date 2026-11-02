import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
  resolveSkillsDir,
  resolveSkillRewriteJudgeCmd,
  resolveSkillRewriteModeConfig,
} from "../../../core/config.ts";
import {
  SkillPageDraftError,
  commitSkillPageDraft,
  planSkillPageDrafts,
} from "../../../core/brain/skill-page-drafts.ts";
import {
  acceptSkillProposal,
  discardUnreadableSkillAcceptJournals,
  learnSkillProposals,
  listPendingSkillProposals,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
  readRewriteIncumbent,
  recordSkillRewriteGrade,
  stageScoredRewriteProposal,
  DeclaredSkillProposalError,
  type RewriteIncumbent,
} from "../../../core/brain/skill-proposals.ts";
import {
  buildRewriteEnvelopes,
  buildRewriteGradeRecord,
  buildRewriteHeldoutEnvelopes,
  checkRewriteHeldout,
  runRewriteJudge,
  scoreRewriteTranscripts,
  selectRewriteCandidate,
  type RewriteTaskScore,
  type SkillRewriteMode,
} from "../../../core/brain/skill-rewrite.ts";
import {
  parseSkillRewriteSpec,
  skillRewriteSpecHash,
  verifyRewriteTake,
  SKILL_REWRITE_VERDICT,
  type SkillRewriteSpec,
} from "../../../core/brain/skill-rewrite-spec.ts";
import {
  parseSkillBenchmarkTasks,
  SKILL_BENCHMARK_TASKS_FILE,
} from "../../../core/brain/skill-rewrite-tasks.ts";
import {
  skillBenchmarkRoundsDir,
  skillBenchmarkSpecPath,
  skillBenchmarkTasksPath,
} from "../../../core/brain/paths.ts";
import { deriveSkillUsage } from "../../../core/brain/skill-usage.ts";
import { ResponseShapeError } from "../../../core/brain/response-shape.ts";
import { ResponseCheckError } from "../../../core/brain/response-checks.ts";
import {
  parsePayloadJson,
  PayloadJsonError,
  payloadStripNote,
  type PayloadStrip,
} from "../../../core/brain/payload-json.ts";
import { canonicalNotePath } from "../../../core/path-safety.ts";
import { CliError, brainVerbContext, failWith, parse } from "../helpers.ts";

export async function cmdBrainSkillProposals(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "learn") return learn(rest);
  if (sub === "list") return list(rest);
  if (sub === "accept") return accept(rest);
  if (sub === "reject") return reject(rest);
  if (sub === "recover") return recover(rest);
  if (sub === "usage") return usage(rest);
  if (sub === "page-candidates") return pageCandidates(rest);
  if (sub === "page-draft") return pageDraft(rest);
  if (sub === "rewrite-plan") return rewritePlan(rest);
  if (sub === "rewrite-score") return rewriteScore(rest);
  throw new CliError(
    "brain skill-proposals: expected learn, list, accept, reject, recover, usage, " +
      "page-candidates, page-draft, rewrite-plan, or rewrite-score",
  );
}

/**
 * Which mature vault pages deserve a skill, and the envelope for each.
 *
 * Read-only. Every page the walk turned down is listed with the reason -
 * a report that showed only the winners could not be told apart from a
 * vault nobody has tagged.
 */
function pageCandidates(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const skillsDir = resolveSkillsDir(config);
  const report = planSkillPageDrafts(vault, {
    now: new Date(),
    ...(skillsDir !== null ? { skillsDir } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          generated_at: report.generatedAt,
          pages_scanned: report.pagesScanned,
          admitted: report.admitted.map((c) => ({
            path: c.path,
            title: c.title,
            tier: c.tier,
            lifecycle: c.lifecycle,
            confidence: c.confidence,
            reuse_score: c.reuseScore,
            reuse_observations: c.reuseObservations,
            llm_step: c.llmStep,
          })),
          skipped: report.skipped.map((s) => ({
            path: s.path,
            title: s.title,
            reason: s.reason,
            detail: s.detail,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `skill-proposals page-candidates: scanned=${report.pagesScanned} ` +
      `admitted=${report.admitted.length} skipped=${report.skipped.length}\n`,
  );
  for (const c of report.admitted) {
    process.stdout.write(`  admit ${c.path}  needs-llm-step: ${c.llmStep.step}\n`);
  }
  for (const s of report.skipped) {
    process.stdout.write(`  skip  ${s.path}  ${s.reason}: ${s.detail}\n`);
  }
  return 0;
}

/**
 * Stage one returned draft as a pending proposal. Writes inside the vault
 * only - the SKILL.md is materialized by `accept`, never here.
 */
function pageDraft(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    payload: { type: "string" },
    "payload-file": { type: "string" },
  });
  const page = trim(positional[0]);
  if (!page) throw new CliError("brain skill-proposals page-draft: page path is required");
  const raw =
    typeof flags["payload"] === "string"
      ? (flags["payload"] as string)
      : typeof flags["payload-file"] === "string"
        ? readFileSync(flags["payload-file"] as string, "utf8")
        : null;
  if (raw === null) {
    throw new CliError("brain skill-proposals page-draft: --payload or --payload-file is required");
  }
  let payload: unknown;
  let strip: PayloadStrip | undefined;
  try {
    const parsed = parsePayloadJson(raw);
    payload = parsed.payload;
    strip = parsed.strip;
  } catch (error) {
    // Reported here rather than by the ingress: at this point the mistake
    // is the JSON the operator typed. A refusal after a strip attempt names
    // the attempt (t_dac8bf7e); plain garbage keeps the plain refusal.
    if (!(error instanceof PayloadJsonError)) throw error;
    throw new CliError(`brain skill-proposals page-draft: ${error.message}`);
  }
  const vault = brainVerbContext(flags).vault;
  // The commit path's refusals are operator mistakes (a blank field, a page
  // that is not there), not crashes: caught here and rethrown with the same
  // stable prefix the parse path uses, so the runner never dumps a stack
  // trace with machine-derived source paths where a refusal belongs.
  let result: ReturnType<typeof commitSkillPageDraft>;
  try {
    result = commitSkillPageDraft(vault, page, payload, { now: new Date() });
  } catch (error) {
    if (
      error instanceof SkillPageDraftError ||
      error instanceof ResponseShapeError ||
      error instanceof ResponseCheckError
    ) {
      throw new CliError(`brain skill-proposals page-draft: ${error.message}`);
    }
    throw error;
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          ...result,
          // Vault-relative, like the distill and MCP surfaces: the absolute
          // host path is the operator-supplied vault prefix composed with a
          // machine-derived subtree, and this output lands in model context.
          path: canonicalNotePath(relative(vault, result.path)),
          // Present only when a leading <think> block was stripped (t_dac8bf7e).
          ...(strip !== undefined ? { note: payloadStripNote(strip) } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `${result.outcome} ${result.id}` + ("reason" in result ? ` (${result.reason})` : "") + `\n`,
  );
  if (strip !== undefined) process.stdout.write(`${payloadStripNote(strip)}\n`);
  return 0;
}

/**
 * Resolve the accept sequences a crash abandoned.
 *
 * The accept transaction's write-ahead journal was recoverable in the
 * library and reachable from nowhere: an operator whose accept broke had
 * no command to run. This is that command.
 *
 * Both hazards it can meet refuse rather than guess, and the refusal
 * carries the message the core error composed - naming the exact file and
 * the exit - so the two surfaces cannot word it differently. `--discard-
 * unreadable` is the only destructive part and it is opt-in for the reason
 * stated on `discardUnreadableSkillAcceptJournals`: an unparseable marker
 * names no phase, so removing it unblocks accepting without claiming the
 * sequence it marked was resolved.
 */
function recover(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "discard-unreadable": { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;

  let discarded: ReadonlyArray<string>;
  let recovered: ReadonlyArray<{ slug: string; action: string }>;
  try {
    discarded = flags["discard-unreadable"] ? discardUnreadableSkillAcceptJournals(vault) : [];
    recovered = recoverSkillProposalAccepts(vault);
  } catch (exc) {
    return failWith("recover skill-proposal accepts", exc);
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ discarded, recovered, total: recovered.length }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `skill-proposals recover: ${recovered.length} sequence(s) resolved, ` +
      `${discarded.length} unreadable marker(s) discarded\n`,
  );
  for (const path of discarded) process.stdout.write(`  discarded ${path}\n`);
  for (const item of recovered) process.stdout.write(`  ${item.action} ${item.slug}\n`);
  return 0;
}

function usage(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const rows = deriveSkillUsage(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify({ total: rows.length, usage: rows }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${rows.length} skill(s) with recorded invocations:\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${row.skill}  invocations=${row.invocationCount}  from_offer=${row.offerAttributedCount}\n`,
    );
  }
  return 0;
}

function learn(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "min-support": { type: "string" },
  });
  const vault = brainVerbContext(flags).vault;
  const minSupportRaw = trim(flags["min-support"]);
  const minSupport = minSupportRaw
    ? parsePositiveInteger(minSupportRaw, "--min-support")
    : undefined;

  const result =
    minSupport !== undefined
      ? learnSkillProposals(vault, { minSupport })
      : learnSkillProposals(vault);

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `skill-proposals learn: scanned=${result.scanned} created=${result.created.length} suppressed=${result.suppressed.length}\n`,
  );
  return 0;
}

function list(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const pending = listPendingSkillProposals(vault);

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: pending.length, proposals: pending }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(`${pending.length} pending skill proposal(s):\n`);
  for (const item of pending) {
    process.stdout.write(`  ${item.id}  ${item.patternKind}  status=${item.status}\n`);
  }
  return 0;
}

function accept(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string" },
  });
  const slug = trim(positional[0]);
  if (!slug) throw new CliError("brain skill-proposals accept: slug is required");
  const { config, vault } = brainVerbContext(flags);
  const note = trim(flags["note"]);
  // Resolved HERE rather than inside the core: the surface knows which
  // config chain this invocation is running against, and a `mature_page`
  // accept materializes into whichever skills root that chain names.
  const skillsRoot = resolveSkillsDir(config);
  const result = acceptSkillProposal(vault, slug, {
    ...(note ? { note } : {}),
    ...(skillsRoot !== null ? { skillsRoot } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`accepted ${result.id}\n`);
  return 0;
}

function reject(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    note: { type: "string", required: true },
  });
  const slug = trim(positional[0]);
  if (!slug) throw new CliError("brain skill-proposals reject: slug is required");
  const note = trim(flags["note"]);
  if (!note) throw new CliError("brain skill-proposals reject: --note is required");
  const vault = brainVerbContext(flags).vault;
  const result = rejectSkillProposal(vault, slug, { note });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`rejected ${result.id}\n`);
  return 0;
}

function trim(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) throw new CliError(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) throw new CliError(`${label} must be a positive integer`);
  return parsed;
}

// ----- the rewrite gate rounds (agent-presence, Lane A) -------------------------

/** The task set + spec pair a rewrite round is gated against, once verified. */
interface VerifiedBenchmark {
  readonly spec: SkillRewriteSpec;
  readonly specHash: string;
}

/**
 * Load and verify the benchmark: parse the task set and the spec, then run
 * `verifyRewriteTake`. Every refusal names the file or the receipt reason -
 * a stale benchmark silently gating nothing is worse than a loud stop.
 */
function loadVerifiedBenchmark(vault: string, skill: string): VerifiedBenchmark {
  const tasksPath = skillBenchmarkTasksPath(vault, skill);
  if (!existsSync(tasksPath)) {
    throw new CliError(
      `brain skill-proposals rewrite: no benchmark task set for '${skill}' at ${tasksPath} ` +
        `(${SKILL_BENCHMARK_TASKS_FILE} must exist before a rewrite round can be planned)`,
    );
  }
  const specPath = skillBenchmarkSpecPath(vault, skill);
  if (!existsSync(specPath)) {
    throw new CliError(
      `brain skill-proposals rewrite: no frozen spec for '${skill}' at ${specPath} ` +
        "(run the receipt step before planning a rewrite round)",
    );
  }
  let rawTasks: unknown;
  let rawSpec: unknown;
  try {
    rawTasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    rawSpec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    throw new CliError(
      `brain skill-proposals rewrite: the benchmark files for '${skill}' are not valid JSON: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const tasks = parseSkillBenchmarkTasks(rawTasks, tasksPath);
  const spec = parseSkillRewriteSpec(rawSpec, specPath);
  const take = verifyRewriteTake(spec, tasks);
  if (!take.ok) {
    throw new CliError(
      `brain skill-proposals rewrite: refused take for '${skill}': ${take.reason ?? "receipt mismatch"}`,
    );
  }
  return { spec, specHash: skillRewriteSpecHash(spec) };
}

/**
 * The incumbent body and version, read from the skills root this
 * invocation's config names. A rewrite gates the CANDIDATE against the
 * INCUMBENT, so the incumbent's bytes are the baseline round's body and
 * its `version` is what the staged proposal bumps; a skill with no
 * incumbent is not a rewrite target and is refused by name.
 */
/**
 * The incumbent, resolved through the core's own skills-root resolution so
 * a plan or score refusal names the same file the accept would write.
 * The core refuses by name; this wrapper keeps the CLI error prefix.
 */
function loadIncumbent(
  vault: string,
  configPath: string,
  skill: string,
  override: string | undefined,
): RewriteIncumbent {
  const skillsRoot = override?.trim() || resolveSkillsDir(configPath) || undefined;
  try {
    return readRewriteIncumbent(vault, skill, skillsRoot ? { skillsRoot } : {});
  } catch (error) {
    if (error instanceof DeclaredSkillProposalError) {
      throw new CliError(`brain skill-proposals rewrite: ${error.message}`);
    }
    throw error;
  }
}

/**
 * `rewrite-plan <skill> --candidate-file <path>`: validate the task set and
 * the frozen spec, print the receipt, and hand out the dev-round envelopes
 * - one baseline round over the incumbent body, one candidate round over
 * the candidate body. Held-out members are never printed here: their
 * single check is handed out by rewrite-score, only after a promote.
 */
function rewritePlan(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "skills-root": { type: "string" },
    "candidate-file": { type: "string", required: true },
  });
  const skill = trim(positional[0]);
  if (!skill) throw new CliError("brain skill-proposals rewrite-plan: skill name is required");
  const { config, vault } = brainVerbContext(flags);
  const mode = resolveSkillRewriteModeConfig(config);
  const { spec, specHash } = loadVerifiedBenchmark(vault, skill);
  const tasks = loadTasks(vault, skill);
  const candidatePath = trim(flags["candidate-file"]);
  if (!candidatePath) {
    throw new CliError("brain skill-proposals rewrite-plan: --candidate-file is required");
  }
  const candidateBody = readCandidateBody(candidatePath);
  const incumbent = loadIncumbent(vault, config, skill, flags["skills-root"] as string | undefined);

  const baseline = buildRewriteEnvelopes(incumbent.body, spec, tasks, { round: "baseline" });
  const candidate = buildRewriteEnvelopes(candidateBody, spec, tasks, { round: "candidate" });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          skill,
          mode,
          receipt: {
            schema_version: spec.schemaVersion,
            tasks_hash: spec.tasksHash,
            seed: spec.seed,
            split_rule: spec.splitRule,
            dev_task_ids: spec.devTaskIds,
            heldout_task_ids: spec.heldoutTaskIds,
            required_margin: spec.requiredMargin,
            min_dev_tasks: spec.minDevTasks,
            spec_hash: specHash,
          },
          incumbent_version: incumbent.version,
          rounds: { baseline, candidate },
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `rewrite-plan ${skill}: mode=${mode} schema=${spec.schemaVersion} spec=${specHash} ` +
      `tasks=${spec.tasksHash} split=${spec.splitRule} seed=${spec.seed} margin=${spec.requiredMargin} ` +
      `dev=${spec.devTaskIds.length} heldout=${spec.heldoutTaskIds.length} ` +
      `incumbent_version=${incumbent.version}\n`,
  );
  for (const envelope of [...baseline, ...candidate]) {
    process.stdout.write(
      `  ${envelope.round} ${envelope["task_id"]} -> ${envelope.target_path}\n` +
        `${envelope.prompt
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}\n`,
    );
  }
  return 0;
}

function loadTasks(vault: string, skill: string): ReturnType<typeof parseSkillBenchmarkTasks> {
  return parseSkillBenchmarkTasks(
    JSON.parse(readFileSync(skillBenchmarkTasksPath(vault, skill), "utf8")),
    skillBenchmarkTasksPath(vault, skill),
  );
}

/**
 * `rewrite-score <skill> [--rounds-dir <dir>] [--candidate-file <path>]`:
 * score the submitted transcripts, run the selection gate, and either
 * hand out the single held-out round (promote, held-out not yet scored) or
 * apply the held-out gate and stage the pending proposal on a final
 * promote. A hold and a short dev arm write ONLY the grade record.
 *
 * The command is re-runnable: the transcripts stay in the rounds tree, the
 * gates are deterministic, and the second run sees the held-out arm the
 * first run asked for.
 */
function rewriteScore(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "rounds-dir": { type: "string" },
    "candidate-file": { type: "string" },
    "skills-root": { type: "string" },
  });
  const skill = trim(positional[0]);
  if (!skill) throw new CliError("brain skill-proposals rewrite-score: skill name is required");
  const { config, vault } = brainVerbContext(flags);
  const mode: SkillRewriteMode = resolveSkillRewriteModeConfig(config);
  const { spec, specHash } = loadVerifiedBenchmark(vault, skill);
  const tasks = loadTasks(vault, skill);

  const roundsDir = trim(flags["rounds-dir"]) ?? skillBenchmarkRoundsDir(vault, skill);
  const baseline = scoreArm(vault, roundsDir, "baseline", tasks, spec);
  const candidate = scoreArm(vault, roundsDir, "candidate", tasks, spec);
  const selection = selectRewriteCandidate(baseline, candidate, spec);

  // The advisory judge rides the command bridge, fail-open, and never
  // moves the metric: its verdicts are reported beside the deterministic
  // ones and reach nothing downstream.
  const judge = runRewriteJudge(resolveSkillRewriteJudgeCmd(config), {
    skill,
    spec_hash: specHash,
    metric: "tasks_passed_rate",
    baseline_rate: selection.baselineRate,
    candidate_rate: selection.candidateRate,
    verdict: selection.verdict,
  });

  let heldoutScores: ReadonlyArray<RewriteTaskScore> = [];
  let heldoutVerdict: string | null = null;
  let heldoutEnvelopes: ReturnType<typeof buildRewriteHeldoutEnvelopes> | null = null;
  let staged: { id: string; slug: string } | null = null;

  if (selection.verdict === SKILL_REWRITE_VERDICT.promote) {
    const heldoutDir = join(roundsDir, "heldout");
    if (existsSync(heldoutDir) && readDirNames(heldoutDir).length > 0) {
      heldoutScores = scoreArm(vault, roundsDir, "heldout", tasks, spec);
      heldoutVerdict = checkRewriteHeldout(heldoutScores, spec);
      const finalVerdict = heldoutVerdict;
      if (finalVerdict === SKILL_REWRITE_VERDICT.promote) {
        const candidatePath = trim(flags["candidate-file"]);
        if (!candidatePath) {
          throw new CliError(
            "brain skill-proposals rewrite-score: --candidate-file is required to stage a " +
              "promoted rewrite (the pending proposal carries the candidate body)",
          );
        }
        const candidateBody = readCandidateBody(candidatePath);
        const incumbent = loadIncumbent(
          vault,
          config,
          skill,
          flags["skills-root"] as string | undefined,
        );
        const result = stageScoredRewriteProposal(vault, {
          skill: {
            name: skill,
            description: incumbent.description ?? "Rewritten by a benchmark-gated gate round.",
            triggers: incumbent.triggers ?? [],
            body: candidateBody,
          },
          spec,
          specHash,
          baselineScore: selection.baselineRate,
          candidateScore: selection.candidateRate,
          heldoutScore: heldoutScores.length > 0 ? passedRateOf(heldoutScores) : 1,
          incumbentVersion: incumbent.version,
        });
        if (result.outcome !== "created") {
          throw new CliError(
            `brain skill-proposals rewrite-score: staging declined (${result.outcome}${
              "reason" in result ? `: ${result.reason}` : ""
            })`,
          );
        }
        staged = { id: result.id, slug: result.slug };
      }
    } else {
      // The one moment held-out text may enter an envelope: the selection
      // just promoted the candidate, and the single check has not run yet.
      const candidatePath = trim(flags["candidate-file"]);
      if (!candidatePath) {
        throw new CliError(
          "brain skill-proposals rewrite-score: --candidate-file is required to hand out the " +
            "held-out round (the envelopes carry the candidate body)",
        );
      }
      heldoutEnvelopes = buildRewriteHeldoutEnvelopes(
        readCandidateBody(candidatePath),
        spec,
        tasks,
      );
    }
  }

  const finalVerdict =
    heldoutVerdict ??
    (selection.verdict === SKILL_REWRITE_VERDICT.promote ? null : selection.verdict);
  const gradeRecorded =
    finalVerdict !== null
      ? recordSkillRewriteGrade(vault, {
          payload: buildRewriteGradeRecord({
            skill,
            spec,
            specHash,
            selection,
            heldoutVerdict:
              heldoutVerdict === SKILL_REWRITE_VERDICT.promote
                ? SKILL_REWRITE_VERDICT.promote
                : SKILL_REWRITE_VERDICT.hold,
            devScores: candidate,
            heldoutScores,
          }),
        }).id
      : null;

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          skill,
          mode,
          spec_hash: specHash,
          tasks_hash: spec.tasksHash,
          verdict: finalVerdict ?? "heldout_pending",
          baseline_rate: selection.baselineRate,
          candidate_rate: selection.candidateRate,
          dev: candidate,
          held_out: heldoutScores,
          heldout_verdict: heldoutVerdict,
          heldout_envelopes: heldoutEnvelopes,
          judge,
          staged,
          grade_record_id: gradeRecorded,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `rewrite-score ${skill}: verdict=${finalVerdict ?? "heldout_pending"} ` +
      `baseline=${selection.baselineRate.toFixed(3)} candidate=${selection.candidateRate.toFixed(3)} ` +
      `mode=${mode}\n`,
  );
  for (const score of candidate) {
    process.stdout.write(
      `  dev ${score.taskId} ${score.passed ? "pass" : `fail(${score.failedChecks.join(",")})`}\n`,
    );
  }
  for (const score of heldoutScores) {
    process.stdout.write(
      `  held-out ${score.taskId} ${score.passed ? "pass" : `fail(${score.failedChecks.join(",")})`}\n`,
    );
  }
  if (judge.status !== "skipped") {
    process.stdout.write(`  judge ${judge.status}${judge.detail ? `: ${judge.detail}` : ""}\n`);
  }
  if (heldoutEnvelopes !== null) {
    process.stdout.write("  held-out round pending; the single check's envelopes:\n");
    for (const envelope of heldoutEnvelopes) {
      process.stdout.write(
        `  ${envelope.round} ${envelope["task_id"]} -> ${envelope.target_path}\n` +
          `${envelope.prompt
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}\n`,
      );
    }
  }
  if (staged !== null) process.stdout.write(`  staged ${staged.id}\n`);
  return 0;
}

/**
 * Read the candidate body, refusing by name when the file is not there.
 * The raw ENOENT would put a machine stack where a refusal belongs.
 */
function readCandidateBody(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new CliError(
      `brain skill-proposals rewrite: --candidate-file is not readable at ${path}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Read one arm's transcript files from the rounds tree and score them. */
function scoreArm(
  vault: string,
  roundsDir: string,
  arm: "baseline" | "candidate" | "heldout",
  tasks: ReturnType<typeof parseSkillBenchmarkTasks>,
  spec: SkillRewriteSpec,
): ReadonlyArray<RewriteTaskScore> {
  if (arm === "heldout") {
    // The caller decides when the held-out arm is allowed to exist.
    const dir = join(roundsDir, arm);
    if (!existsSync(dir)) return [];
    return scoreRewriteTranscripts(readSubmissions(dir), tasks, { arm: "heldout", spec });
  }
  const dir = join(roundsDir, arm);
  if (!existsSync(dir)) {
    throw new CliError(
      `brain skill-proposals rewrite-score: no ${arm} round transcripts under ${dir}; ` +
        "run rewrite-plan and execute the envelopes first - an absent arm is not a passing arm",
    );
  }
  return scoreRewriteTranscripts(readSubmissions(dir), tasks, { arm: "dev", spec });
}

function readSubmissions(dir: string): ReadonlyArray<unknown> {
  return readDirNames(dir)
    .toSorted()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function readDirNames(dir: string): ReadonlyArray<string> {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function passedRateOf(scores: ReadonlyArray<RewriteTaskScore>): number {
  if (scores.length === 0) return 0;
  return scores.filter((score) => score.passed).length / scores.length;
}
