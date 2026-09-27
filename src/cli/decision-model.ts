/**
 * `o2b decision-model` subcommand dispatcher (issue #213, Part 1).
 *
 *   check [--ping]   the configured state: enabled or not, provider, base
 *                    URL, pinned model, the key variable's NAME and whether
 *                    it is set (never the value), per-use modes, vault
 *                    opt-out, cost gate and today's spend, processor terms.
 *                    `--ping` sends one request over a synthetic state that
 *                    carries no vault content. Exit 1 only for a broken
 *                    configured provider (invalid config, or a failed ping
 *                    of an active one); a missing key is exit 0.
 *   report           per use: calls, outcome mix, latency, tokens, cost, and
 *                    rerank shadow agreement, from `decision_model_call`
 *                    records.
 *
 * Both are read-only; neither writes to the vault.
 */

import { CliError, parseFlags } from "./argparse.ts";
import { defaultConfigPath, discoverConfig, resolveVault } from "../core/config.ts";
import {
  buildDecisionModelCheck,
  buildDecisionModelReport,
  decisionModelCheckExitCode,
  renderDecisionModelCheck,
  renderDecisionModelReport,
} from "../core/decision-model/diagnostics.ts";
import { isDecisionModelUse } from "../core/decision-model/contract.ts";

const USAGE =
  "usage: o2b decision-model check [--ping] [--vault <path>] [--config <path>] [--json]\n" +
  "       o2b decision-model report [--since <date>] [--use <use>] [--vault <path>] " +
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

export async function handleDecisionModelSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  const rest = argv.slice(1);
  switch (verb) {
    case "check":
      return await checkVerb(rest);
    case "report":
      return reportVerb(rest);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}
