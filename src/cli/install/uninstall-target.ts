/**
 * `o2b uninstall --target X` — remove what `o2b install --target X` wrote.
 *
 *   o2b uninstall --target X                       # dry-run
 *   o2b uninstall --target X --apply               # remove per manifest
 *   o2b uninstall --target X --apply --force-from-snippet
 *                                                   # remove without manifest
 *                                                   # (exact-payload match)
 */

import { homedir } from "node:os";

import { parseFlags } from "../argparse.ts";
import { defaultConfigPath, discoverConfig } from "../../core/config.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
import "../../core/install/adapters/aider.ts";
import "../../core/install/adapters/copilot-cli.ts";
import "../../core/install/adapters/cursor.ts";
import "../../core/install/adapters/gemini-cli.ts";
import "../../core/install/adapters/generic.ts";
import "../../core/install/adapters/kiro.ts";
import "../../core/install/adapters/opencode.ts";
import "../../core/install/adapters/pi.ts";
import { InstallError, type InstallEnv } from "../../core/install/types.ts";

export async function cmdUninstallTarget(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    target: { type: "string", required: true },
    apply: { type: "boolean" },
    "force-from-snippet": { type: "boolean" },
    config: { type: "string" },
    vault: { type: "string" },
    json: { type: "boolean" },
  });

  const target = flags["target"] as string;
  const adapter = defaultRegistry.get(target);
  if (!adapter) {
    process.stderr.write(
      `error: unknown --target: ${target}. ` +
        `Available: ${defaultRegistry.targets().join(", ")}\n`,
    );
    return 2;
  }

  const dryRun = !flags["apply"];
  const cfgPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const cfg = discoverConfig(cfgPath).data;
  const vault =
    (flags["vault"] as string | undefined) ?? cfg["vault"] ?? process.env["VAULT_DIR"] ?? "";
  if (!vault) {
    process.stderr.write(
      "error: vault not configured. Pass --vault <path>, set VAULT_DIR, or run `o2b init`.\n",
    );
    return 2;
  }

  const env: InstallEnv = {
    vault,
    home: homedir(),
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    now: new Date(),
  };
  const opts = {
    dryRun,
    force: false,
    stdout: process.stdout as NodeJS.WriteStream,
    stderr: process.stderr as NodeJS.WriteStream,
    fromSnippet: Boolean(flags["force-from-snippet"]),
  };

  try {
    const result = adapter.uninstall(env, opts);
    if (flags["json"]) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    const lines: string[] = [];
    lines.push(`o2b uninstall --target ${target}` + (dryRun ? " (dry-run)" : " --apply"));
    if (result.removed_keys.length > 0) {
      lines.push("  removed keys:");
      for (const k of result.removed_keys) lines.push(`    - ${k}`);
    }
    if (result.removed_paths.length > 0) {
      lines.push("  removed paths:");
      for (const p of result.removed_paths) lines.push(`    - ${p}`);
    }
    if (result.skipped.length > 0) {
      lines.push("  skipped:");
      for (const [what, why] of result.skipped) lines.push(`    - ${what} (${why})`);
    }
    if (
      result.removed_keys.length === 0 &&
      result.removed_paths.length === 0 &&
      result.skipped.length === 0
    ) {
      lines.push("  (nothing to do)");
    }
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return 0;
  } catch (e) {
    if (e instanceof InstallError) {
      process.stderr.write(`error: ${e.message}\n`);
      if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
      return e.kind === "manifest-missing" ? 2 : 1;
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}
