/**
 * grok adapter - installs the bundled Grok Build plugin tree.
 *
 * Unlike the JSON-MCP adapters, grok does NOT take an MCP config file: the
 * two Open Second Brain servers ship inside the plugin's own `.mcp.json`
 * (vault-agnostic, see `grok-plugin-asset.ts`). Verified against live grok
 * 0.2.45: a user-scope plugin under `${GROK_HOME:-~/.grok}/plugins/<name>/`
 * is auto-enabled and auto-trusted - `grok inspect` reports its MCP servers
 * and hooks active with no `config.toml` entry, and `grok mcp doctor` starts
 * the server and discovers its tools. So the adapter only copies the committed
 * plugin tree and records it in the install manifest; `verify` compares the
 * installed copy against the committed bytes, and `uninstall` removes it.
 *
 * The `McpPayload` argument is unused: grok's MCP entries are the plugin's
 * vault-agnostic form, intentionally different from the `--vault`-bearing
 * payload the file-config adapters write.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { GROK_PLUGIN_DIR_NAME, readGrokPluginFiles } from "../grok-plugin-asset.ts";
import { recordEntry, removeEntry } from "../manifest.ts";
import { defaultRegistry } from "../registry.ts";
import type {
  ApplyOpts,
  ApplyResult,
  DetectResult,
  InstallEnv,
  InstallPlan,
  ManifestEntry,
  McpPayload,
  UninstallResult,
  VerifyResult,
} from "../types.ts";

const TARGET = "grok";
const LABEL = "Grok Build";
const FIX_HINT = "o2b install --target grok --apply";

function grokHome(env: InstallEnv): string {
  const override = env.env["GROK_HOME"];
  return override && override.length > 0 ? override : join(env.home, ".grok");
}

function pluginDir(env: InstallEnv): string {
  return join(grokHome(env), "plugins", GROK_PLUGIN_DIR_NAME);
}

function installedPath(env: InstallEnv, relPath: string): string {
  return join(pluginDir(env), relPath);
}

type FileStatus = "match" | "differs" | "missing" | "not-file";

interface FileState {
  readonly relPath: string;
  readonly path: string;
  readonly status: FileStatus;
}

/**
 * Compare every committed plugin file to its installed copy. A regular file
 * with identical bytes is `match`; anything else is drift the caller reports
 * verbatim (missing, differing, or a non-file such as a stray directory).
 */
function fileStates(env: InstallEnv): FileState[] {
  return readGrokPluginFiles().map((f) => {
    const path = installedPath(env, f.relPath);
    let status: FileStatus;
    try {
      status = !lstatSync(path).isFile()
        ? "not-file"
        : readFileSync(path, "utf8") === f.content
          ? "match"
          : "differs";
    } catch {
      status = "missing";
    }
    return { relPath: f.relPath, path, status };
  });
}

export const grokAdapter = {
  target: TARGET,
  label: LABEL,

  detect(env: InstallEnv): DetectResult {
    const states = fileStates(env);
    const present = states.filter((s) => s.status !== "missing");
    const status =
      present.length === 0
        ? "not-installed"
        : states.every((s) => s.status === "match")
          ? "installed"
          : "drift";
    return { target: TARGET, status, configPath: pluginDir(env), notes: [] };
  },

  plan(_payload: McpPayload, env: InstallEnv): InstallPlan {
    const steps = readGrokPluginFiles().map((f) => ({
      kind: "file-copy" as const,
      path: installedPath(env, f.relPath),
      preview: `copy ${f.relPath} into the grok plugin at ${pluginDir(env)}`,
    }));
    return {
      target: TARGET,
      steps,
      postNotes: [
        "grok loads the plugin on the next session start, or press r in the /plugins modal to reload now.",
      ],
    };
  },

  apply(_plan: InstallPlan, _payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const files = readGrokPluginFiles();
    const ownedPaths = files.map((f) => installedPath(env, f.relPath));
    const entry: ManifestEntry = {
      target: TARGET,
      applied_at: env.now.toISOString(),
      operation: "file-copy",
      config_path: pluginDir(env),
      owned_paths: ownedPaths,
    };

    if (opts.dryRun) {
      return { target: TARGET, manifest: entry, steps_executed: 0 };
    }

    let stepsExecuted = 0;
    for (const f of files) {
      const path = installedPath(env, f.relPath);
      const current = readFileIfRegular(path);
      if (current === f.content) continue;
      // A stray directory or special file at the path must not abort the
      // install; clear it before the atomic write.
      if (current === null && existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      atomicWriteFileSync(path, f.content);
      stepsExecuted += 1;
    }

    recordEntry(env.vault, entry);
    return { target: TARGET, manifest: entry, steps_executed: stepsExecuted };
  },

  verify(env: InstallEnv): VerifyResult {
    const states = fileStates(env);
    if (states.every((s) => s.status === "missing")) {
      return { target: TARGET, status: "not-installed", details: [], fix_hint: FIX_HINT };
    }
    const drift = states.filter((s) => s.status !== "match");
    if (drift.length === 0) {
      return { target: TARGET, status: "ok", details: [], fix_hint: null };
    }
    return {
      target: TARGET,
      status: "drift",
      details: drift.map((s) => `${s.relPath}: ${s.status}`),
      fix_hint: FIX_HINT,
    };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const removed: string[] = [];
    const skipped: Array<readonly [string, string]> = [];
    for (const f of readGrokPluginFiles()) {
      const path = installedPath(env, f.relPath);
      if (!existsSync(path)) continue;
      try {
        if (!opts.dryRun) rmSync(path, { force: true });
        removed.push(path);
      } catch (e) {
        skipped.push([path, `could not remove: ${(e as Error).message}`]);
      }
    }
    // The plugin directory is entirely ours; drop it (and its now-empty hooks/
    // subdir) so no empty shell is left behind. Best-effort: a non-empty dir
    // (operator added files) is left in place rather than force-removed.
    if (!opts.dryRun) {
      try {
        rmSync(pluginDir(env), { recursive: false });
      } catch {
        // Not empty or already gone - leave it.
      }
      removeEntry(env.vault, TARGET);
    }
    return { target: TARGET, removed_keys: [], removed_paths: removed, skipped };
  },
};

/** Read a path only when it is a regular file; null for missing or non-file. */
function readFileIfRegular(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

defaultRegistry.register(grokAdapter);
