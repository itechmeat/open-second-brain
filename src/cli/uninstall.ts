/**
 * Read-only uninstall planner. Mirrors `src/open_second_brain/uninstall.py`.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { discoverConfig } from "../core/config.ts";
import type { UninstallPlan } from "../core/types.ts";

export const PLUGIN_NAME = "open-second-brain";

export const HERMES_COMMANDS: ReadonlyArray<string> = [
  `hermes mcp remove ${PLUGIN_NAME}`,
  `hermes plugins remove ${PLUGIN_NAME}`,
  "hermes gateway restart",
];

export const SAFE_CONFIG_DIR_NAMES: ReadonlySet<string> = new Set([
  "open-second-brain",
  "open_second_brain",
]);

function isSafeLocalConfigDir(target: string): readonly [boolean, string] {
  const name = basename(target);
  if (!SAFE_CONFIG_DIR_NAMES.has(name)) {
    return [
      false,
      `directory name '${name}' is not a recognized Open Second Brain config directory; refusing to remove`,
    ];
  }
  const partsLower = target.split(sep).map((p) => p.toLowerCase());
  if (partsLower.includes(".hermes") || partsLower.includes("hermes")) {
    return [false, "config directory is inside a Hermes-owned path; refusing to remove"];
  }
  if (existsSync(join(target, ".git"))) {
    return [false, "config directory looks like a git repository; refusing to remove"];
  }
  return [true, ""];
}

function vaultPathFromConfig(data: Record<string, string>): string | null {
  for (const key of ["vault_path", "vault", "vault_dir", "path"]) {
    const value = data[key];
    if (value) return value;
  }
  return null;
}

function listEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export interface PlanUninstallOptions {
  readonly configPath: string;
  readonly applyLocal?: boolean;
}

export function planUninstall(opts: PlanUninstallOptions): UninstallPlan {
  const applyLocal = opts.applyLocal ?? false;
  const discovery = discoverConfig(opts.configPath);
  const cfgDir = dirname(discovery.path);
  const cfgDirExists = existsSync(cfgDir) && statSync(cfgDir).isDirectory();
  const entries = listEntries(cfgDir);
  const vaultPath = vaultPathFromConfig(discovery.data);

  const removed: string[] = [];
  const skipped: Array<readonly [string, string]> = [];
  const errors: Array<readonly [string, string]> = [];

  if (applyLocal) {
    if (!cfgDirExists) {
      skipped.push([cfgDir, "config directory does not exist"]);
    } else {
      const [safe, reason] = isSafeLocalConfigDir(cfgDir);
      if (!safe) {
        skipped.push([cfgDir, reason]);
      } else {
        try {
          rmSync(cfgDir, { recursive: true, force: true });
          removed.push(cfgDir);
        } catch (exc) {
          errors.push([cfgDir, (exc as Error).message ?? String(exc)]);
        }
      }
    }
  }

  return {
    configPath: discovery.path,
    configExists: discovery.exists,
    configDir: cfgDir,
    configDirExists: cfgDirExists,
    configDirEntries: entries,
    vaultPath,
    applyLocal,
    hermesCommands: HERMES_COMMANDS,
    removedPaths: removed,
    skippedPaths: skipped,
    errors,
  };
}

export function renderPlan(plan: UninstallPlan): string {
  const lines: string[] = [];
  const title = "Open Second Brain — Uninstall plan";
  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push("");

  const mode = plan.applyLocal
    ? "apply-local (machine-local config directory may be removed)"
    : "dry-run (read-only)";
  lines.push(`Mode: ${mode}`);
  lines.push("");

  lines.push("Local config:");
  const configState = plan.configExists ? "exists" : "missing";
  lines.push(`  config file: ${plan.configPath} (${configState})`);
  if (plan.configDirExists) {
    const n = plan.configDirEntries.length;
    lines.push(`  config dir:  ${plan.configDir} (${n} entr${n === 1 ? "y" : "ies"})`);
    for (const entry of plan.configDirEntries) {
      const full = join(plan.configDir, entry);
      const suffix = existsSync(full) && statSync(full).isDirectory() ? "/" : "";
      lines.push(`    - ${entry}${suffix}`);
    }
  } else {
    lines.push(`  config dir:  ${plan.configDir} (missing)`);
  }
  lines.push("");

  lines.push("Hermes integration (run these yourself; this tool will not):");
  for (const cmd of plan.hermesCommands) {
    lines.push(`  $ ${cmd}`);
  }
  lines.push("");
  lines.push("  Hermes owns plugin installation and MCP registration. Open Second");
  lines.push("  Brain never edits ~/.hermes/config.yaml on your behalf.");
  lines.push("");

  lines.push("Vault (NEVER removed by this tool):");
  if (plan.vaultPath !== null) {
    lines.push(`  ${plan.vaultPath}`);
  } else {
    lines.push("  (no vault path recorded in config; check your runtime settings)");
  }
  lines.push("  Your Markdown notes, Daily/, and AI Wiki/ stay exactly as they are.");
  lines.push("");

  if (plan.applyLocal) {
    lines.push("Apply-local results:");
    if (plan.removedPaths.length > 0) {
      for (const p of plan.removedPaths) lines.push(`  removed: ${p}`);
    }
    if (plan.skippedPaths.length > 0) {
      for (const [p, reason] of plan.skippedPaths) lines.push(`  skipped: ${p} — ${reason}`);
    }
    if (plan.errors.length > 0) {
      for (const [p, reason] of plan.errors) lines.push(`  error:   ${p} — ${reason}`);
    }
    if (plan.removedPaths.length === 0 && plan.skippedPaths.length === 0 && plan.errors.length === 0) {
      lines.push("  (nothing to do)");
    }
    lines.push("");
  } else {
    lines.push("Next steps:");
    lines.push("  1. Run the Hermes commands above to deregister the MCP server and plugin.");
    lines.push("  2. Re-run with --apply-local to remove the machine-local config directory.");
    lines.push("  3. Add --remove-cli to also remove the o2b/vault-log symlinks from ~/.local/bin.");
    lines.push("  4. Delete the vault yourself if and only if you really want to lose your notes.");
    lines.push("");
  }

  return lines.join("\n").replace(/\s+$/g, "") + "\n";
}
