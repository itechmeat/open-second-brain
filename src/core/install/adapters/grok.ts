/**
 * grok adapter - native MCP + hooks registration for Grok Build.
 *
 * Verified against live grok 0.2.45 (debug log of a real session): grok loads
 * MCP from `~/.grok/config.toml` `[mcp_servers.*]` (its primary, highest-
 * priority source) and hooks from `~/.grok/hooks/*.json` (its native,
 * always-trusted dir), spawning each with a restricted PATH. A bundled plugin
 * was tried first but does NOT work: its `.mcp.json` is lower priority and a
 * bare `o2b` command is not on grok's session-spawn PATH (ENOENT, zero tools),
 * and plugin-provided hooks are not discovered in-session. So this adapter:
 *
 *   - writes the two Open Second Brain servers into `~/.grok/config.toml`
 *     with an absolute command (`bun run <repo>/src/cli/main.ts mcp …`);
 *   - writes the lifecycle hooks into `~/.grok/hooks/open-second-brain.json`
 *     with absolute bun commands.
 *
 * Both are grok-native sources (not Claude-compat). `GROK_HOME` overrides the
 * `~/.grok` base dir.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { UnsupportedPlatformError } from "../../config.ts";
import type { InstallTargetId } from "../../runtime/host-facts.ts";
import { GROK_HOOKS_FILENAME, grokHooksJson, grokMcpServers } from "../grok-asset.ts";
import { hasMcpServers, removeMcpServers, upsertMcpServers } from "../grok-config.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../json-merge.ts";
import { readManifest, recordEntry, removeEntry } from "../manifest.ts";
import { payloadForHost } from "../payload-host.ts";
import { expectedPayloadFromEnv } from "../payload-equals.ts";
import { defaultRegistry } from "../registry.ts";
import { installSettingsSource, resolveInstallHookTimeoutSeconds } from "../settings.ts";
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
  SessionPathsResult,
} from "../types.ts";
import { sessionPathsFor } from "../session-paths.ts";

const TARGET: InstallTargetId = "grok";
const LABEL = "Grok Build";
const FIX_HINT = "o2b install --target grok --apply";
const SERVER_NAMES = [OSB_KEY_FULL, OSB_KEY_WRITER] as const;

function grokHome(env: InstallEnv): string {
  const override = env.env["GROK_HOME"];
  return override && override.length > 0 ? override : join(env.home, ".grok");
}

function configPath(env: InstallEnv): string {
  return join(grokHome(env), "config.toml");
}

function hooksPath(env: InstallEnv): string {
  return join(grokHome(env), "hooks", GROK_HOOKS_FILENAME);
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface DesiredState {
  readonly nextToml: string;
  readonly currentToml: string;
  readonly hooksContent: string;
  readonly currentHooks: string;
}

/**
 * The resolved `install.hook_timeout_seconds` for this env.
 *
 * Read on BOTH the apply and the verify path, from the same
 * `InstallEnv`, because verification here is re-construction: a value
 * only one of the two could see would make a fresh apply report drift.
 * An unreadable `<vault>/Brain/_brain.yaml` raises out of here rather
 * than resolving the default - the refusal this generator owes an
 * operator whose settings exist and are not in force.
 */
function hookTimeoutSeconds(env: InstallEnv): number {
  return resolveInstallHookTimeoutSeconds(installSettingsSource(env)).value;
}

/** Compute the target config.toml + hooks content for the current env/payload. */
function desired(rawPayload: McpPayload, env: InstallEnv): DesiredState {
  const currentToml = readFileOrEmpty(configPath(env));
  const currentHooks = readFileOrEmpty(hooksPath(env));
  // The same host transform `syncState` re-computes from the env alone,
  // so an applied install is in sync with what verification expects.
  const payload = payloadForHost(TARGET, rawPayload, env);
  return {
    currentToml,
    nextToml: upsertMcpServers(currentToml, grokMcpServers(payload)),
    hooksContent: grokHooksJson(payload, hookTimeoutSeconds(env)),
    currentHooks,
  };
}

/** mcp = in sync when our tables are present verbatim; hooks = file matches. */
function syncState(env: InstallEnv): { mcpOk: boolean; hooksOk: boolean; anyPresent: boolean } {
  const toml = readFileOrEmpty(configPath(env));
  const hooks = readFileOrEmpty(hooksPath(env));
  const payload = expectedPayloadFromEnv(env, TARGET);
  const mcpOk = hasMcpServers(toml, grokMcpServers(payload));
  const hooksOk = hooks === grokHooksJson(payload, hookTimeoutSeconds(env));
  const anyMcp = SERVER_NAMES.some((n) => toml.includes(`[mcp_servers.${n}]`));
  return { mcpOk, hooksOk, anyPresent: anyMcp || hooks.length > 0 };
}

