/**
 * `o2b partner` subcommand dispatcher.
 *
 * Reports on external code-project partners (currently codegraph). It is a
 * top-level command rather than a `brain` verb because it inspects an external
 * code project, not vault memory content. Every verb here is strictly
 * read-only: it never installs, initializes, extracts, or mutates a partner
 * index or the vault. `resync` is no exception - it renders a cron recipe as
 * text and runs no indexer; the writes in the recipe belong to the operator's
 * own crontab, on the operator's own host.
 */

import { resolve } from "node:path";

import { CliError, parseFlags } from "./argparse.ts";
import { CronTemplateError } from "./cron-recipe.ts";
import { renderCodegraphResyncTemplate } from "./partner-codegraph-cron.ts";
import { defaultConfigPath, resolveVault } from "../core/config.ts";
import { isDir } from "../core/fs-utils.ts";
import { findCodeProjects } from "../core/partner/codegraph.ts";
import { summarizeGraphHealth } from "../core/partner/codegraph-health.ts";
import { buildCodegraphReport, type CodegraphReport } from "../core/partner/codegraph-report.ts";

/** Both verbs, in one usage block so the two error paths cannot drift. */
const PARTNER_USAGE =
  "usage: o2b partner codegraph report [--vault <path>] [--fail-on-health] [--json]\n" +
  "       o2b partner codegraph resync --cron-template [--interval <N>] " +
  "[--project <path>] [--vault <path>]\n";

/** Cadence the resync recipe uses when the caller names none. */
const DEFAULT_RESYNC_INTERVAL = "6h";

/**
 * Exit for a report whose graph health the caller asked to gate on and
 * which did not pass. Distinct from the 2 this command line reserves for a
 * mistake in the argv: nothing is wrong with the invocation here, the index
 * is simply not in a state the caller declared acceptable.
 */
const EXIT_HEALTH_REFUSED = 1;

/** Exit for an interval cron cannot express - the input is a value, not a flag error. */
const EXIT_INTERVAL_REFUSED = 1;

function resolveScopeVault(flagVal: string | undefined): string {
  // The report scans the cwd plus the vault parent's siblings. A configured
  // vault sharpens that scope; without one we fall back to the cwd so the
  // command still works inside a bare code checkout.
  return flagVal ?? resolveVault(defaultConfigPath() ?? undefined) ?? process.cwd();
}

function renderCodegraphReport(report: CodegraphReport): string {
  const lines: string[] = [];
  lines.push(`project: ${report.project ?? "(none in scope)"}`);
  lines.push(`codegraph CLI: ${report.cli.available ? report.cli.path : "not installed"}`);
  const idx = report.index;
  const detail = idx.reason ? ` (${idx.reason})` : "";
  if (idx.state === "indexed") {
    lines.push(
      `index: indexed (${idx.node_count ?? 0} nodes, ${idx.file_count ?? 0} files, ` +
        `${idx.edge_count ?? 0} edges)`,
    );
    // Read-only graph-health gate: surface non-blocking findings before any
    // labeling/import/recall surface trusts the graph.
    if (idx.health) {
      if (idx.health.ok) {
        lines.push("graph health: ok");
      } else {
        lines.push(`graph health: ${idx.health.warnings.length} warning(s)`);
        for (const w of idx.health.warnings) lines.push(`  - ${w.code}: ${w.message}`);
      }
    }
  } else {
    lines.push(`index: ${idx.state}${detail}`);
  }
  if (report.cargo_workspace) {
    const ws = report.cargo_workspace;
    lines.push(`cargo workspace: ${ws.memberCount} member(s)`);
    for (const m of ws.members) lines.push(`  - ${m}`);
  } else {
    lines.push(`cargo workspace: none (${report.cargo_workspace_reason})`);
  }
  return lines.join("\n");
}

/**
 * Why `--fail-on-health` refuses this report, or `null` when it passes.
 *
 * Passing requires a measured, healthy graph. An index that is absent, not
 * built, or unreadable does not pass by default: the caller asked for a gate,
 * and a gate that could not measure its subject must not report the same
 * thing as one that measured it and found it clean. Without the flag the
 * report's exit is unchanged, so nothing that reads this surface today moves.
 */
