/**
 * `o2b decision-model` subcommand dispatcher (issue #213, Part 1).
 *
 *   check [--ping]   the configured state: enabled or not, the provider
 *                    chain in order, base URL, pinned model, the key
 *                    variable's NAME and whether it is set (never the
 *                    value), per-use modes, vault opt-out, cost gate and
 *                    today's spend, processor terms, the measured tuning
 *                    state and the cached eval grades. `--ping` sends one
 *                    request per configured provider over a synthetic
 *                    state that carries no vault content and reports each
 *                    one. Exit 1 only for a broken configured provider
 *                    (invalid config, or no configured provider answering
 *                    the ping); a missing key is exit 0.
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
 *   thresholds fit   derive one use's threshold from the use's labelled
 *                    report data against a false-action target
 *                    (`--target`, default 0.05) and write it for the
 *                    answering model, in the local thresholds store next
 *                    to config.yaml.
 *   thresholds list  the stored thresholds, global and per-vault.
 *   thresholds set   write one threshold by hand for a model.
 *
 * check and list are read-only. eval run writes only the grade record in
 * the vault's continuity log and, on a promote, the mark under the
 * platform state root. thresholds fit and set write only the thresholds
 * store; nothing here deletes an entry.
 */

import { readFileSync } from "node:fs";

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
import {
  BUILTIN_USE_THRESHOLDS,
  PRIMARY_THRESHOLD_NAME,
} from "../core/decision-model/questions.ts";
import {
  decisionThresholdsPath,
  parseThresholdsStore,
  writeThresholdEntry,
} from "../core/decision-model/thresholds.ts";
import { runThresholdFit } from "../core/decision-model/thresholds-fit.ts";
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
  "[--config <path>] [--json]\n" +
  "       o2b decision-model thresholds fit --use <use> [--target <n>] [--since <date>] " +
  "[--vault <path>] [--config <path>] [--json]\n" +
  "       o2b decision-model thresholds list [--vault <path>] [--config <path>] [--json]\n" +
  "       o2b decision-model thresholds set --model <id> --use <use> --value <n> " +
  "[--name <name>] [--vault <path>] [--config <path>] [--json]\n";