export const grokAdapter = {
  target: TARGET,
  label: LABEL,

  /**
   * The status vocabulary has a member for "this machine is not one this
   * build has a layout for", and `detect` owes it rather than a throw.
   *
   * The reachable path to that condition is new: `syncState` resolves the
   * hook timeout, which resolves the machine-local config path, which
   * refuses on a platform with no `$HOME/.config` convention and no
   * operator override. Before this adapter read a setting, `detect` could
   * not fail that way; after it, an unsupported platform turned a
   * read-only status query into an exception that also took down
   * `detectAll`'s other nine targets.
   */
  detect(env: InstallEnv): DetectResult {
    let state: { mcpOk: boolean; hooksOk: boolean; anyPresent: boolean };
    try {
      state = syncState(env);
    } catch (exc) {
      if (exc instanceof UnsupportedPlatformError) {
        return {
          target: TARGET,
          status: "unsupported-on-this-platform",
          configPath: null,
          notes: [exc.message],
        };
      }
      throw exc;
    }
    const { mcpOk, hooksOk, anyPresent } = state;
    const status = !anyPresent ? "not-installed" : mcpOk && hooksOk ? "installed" : "drift";
    return { target: TARGET, status, configPath: configPath(env), notes: [] };
  },

  plan(payload: McpPayload, env: InstallEnv): InstallPlan {
    return {
      target: TARGET,
      steps: [
        {
          kind: "managed-block",
          path: configPath(env),
          preview: `register the open-second-brain MCP servers in ${configPath(env)} (absolute bun command)`,
        },
        {
          kind: "file-copy",
          path: hooksPath(env),
          preview: `write the lifecycle hooks to ${hooksPath(env)}`,
        },
      ],
      postNotes: [
        "grok loads the MCP servers and hooks on the next session start (or press r in the /mcps and /hooks modals).",
      ],
    };
  },

  apply(_plan: InstallPlan, payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const state = desired(payload, env);
    const entry: ManifestEntry = {
      target: TARGET,
      applied_at: env.now.toISOString(),
      operation: "managed-block",
      config_path: configPath(env),
      owned_keys: [...SERVER_NAMES],
      owned_paths: [hooksPath(env)],
    };
    if (opts.dryRun) {
      return { target: TARGET, manifest: entry, steps_executed: 0 };
    }

    let steps = 0;
    if (state.nextToml !== state.currentToml) {
      const cfg = configPath(env);
      if (!existsSync(dirname(cfg))) mkdirSync(dirname(cfg), { recursive: true });
      atomicWriteFileSync(cfg, state.nextToml);
      steps += 1;
    }
    if (state.hooksContent !== state.currentHooks) {
      const hp = hooksPath(env);
      if (!existsSync(dirname(hp))) mkdirSync(dirname(hp), { recursive: true });
      atomicWriteFileSync(hp, state.hooksContent);
      steps += 1;
    }
    recordEntry(env.vault, entry);
    return { target: TARGET, manifest: entry, steps_executed: steps };
  },

  verify(env: InstallEnv): VerifyResult {
    const installed = TARGET in readManifest(env.vault).installs;
    const { mcpOk, hooksOk, anyPresent } = syncState(env);
    if (!installed && !anyPresent) {
      return { target: TARGET, status: "not-installed", details: [], fix_hint: FIX_HINT };
    }
    const details: string[] = [];
    if (!mcpOk) details.push(`config.toml is missing or differs from the canonical MCP servers`);
    if (!hooksOk) details.push(`${hooksPath(env)} is missing or differs from the bundled hooks`);
    if (details.length > 0) {
      return { target: TARGET, status: "drift", details, fix_hint: FIX_HINT };
    }
    return { target: TARGET, status: "ok", details: [], fix_hint: null };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const removedKeys: string[] = [];
    const removedPaths: string[] = [];
    const skipped: Array<readonly [string, string]> = [];

    const cfg = configPath(env);
    const currentToml = readFileOrEmpty(cfg);
    if (SERVER_NAMES.some((n) => currentToml.includes(`[mcp_servers.${n}]`))) {
      const next = removeMcpServers(currentToml, [...SERVER_NAMES]).replace(/\s*$/, "") + "\n";
      if (!opts.dryRun) atomicWriteFileSync(cfg, next === "\n" ? "" : next);
      removedKeys.push(...SERVER_NAMES);
    }

    const hp = hooksPath(env);
    if (existsSync(hp)) {
      try {
        if (!opts.dryRun) rmSync(hp, { force: true });
        removedPaths.push(hp);
      } catch (e) {
        skipped.push([hp, `could not remove: ${(e as Error).message}`]);
      }
    }

    if (!opts.dryRun && skipped.length === 0) removeEntry(env.vault, TARGET);
    return { target: TARGET, removed_keys: removedKeys, removed_paths: removedPaths, skipped };
  },

  /**
   * Where this runtime keeps session logs, from the one declaration.
   * `Grok persists one ACP update stream per session under $GROK_HOME/sessions/<encoded-cwd>/<id>/.`
   */
  sessionPaths(env: InstallEnv): SessionPathsResult | null {
    return sessionPathsFor(TARGET, env);
  },
};

defaultRegistry.register(grokAdapter);