function healthGateRefusal(report: CodegraphReport): string | null {
  const idx = report.index;
  if (idx.state !== "indexed") {
    const detail = idx.reason ? ` (${idx.reason})` : "";
    return `index state is ${idx.state}${detail}, so graph health was never measured`;
  }
  if (!idx.health) {
    return "the report carries no graph-health block, so graph health was never measured";
  }
  if (idx.health.ok) return null;
  return `graph health: ${summarizeGraphHealth(idx.health)}`;
}

function codegraphReportVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    "fail-on-health": { type: "boolean" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `partner codegraph report does not accept positional arguments: ${positional.join(" ")}`,
    );
  }
  const vaultFlag = flags["vault"] as string | undefined;
  const asJson = Boolean(flags["json"]);
  const report = buildCodegraphReport({ cwd: process.cwd(), vault: resolveScopeVault(vaultFlag) });
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderCodegraphReport(report) + "\n");
  }
  if (!flags["fail-on-health"]) return 0;
  const refusal = healthGateRefusal(report);
  if (refusal === null) return 0;
  process.stderr.write(`error: --fail-on-health: ${refusal}\n`);
  return EXIT_HEALTH_REFUSED;
}

/**
 * The repository the resync recipe is rendered for: the explicit `--project`
 * when given, otherwise the first project the same scan the report uses finds.
 * An empty scan is an error rather than a recipe for nothing - a cron job
 * pointed at no repository would run forever and index nothing.
 */
function resolveResyncProject(
  projectFlag: string | undefined,
  vaultFlag: string | undefined,
): string {
  if (projectFlag !== undefined) {
    const resolved = resolve(projectFlag);
    if (!isDir(resolved)) {
      throw new CliError(`--project ${projectFlag} is not a readable directory`);
    }
    return resolved;
  }
  const found = findCodeProjects({ cwd: process.cwd(), vault: resolveScopeVault(vaultFlag) });
  const first = found[0];
  if (first === undefined) {
    throw new CliError(
      "no code project in scope: pass --project <path> to name the repository to resync",
    );
  }
  return first;
}

/**
 * Render the resync cron recipe. `--cron-template` is required and has no
 * default-on twin: without it there is nothing this verb could honestly do.
 * Doing nothing quietly would be the silence this surface exists to end, and
 * running the partner's indexer would break the module invariant that OSB
 * never writes into the external tool's store. So it is a usage error.
 */
function codegraphResyncVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    project: { type: "string" },
    interval: { type: "string" },
    "cron-template": { type: "boolean" },
  });
  if (positional.length > 0) {
    throw new CliError(
      `partner codegraph resync does not accept positional arguments: ${positional.join(" ")}`,
    );
  }
  if (!flags["cron-template"]) {
    throw new CliError(
      "partner codegraph resync requires --cron-template: this verb only prints a cron " +
        "recipe for the operator to install, and never runs an indexer itself",
    );
  }
  const projectPath = resolveResyncProject(
    flags["project"] as string | undefined,
    flags["vault"] as string | undefined,
  );
  const interval = (flags["interval"] as string | undefined) ?? DEFAULT_RESYNC_INTERVAL;
  try {
    process.stdout.write(renderCodegraphResyncTemplate(projectPath, interval));
  } catch (err) {
    if (err instanceof CronTemplateError) {
      process.stderr.write(`error: ${err.message}\n`);
      return EXIT_INTERVAL_REFUSED;
    }
    throw err;
  }
  return 0;
}

/** Every codegraph verb, in one table the manifest ratchet enumerates. */
const CODEGRAPH_VERBS: Readonly<Record<string, (argv: ReadonlyArray<string>) => number>> =
  Object.freeze({
    report: codegraphReportVerb,
    resync: codegraphResyncVerb,
  });

export async function handlePartnerSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const partner = argv[0];
  const verb = argv[1];
  const rest = argv.slice(2);

  if (partner === "codegraph") {
    const handler = verb === undefined ? undefined : CODEGRAPH_VERBS[verb];
    if (handler !== undefined) return handler(rest);
    process.stderr.write(`error: unknown partner codegraph subcommand: ${verb ?? "(none)"}\n`);
    process.stderr.write(PARTNER_USAGE);
    return 2;
  }
  process.stderr.write(`error: unknown partner: ${partner ?? "(none)"}\n`);
  process.stderr.write(PARTNER_USAGE);
  return 2;
}
