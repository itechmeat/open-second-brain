/**
 * `o2b decision-model` subcommand dispatcher (issue #213, Part 1).
 *
 *   check [--ping]   the configured state: enabled or not, provider, base
 *                    URL, pinned model, the key variable's NAME and whether
 *                    it is set (never the value), per-use modes, vault
 *                    opt-out, cost gate and today's spend, processor terms,
 *                    the measured tuning state and the cached eval grades.
 *                    `--ping` sends one request over a synthetic state that
 *                    carries no vault content. Exit 1 only for a broken
 *                    configured provider (invalid config, or a failed ping
 *                    of an active one); a missing key is exit 0.
 *   report           per use: calls, outcome mix, latency, tokens, cost,
 *                    rerank shadow agreement and the cached eval grades,
 *                    from `decision_model_call` and
 *                    `decision_model_eval_grade` records.
 *   eval run         the preregistered eval for one use (`--use`), over
 *                    the configured adapter: real spend, counted toward
 *                    the daily gate. A use that is off is refused by
 *                    name before anything is sent. A promote verdict
 *                    writes the machine-side tuning mark only when the
 *                    grade record exists and the day's recorded spend
 *                    stayed under the gate; anything else leaves the
 *                    gate exactly as it was.
 *   eval list        the cached grade records, oldest first, in prose or
 *                    `--json`; malformed records are skipped with a named
 *                    note, never silently.
 *
 * check and list are read-only. eval run writes only the grade record in
 * the vault's continuity log and, on a promote, the mark under the
 * platform state root.
 */

import { CliError, parseFlags } from "./argparse.ts";
import { defaultConfigPath, discoverConfig, resolveVault } from "../core/config.ts";
import {
  buildDecisionModelCheck,
  buildDecisionModelReport,
  decisionModelCheckExitCode,
  renderDecisionModelCheck,
  renderDecisionModelReport,
  renderEvalGradeLine,
  type DecisionEvalGradeLine,
} from "../core/decision-model/diagnostics.ts";
import { isDecisionModelUse, type DecisionModelUse } from "../core/decision-model/contract.ts";
import { resolveDecisionModelConfig } from "../core/decision-model/config.ts";
import { decisionEvalSpecFor } from "../core/decision-model/eval-spec.ts";
import { runDecisionModelEval } from "../core/decision-model/eval/grade.ts";
import { listDecisionModelEvalGrades } from "../core/decision-model/record.ts";
import { processDirsEnv } from "../core/platform-dirs.ts";

const USAGE =
  "usage: o2b decision-model check [--ping] [--vault <path>] [--config <path>] [--json]\n" +
  "       o2b decision-model report [--since <date>] [--use <use>] [--vault <path>] " +
  "[--config <path>] [--json]\n" +
  "       o2b decision-model eval run --use <use> [--vault <path>] [--config <path>] [--json]\n" +
  "       o2b decision-model eval list [--use <use>] [--since <date>] [--vault <path>] " +
  "[--config <path>] [--json]\n";

function resolveTargets(flags: Record<string, unknown>): {
  readonly config: Readonly<Record<string, string>>;
  readonly vault: string | null;
} {
  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const config = discoverConfig(configPath).data;
  const vault = (flags["vault"] as string | undefined) ?? resolveVault(configPath) ?? null;
  return { config, vault };
}

async function checkVerb(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    ping: { type: "boolean" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model check takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const { config, vault } = resolveTargets(flags);
  const report = await buildDecisionModelCheck({
    config,
    vault,
    ping: flags["ping"] === true,
  });
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderDecisionModelCheck(report) + "\n");
  }
  return decisionModelCheckExitCode(report);
}

function reportVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    since: { type: "string" },
    use: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model report takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const sinceRaw = flags["since"] as string | undefined;
  let since: string | undefined;
  if (sinceRaw !== undefined) {
    const ms = Date.parse(sinceRaw);
    if (!Number.isFinite(ms)) throw new CliError(`--since must be a date, got '${sinceRaw}'`);
    since = new Date(ms).toISOString();
  }
  const use = flags["use"] as string | undefined;
  if (use !== undefined && !isDecisionModelUse(use)) {
    throw new CliError(`--use must be a decision-model use, got '${use}'`);
  }
  const { vault } = resolveTargets(flags);
  if (vault === null) {
    throw new CliError("no vault configured. Pass --vault <path>.");
  }
  const report = buildDecisionModelReport(vault, {
    ...(since !== undefined ? { since } : {}),
    ...(use !== undefined ? { use } : {}),
  });
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderDecisionModelReport(report) + "\n");
  }
  return 0;
}

function sinceFlag(flags: Record<string, unknown>): string | undefined {
  const sinceRaw = flags["since"] as string | undefined;
  if (sinceRaw === undefined) return undefined;
  const ms = Date.parse(sinceRaw);
  if (!Number.isFinite(ms)) throw new CliError(`--since must be a date, got '${sinceRaw}'`);
  return new Date(ms).toISOString();
}

