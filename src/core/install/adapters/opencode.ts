/**
 * opencode adapter — JSON-merge into `~/.config/opencode/opencode.json`.
 *
 * Upstream is `anomalyco/opencode` (formerly hosted under
 * `sst/opencode`). Verified against https://opencode.ai/docs 2026-06-10:
 * MCP servers live in `opencode.json` (global copy under
 * `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/`) beneath the `mcp` key,
 * each entry shaped `{type: "local", command: [bin, ...args],
 * environment?, enabled}`.
 *
 * Releases up to v1.3.0 wrote `~/.config/opencode/mcp.json` with an
 * `mcpServers` key — a file opencode never reads. `apply` migrates our
 * two keys out of that file (and deletes it when nothing else is left)
 * so stale registrations do not shadow the real one in operator
 * debugging sessions.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { createJsonMcpAdapter } from "./_json-mcp.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { recordEntry, readManifest } from "../manifest.ts";
import { OPENCODE_PLUGIN_FILENAME, installedPluginContent } from "../opencode-plugin-asset.ts";
import { defaultRegistry } from "../registry.ts";
import type {
  ApplyOpts,
  ApplyResult,
  InstallEnv,
  InstallPlan,
  McpPayload,
  McpServerEntry,
  UninstallResult,
  VerifyResult,
} from "../types.ts";

function opencodeDir(env: InstallEnv): string {
  const xdg = env.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(env.home, ".config");
  return join(base, "opencode");
}

function configPath(env: InstallEnv): string {
  return join(opencodeDir(env), "opencode.json");
}

function legacyConfigPath(env: InstallEnv): string {
  return join(opencodeDir(env), "mcp.json");
}

/**
 * Canonical `McpServerEntry` → opencode `mcp` entry. opencode takes the
 * full argv as one `command` array and calls the env map `environment`;
 * `enabled: true` is explicit so an operator toggling the server off
 * shows up as drift instead of silently staying off after re-apply.
 */
export function serializeOpencodeEntry(entry: McpServerEntry): Record<string, unknown> {
  return {
    type: "local",
    command: [entry.command, ...entry.args],
    ...(entry.env && Object.keys(entry.env).length > 0 ? { environment: { ...entry.env } } : {}),
    enabled: true,
  };
}

/**
 * Best-effort removal of our keys from the legacy `mcp.json`. Never
 * throws: a malformed or absent file is left as-is — migration is an
 * opportunistic cleanup, not a gate on the real install.
 */
function migrateLegacyMcpJson(env: InstallEnv, opts: ApplyOpts): void {
  const path = legacyConfigPath(env);
  if (opts.dryRun || !existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const root = parsed as Record<string, unknown>;
    const servers = root["mcpServers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
    const block = servers as Record<string, unknown>;
    if (!(OSB_KEY_FULL in block) && !(OSB_KEY_WRITER in block)) return;
    delete block[OSB_KEY_FULL];
    delete block[OSB_KEY_WRITER];
    const fileIsEmpty = Object.keys(block).length === 0 && Object.keys(root).length === 1;
    if (fileIsEmpty) {
      rmSync(path);
      return;
    }
    atomicWriteFileSync(path, JSON.stringify(root, null, 2) + "\n");
  } catch {
    // Unreadable or unparseable legacy file: not ours to interpret.
  }
}

function pluginPath(env: InstallEnv): string {
  return join(opencodeDir(env), "plugins", OPENCODE_PLUGIN_FILENAME);
}

/**
 * Reads the installed plugin copy, or null when the path is absent,
 * not a regular file, or unreadable. Callers treat null as "needs
 * (re)install" / drift instead of letting a stray directory or a
 * permissions problem abort the whole install flow.
 */
function readPluginCopy(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const base = createJsonMcpAdapter({
  target: "opencode",
  label: "opencode",
  topLevelKey: "mcp",
  resolveConfigPath: configPath,
  serializeEntry: serializeOpencodeEntry,
  postNotes: ["Restart opencode to load the new MCP servers and the Open Second Brain plugin."],
});

export const opencodeAdapter = {
  ...base,

  plan(payload: McpPayload, env: InstallEnv): InstallPlan {
    const basePlan = base.plan(payload, env);
    const steps = [...basePlan.steps];
    steps.push({
      kind: "file-copy",
      path: pluginPath(env),
      preview: `copy the bundled Open Second Brain plugin to ${pluginPath(env)}`,
    });
    const legacy = legacyConfigPath(env);
    if (existsSync(legacy)) {
      steps.push({
        kind: "json-merge",
        path: legacy,
        preview: `remove Open Second Brain keys from the legacy ${legacy} (delete when empty)`,
      });
    }
    return { ...basePlan, steps };
  },

  apply(plan: InstallPlan, payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const result = base.apply(plan, payload, env, opts);
    migrateLegacyMcpJson(env, opts);

    const plugin = pluginPath(env);
    let pluginWritten = 0;
    if (!opts.dryRun) {
      const expected = installedPluginContent();
      const current = readPluginCopy(plugin);
      if (current !== expected) {
        // A stray directory or special file at the plugin path must not
        // abort the install; clear it before the atomic write.
        if (current === null && existsSync(plugin)) {
          rmSync(plugin, { recursive: true, force: true });
        }
        const dir = dirname(plugin);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        atomicWriteFileSync(plugin, expected);
        pluginWritten = 1;
      }
      // The base body records ownership of the two JSON keys; extend the
      // entry with the plugin file so verify and uninstall track it too.
      const stored = readManifest(env.vault).installs[base.target] ?? result.manifest;
      const manifest = { ...stored, owned_paths: [plugin] };
      recordEntry(env.vault, manifest);
      return {
        ...result,
        manifest,
        steps_executed: result.steps_executed + pluginWritten,
      };
    }
    return result;
  },

  verify(env: InstallEnv): VerifyResult {
    const baseResult = base.verify(env);
    if (baseResult.status !== "ok") return baseResult;
    const plugin = pluginPath(env);
    const fixHint = "o2b install --target opencode --apply";
    const current = readPluginCopy(plugin);
    if (current === null) {
      return {
        target: base.target,
        status: "drift",
        details: [`plugin file missing, unreadable, or not a regular file: ${plugin}`],
        fix_hint: fixHint,
      };
    }
    if (current !== installedPluginContent()) {
      return {
        target: base.target,
        status: "drift",
        details: [`plugin file differs from the bundled version: ${plugin}`],
        fix_hint: fixHint,
      };
    }
    return baseResult;
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const result = base.uninstall(env, opts);
    const plugin = pluginPath(env);
    if (existsSync(plugin)) {
      try {
        if (!opts.dryRun) rmSync(plugin, { recursive: true, force: true });
        return { ...result, removed_paths: [...result.removed_paths, plugin] };
      } catch (e) {
        return {
          ...result,
          skipped: [...result.skipped, [plugin, `could not remove: ${(e as Error).message}`]],
        };
      }
    }
    return result;
  },
};

defaultRegistry.register(opencodeAdapter);