function resolveTargets(flags: Record<string, unknown>): {
  readonly configPath: string;
  readonly config: Readonly<Record<string, string>>;
  readonly vault: string | null;
} {
  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const config = discoverConfig(configPath).data;
  const vault = (flags["vault"] as string | undefined) ?? resolveVault(configPath) ?? null;
  return { configPath, config, vault };
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
  const { config, vault } = resolveTargets(flags);
  if (vault === null) {
    throw new CliError("no vault configured. Pass --vault <path>.");
  }
  const report = buildDecisionModelReport(vault, {
    ...(since !== undefined ? { since } : {}),
    ...(use !== undefined ? { use } : {}),
    config: resolveDecisionModelConfig({
      config,
      vault,
      secretsVault: vault ?? undefined,
    }),
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

// ----- thresholds (the local per-model store, issue #264) ----------------

function useFlagRequired(flags: Record<string, unknown>): DecisionModelUse {
  const use = useFlag(flags);
  if (use === undefined) throw new CliError("decision-model thresholds needs --use <use>");
  return use;
}

function thresholdsFitVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    use: { type: "string" },
    target: { type: "string" },
    since: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model thresholds fit takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const use = useFlagRequired(flags);
  const { configPath, vault } = resolveTargets(flags);
  if (vault === null) {
    throw new CliError("no vault configured. Pass --vault <path>.");
  }
  const targetRaw = flags["target"] as string | undefined;
  let target: number | undefined;
  if (targetRaw !== undefined) {
    target = Number(targetRaw);
    if (!Number.isFinite(target) || target <= 0 || target >= 1) {
      throw new CliError(`--target must be a share between 0 and 1, got '${targetRaw}'`);
    }
  }
  const since = sinceFlag(flags);
  const result = runThresholdFit(decisionThresholdsPath(configPath), {
    vault,
    use,
    ...(target !== undefined ? { target } : {}),
    ...(since !== undefined ? { since } : {}),
  });
  if (!result.ok) {
    throw new CliError(`decision-model thresholds fit: ${result.note}; nothing was written`);
  }
  if (flags["json"] === true) {
    process.stdout.write(
      JSON.stringify(
        {
          model: result.model,
          use: result.use,
          name: result.name,
          value: result.entry.values[result.name],
          target: result.entry.target ?? null,
          samples: result.entry.samples ?? null,
          updated_at: result.entry.updated_at,
          already_tuned: result.alreadyTuned,
          store_path: decisionThresholdsPath(configPath),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  const share =
    result.entry.samples !== undefined && result.entry.samples > 0
      ? `over ${result.entry.samples} action(s)`
      : "over no actions";
  const lines = [
    `thresholds fit ${result.use}: wrote ${result.name} = ` +
      `${result.entry.values[result.name]} for model '${result.model}'`,
    `  false actions at most ${((result.entry.target ?? 0) * 100).toFixed(1)}% (${share})`,
    `  store: ${decisionThresholdsPath(configPath)}` +
      (result.alreadyTuned
        ? " (entry updated; the previous value is kept in its history)"
        : " (new entry; switching models never deletes one)"),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function renderThresholdEntry(
  model: string,
  use: string,
  entry: {
    values: Readonly<Record<string, number>>;
    source: string;
    updated_at: string;
    target?: number;
    samples?: number;
    history?: ReadonlyArray<{ value: number; source: string; updated_at: string }>;
  },
): string[] {
  const values = Object.entries(entry.values)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  const facts = [
    entry.source,
    entry.target !== undefined ? `target ${entry.target}` : null,
    entry.samples !== undefined ? `${entry.samples} action(s)` : null,
    entry.updated_at,
  ]
    .filter((v) => v !== null)
    .join(", ");
  const lines = [`    ${model} / ${use}: ${values} (${facts})`];
  for (const h of entry.history ?? []) {
    lines.push(`      was ${h.value} (${h.source}, ${h.updated_at})`);
  }
  return lines;
}

function thresholdsListVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model thresholds list takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const { configPath } = resolveTargets(flags);
  const storePath = decisionThresholdsPath(configPath);
  let store;
  try {
    store = parseThresholdsStore(readFileSync(storePath, "utf8"));
  } catch {
    store = parseThresholdsStore("");
  }
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify({ path: storePath, store }, null, 2) + "\n");
    return 0;
  }
  const lines: string[] = [`thresholds: ${storePath}`];
  const models = Object.entries(store.models).toSorted((a, b) => a[0].localeCompare(b[0]));
  if (models.length === 0) lines.push("models: none stored");
  else {
    lines.push("models:");
    for (const [model, uses] of models) {
      for (const use of Object.keys(uses).toSorted()) {
        lines.push(...renderThresholdEntry(model, use, uses[use as never]!));
      }
    }
  }
  const vaults = Object.entries(store.vaults).toSorted((a, b) => a[0].localeCompare(b[0]));
  if (vaults.length > 0) {
    lines.push("vault overrides:");
    for (const [vaultPath, section] of vaults) {
      lines.push(`  ${vaultPath}`);
      for (const [model, uses] of Object.entries(section).toSorted((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        for (const use of Object.keys(uses).toSorted()) {
          lines.push(...renderThresholdEntry(model, use, uses[use as never]!));
        }
      }
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function thresholdsSetVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    model: { type: "string" },
    use: { type: "string" },
    value: { type: "string" },
    name: { type: "string" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `decision-model thresholds set takes no positional arguments: ${positional.join(" ")}`,
    );
  }
  const model = flags["model"] as string | undefined;
  if (model === undefined || model.trim() === "") {
    throw new CliError("decision-model thresholds set needs --model <id>");
  }
  const use = useFlagRequired(flags);
  const valueRaw = flags["value"] as string | undefined;
  const value = Number(valueRaw);
  if (valueRaw === undefined || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CliError(`--value must be a probability between 0 and 1, got '${valueRaw}'`);
  }
  const names = Object.keys(BUILTIN_USE_THRESHOLDS[use]!);
  const name = (flags["name"] as string | undefined) ?? PRIMARY_THRESHOLD_NAME[use];
  if (!names.includes(name)) {
    throw new CliError(`--name must be one of ${names.join(", ")} for use '${use}', got '${name}'`);
  }
  const { configPath } = resolveTargets(flags);
  const storePath = decisionThresholdsPath(configPath);
  const vaultOverride = flags["vault"] as string | undefined;
  const entry = writeThresholdEntry(
    storePath,
    model.trim(),
    use,
    { values: { [name]: value }, source: "set" },
    vaultOverride ?? null,
  );
  if (flags["json"] === true) {
    process.stdout.write(
      JSON.stringify(
        {
          model: model.trim(),
          use,
          name,
          value: entry.values[name],
          updated_at: entry.updated_at,
          vault: vaultOverride ?? null,
          store_path: storePath,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  const lines = [
    `thresholds set: wrote ${name} = ${entry.values[name]} for model '${model.trim()}' (use ${use})`,
    `  store: ${storePath}` +
      (vaultOverride !== undefined ? ` (override for vault ${vaultOverride})` : ""),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function thresholdsVerb(argv: ReadonlyArray<string>): number {
  switch (argv[0]) {
    case "fit":
      return thresholdsFitVerb(argv.slice(1));
    case "list":
      return thresholdsListVerb(argv.slice(1));
    case "set":
      return thresholdsSetVerb(argv.slice(1));
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
    case "thresholds":
      return thresholdsVerb(rest);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