function useFlag(flags: Record<string, unknown>): DecisionModelUse | undefined {
  const use = flags["use"] as string | undefined;
  if (use !== undefined && !isDecisionModelUse(use)) {
    throw new CliError(`--use must be a decision-model use, got '${use}'`);
  }
  return use;
}

/** The cached grades as the CLI's list verb and its JSON print them. */
function gradeLines(
  vault: string,
  since: string | undefined,
  use: DecisionModelUse | undefined,
): { grades: DecisionEvalGradeLine[]; skipped: string[] } {
  const { grades, skipped } = listDecisionModelEvalGrades(vault, since);
  const lines: DecisionEvalGradeLine[] = grades
    .filter((g) => use === undefined || g.use === use)
    .map((g) => ({
      record_id: g.recordId,
      created_at: g.createdAt,
      use: g.use,
      profile: g.profile,
      verdict: g.verdict,
      spec_hash: g.specHash,
      counted_n: g.countedN,
      counted_error: g.countedError,
      baseline_error: g.baselineError,
      dev_error: g.devError,
    }));
  return { grades: lines, skipped: [...skipped] };
}

async function evalRunVerb(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    use: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model eval run takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const use = useFlag(flags);
  if (use === undefined) throw new CliError("decision-model eval run needs --use <use>");
  const { config, vault } = resolveTargets(flags);
  // The same resolution the check verb reports: an inactive config is a
  // refusal naming the surface that explains it, not a half-run.
  const cfg = resolveDecisionModelConfig({
    config,
    vault,
    secretsVault: vault ?? undefined,
  });
  if (cfg.status !== "active") {
    throw new CliError(
      `decision-model eval run needs an active config (status ${cfg.status}); ` +
        "run `o2b decision-model check` for what is missing",
    );
  }
  // A use that is off measures nothing: the runner's mode override would
  // send no request, score every item degraded, cache that junk grade
  // record and exit 0. Refuse by name before grading - but keep the
  // specless use's own preregistration error, which already says the
  // same thing from the registry side.
  if (decisionEvalSpecFor(use) !== null && cfg.uses[use] === "off") {
    throw new CliError(
      `decision-model eval run: use '${use}' is off in decision_model_uses, so grading it ` +
        `would send nothing and measure nothing; enable it first (for example ` +
        `'${use}:shadow') and re-run`,
    );
  }
  // Every throw from the runner is a named refusal - no spec for the
  // use, a spec that names another use, a broken preregistration - and
  // is operator-actionable, so it exits 2 like the other refusals.
  let result: Awaited<ReturnType<typeof runDecisionModelEval>>;
  try {
    result = await runDecisionModelEval(use, {
      config: cfg,
      markSource: processDirsEnv(),
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderEvalRun(result) + "\n");
  }
  return 0;
}

function renderEvalRun(result: Awaited<ReturnType<typeof runDecisionModelEval>>): string {
  const num = (v: number | null): string => (v === null ? "-" : v.toFixed(3));
  const lines = [
    `decision-model eval ${result.use}: ${result.verdict}`,
    `  profile: ${result.profile ?? "(none)"}, spec ${result.spec_hash.slice(0, 12)}…, seed ${result.seed}`,
    `  counted: n=${result.counted.n}, error ${num(result.counted.error)} (ceiling ${result.ceiling}); ` +
      `baseline error ${num(result.baseline_error)}`,
    `  dev: n=${result.dev.n}, error ${num(result.dev.error)}; degraded requests: ${result.degraded_n}`,
  ];
  if (result.grade_record_id !== null) {
    lines.push(`  grade record: ${result.grade_record_id}`);
  }
  lines.push(
    result.mark_written
      ? `  tuning mark: written for (${result.profile ?? "?"}, ${result.use}) under the state root`
      : `  tuning mark: not written (${result.mark_note ?? "unknown reason"})`,
  );
  return lines.join("\n");
}

function evalListVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    since: { type: "string" },
    use: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model eval list takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const { vault } = resolveTargets(flags);
  if (vault === null) {
    throw new CliError("no vault configured. Pass --vault <path>.");
  }
  const { grades, skipped } = gradeLines(vault, sinceFlag(flags), useFlag(flags));
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify({ grades, skipped }, null, 2) + "\n");
  } else {
    const lines =
      grades.length === 0 && skipped.length === 0
        ? ["eval grades: none cached"]
        : [
            `eval grades: ${grades.length} record(s)` +
              (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
            ...grades.map((g) => `  ${renderEvalGradeLine(g)}`),
            ...skipped.map((note) => `  skipped: ${note}`),
          ];
    process.stdout.write(lines.join("\n") + "\n");
  }
  return 0;
}

function evalVerb(argv: ReadonlyArray<string>): number | Promise<number> {
  switch (argv[0]) {
    case "run":
      return evalRunVerb(argv.slice(1));
    case "list":
      return evalListVerb(argv.slice(1));
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

export async function handleDecisionModelSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  const rest = argv.slice(1);
  switch (verb) {
    case "check":
      return await checkVerb(rest);
    case "report":
      return reportVerb(rest);
    case "eval":
      return await evalVerb(rest);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
