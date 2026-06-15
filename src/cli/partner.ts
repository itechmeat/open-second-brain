/**
 * `o2b partner` subcommand dispatcher.
 *
 * Reports on external code-project partners (currently codegraph). It is a
 * top-level command rather than a `brain` verb because it inspects an external
 * code project, not vault memory content. Every verb here is strictly
 * read-only: it never installs, initializes, extracts, or mutates a partner
 * index or the vault.
 */

import { CliError, parseFlags } from "./argparse.ts";
import { defaultConfigPath, resolveVault } from "../core/config.ts";
import { buildCodegraphReport, type CodegraphReport } from "../core/partner/codegraph-report.ts";

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

function codegraphReportVerb(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, { vault: { type: "string" } });
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
  return 0;
}

export async function handlePartnerSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const partner = argv[0];
  const verb = argv[1];
  const rest = argv.slice(2);

  if (partner === "codegraph" && verb === "report") {
    return codegraphReportVerb(rest);
  }
  if (partner === "codegraph") {
    process.stderr.write(`error: unknown partner codegraph subcommand: ${verb ?? "(none)"}\n`);
    process.stderr.write("usage: o2b partner codegraph report [--vault <path>] [--json]\n");
    return 2;
  }
  process.stderr.write(`error: unknown partner: ${partner ?? "(none)"}\n`);
  process.stderr.write("usage: o2b partner codegraph report [--vault <path>] [--json]\n");
  return 2;
}
