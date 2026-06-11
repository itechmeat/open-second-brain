/**
 * `o2b update` CLI verb.
 *
 * Exit codes:
 *   0  all targets updated or up-to-date
 *   1  runtime error
 *   2  usage error
 *   3  drift detected after update
 *   4  user-modified-block conflict (use `--force` to override)
 */

import { homedir } from "node:os";

import { parseFlags } from "./argparse.ts";
import { defaultConfigPath, discoverConfig, resolveVault } from "../core/config.ts";
import { defaultRegistry } from "../core/install/registry.ts";
import "../core/install/adapters/aider.ts";
import "../core/install/adapters/copilot-cli.ts";
import "../core/install/adapters/cursor.ts";
import "../core/install/adapters/gemini-cli.ts";
import "../core/install/adapters/generic.ts";
import "../core/install/adapters/grok.ts";
import "../core/install/adapters/kiro.ts";
import "../core/install/adapters/opencode.ts";
import "../core/install/adapters/pi.ts";

import { runUpdate, type UpdateResult, type UpdateTargetResult } from "../core/install/update.ts";
import type { InstallEnv, VerifyResult } from "../core/install/types.ts";

interface ParsedUpdateArgs {
  readonly target: string | null;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
}

export function parseUpdateArgs(argv: string[]): ParsedUpdateArgs {
  const { flags } = parseFlags(argv, {
    target: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  return {
    target: (flags["target"] as string | undefined) ?? null,
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags["force"]),
    json: Boolean(flags["json"]),
  };
}

function buildEnv(): InstallEnv {
  const cfg = discoverConfig(defaultConfigPath()).data;
  const vault = resolveVault() ?? "";
  const env = { ...process.env } as Record<string, string>;
  if (cfg["agent_name"]) env["VAULT_AGENT_NAME"] = cfg["agent_name"];
  if (cfg["timezone"]) env["VAULT_TIMEZONE"] = cfg["timezone"];
  return { vault, home: homedir(), cwd: process.cwd(), env, now: new Date() };
}

function statusIcon(status: UpdateTargetResult["status"]): string {
  switch (status) {
    case "applied":
      return "✓";
    case "up-to-date":
      return "=";
    case "skipped":
      return "○";
    case "would-apply":
      return "~";
    case "error":
      return "✗";
    default:
      return "?";
  }
}

function renderResult(result: UpdateResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  for (const t of result.targets) {
    process.stdout.write(`${statusIcon(t.status)} ${t.target}`);
    if (t.reason) process.stdout.write(` — ${t.reason}`);
    if (t.error) process.stdout.write(` — ERROR: ${t.error}`);
    if (t.hint) process.stdout.write(`\n   hint: ${t.hint}`);
    if (t.postNotes && t.postNotes.length > 0) {
      for (const note of t.postNotes) process.stdout.write(`\n   → ${note}`);
    }
    process.stdout.write("\n");
  }

  const applied = result.targets.filter((t) => t.status === "applied").length;
  const upToDate = result.targets.filter((t) => t.status === "up-to-date").length;
  const skipped = result.targets.filter((t) => t.status === "skipped").length;
  const errors = result.targets.filter((t) => t.status === "error").length;
  process.stdout.write(`\n${applied} applied, ${upToDate} up-to-date, ${skipped} skipped`);
  if (errors > 0) process.stdout.write(`, ${errors} errors`);
  process.stdout.write("\n");
}

export async function cmdUpdate(argv: string[]): Promise<number> {
  let args: ParsedUpdateArgs;
  try {
    args = parseUpdateArgs(argv);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 2;
  }

  const env = buildEnv();
  if (!env.vault) {
    process.stderr.write("error: vault not configured. Set VAULT_DIR or run `o2b init`.\n");
    return 2;
  }

  if (args.target && !defaultRegistry.get(args.target)) {
    process.stderr.write(
      `error: unknown --target: ${args.target}. ` +
        `Available: ${defaultRegistry.targets().join(", ")}\n`,
    );
    return 2;
  }

  const result = runUpdate(defaultRegistry, env, {
    dryRun: args.dryRun,
    force: args.force,
    target: args.target,
  });

  renderResult(result, args.json);

  if (!args.dryRun) {
    const targets = args.target ? [defaultRegistry.get(args.target)!] : defaultRegistry.list();
    const verifyResults: VerifyResult[] = [];
    for (const adapter of targets) {
      if (adapter.detect(env).status === "installed") {
        verifyResults.push(adapter.verify(env));
      }
    }
    const drift = verifyResults.some((r) => r.status === "drift");
    if (drift) {
      process.stderr.write(
        "\nwarning: drift detected after update. Run `o2b install --check` for details.\n",
      );
      return 3;
    }
  }

  const hasError = result.targets.some((t) => t.status === "error");
  if (hasError) {
    const hasUserModifiedBlock = result.targets.some((t) => t.kind === "user-modified-block");
    return hasUserModifiedBlock ? 4 : 1;
  }
  return 0;
}
