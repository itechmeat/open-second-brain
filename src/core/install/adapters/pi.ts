/**
 * Pi adapter — skill symlink, no MCP.
 *
 * Pi (pi.dev / pi-mono) intentionally chose "CLI-tool + README + skill"
 * over MCP. For OSB this means: drop the `brain-memory` skill into
 * Pi's `~/.pi/skills/` directory as a symlink and let the agent
 * invoke `o2b brain *` CLI commands from there.
 *
 * Plugin-source resolution order:
 *   1. `opts.piSkillSource` (tests)
 *   2. `OSB_PLUGIN_ROOT` env var + `/skills/brain-memory`
 *   3. `import.meta.url` based — walks up to repo root
 *
 * Target-side resolution order:
 *   1. `opts.piSkillDir` → `<piSkillDir>/brain-memory`
 *   2. `PI_HOME` env var → `<PI_HOME>/skills/brain-memory`
 *   3. `~/.pi/skills/brain-memory`
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  type Stats,
} from "node:fs";

import {
  InstallError,
  type ApplyOpts,
  type ApplyResult,
  type DetectResult,
  type InstallAdapter,
  type InstallEnv,
  type InstallPlan,
  type ManifestEntry,
  type McpPayload,
  type UninstallResult,
  type VerifyResult,
} from "../types.ts";
import { recordEntry, readManifest, removeEntry } from "../manifest.ts";
import { defaultRegistry } from "../registry.ts";

const TARGET = "pi";
const LABEL = "Pi (pi.dev)";

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function resolveSourcePath(opts: ApplyOpts): string {
  if (opts.piSkillSource) return opts.piSkillSource;
  const envRoot = process.env["OSB_PLUGIN_ROOT"];
  if (envRoot) return join(envRoot, "skills", "brain-memory");
  return join(repoRoot(), "skills", "brain-memory");
}

function resolveTargetPath(env: InstallEnv, opts: ApplyOpts | { piSkillDir?: string }): string {
  if ("piSkillDir" in opts && opts.piSkillDir) {
    return join(opts.piSkillDir, "brain-memory");
  }
  const piHome = env.env["PI_HOME"];
  const base = piHome && piHome.length > 0 ? piHome : join(env.home, ".pi");
  return join(base, "skills", "brain-memory");
}

function targetPathFromEnvOnly(env: InstallEnv): string {
  const piHome = env.env["PI_HOME"];
  const base = piHome && piHome.length > 0 ? piHome : join(env.home, ".pi");
  return join(base, "skills", "brain-memory");
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p) as Stats;
  } catch {
    return null;
  }
}

function ensureParent(target: string): void {
  const parent = dirname(target);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

export const piAdapter: InstallAdapter = {
  target: TARGET,
  label: LABEL,

  detect(env: InstallEnv): DetectResult {
    const path = targetPathFromEnvOnly(env);
    const stat = lstatOrNull(path);
    if (stat === null) {
      return { target: TARGET, status: "not-installed", configPath: path, notes: [] };
    }
    if (!stat.isSymbolicLink()) {
      return {
        target: TARGET,
        status: "drift",
        configPath: path,
        notes: ["path exists but is not a symlink"],
      };
    }
    return { target: TARGET, status: "installed", configPath: path, notes: [] };
  },

  plan(_payload: McpPayload, env: InstallEnv): InstallPlan {
    const target = targetPathFromEnvOnly(env);
    return {
      target: TARGET,
      steps: [
        {
          kind: "symlink",
          path: target,
          preview: `symlink ${target} → <plugin>/skills/brain-memory`,
        },
      ],
      postNotes: ["Pi reads skills from its own skills directory; no MCP registration needed."],
    };
  },

  apply(_plan: InstallPlan, _payload: McpPayload, env: InstallEnv, opts: ApplyOpts): ApplyResult {
    const target = resolveTargetPath(env, opts);
    const source = resolveSourcePath(opts);

    if (!existsSync(source)) {
      throw new InstallError(
        `pi: skill source not found at ${source}; cannot create symlink`,
        TARGET,
        "config-missing",
        "verify the plugin checkout is intact",
      );
    }

    const stat = lstatOrNull(target);
    if (stat) {
      if (stat.isSymbolicLink()) {
        // Resolve the link target relative to the symlink's directory so
        // `current === source` holds for both absolute and relative link
        // targets (e.g. `../../skills/brain-memory`).
        const current = resolve(dirname(target), readlinkSync(target));
        const canonicalSource = resolve(source);
        if (current === canonicalSource) {
          const manifest = buildManifest(env, target);
          if (!opts.dryRun) recordEntry(env.vault, manifest);
          return { target: TARGET, manifest, steps_executed: 0 };
        }
        if (!opts.dryRun) rmSync(target, { force: true });
      } else {
        if (!opts.force) {
          throw new InstallError(
            `pi: target ${target} exists and is not a symlink; refusing to clobber`,
            TARGET,
            "user-modified-block",
            "re-run with --force to overwrite, or move the existing directory aside",
          );
        }
        if (!opts.dryRun) rmSync(target, { recursive: true, force: true });
      }
    }

    if (!opts.dryRun) {
      ensureParent(target);
      symlinkSync(source, target);
    }

    const manifest = buildManifest(env, target);
    if (!opts.dryRun) recordEntry(env.vault, manifest);
    return { target: TARGET, manifest, steps_executed: opts.dryRun ? 0 : 1 };
  },

  uninstall(env: InstallEnv, opts: ApplyOpts & { fromSnippet?: boolean }): UninstallResult {
    const stored = readManifest(env.vault).installs[TARGET];
    const skipped: Array<readonly [string, string]> = [];
    const removed_paths: string[] = [];

    const targets = stored?.owned_paths ?? [];
    if (targets.length === 0 && !opts.fromSnippet) {
      throw new InstallError(
        "pi: no install manifest entry found",
        TARGET,
        "manifest-missing",
        "o2b uninstall --target pi --apply --force-from-snippet",
      );
    }
    const list = targets.length > 0 ? targets : [targetPathFromEnvOnly(env)];

    for (const t of list) {
      const stat = lstatOrNull(t);
      if (!stat) {
        skipped.push([t, "not present"]);
        continue;
      }
      if (!stat.isSymbolicLink()) {
        skipped.push([t, "not a symlink — refusing to remove"]);
        continue;
      }
      if (!opts.dryRun) rmSync(t, { force: true });
      removed_paths.push(t);
    }
    if (!opts.dryRun) removeEntry(env.vault, TARGET);
    return { target: TARGET, removed_keys: [], removed_paths, skipped };
  },

  verify(env: InstallEnv): VerifyResult {
    const stored = readManifest(env.vault).installs[TARGET];
    if (!stored) {
      return {
        target: TARGET,
        status: "not-installed",
        details: ["no install manifest entry"],
        fix_hint: null,
      };
    }
    const path = stored.owned_paths?.[0] ?? targetPathFromEnvOnly(env);
    const stat = lstatOrNull(path);
    if (!stat || !stat.isSymbolicLink()) {
      return {
        target: TARGET,
        status: "drift",
        details: [stat ? `${path} is not a symlink` : `${path} not present`],
        fix_hint: "o2b install --target pi --apply",
      };
    }
    const linkTarget = readlinkSync(path);
    const resolvedTarget = resolve(dirname(path), linkTarget);
    if (!existsSync(resolvedTarget)) {
      return {
        target: TARGET,
        status: "drift",
        details: [`${path} → ${linkTarget} (target missing)`],
        fix_hint: "o2b install --target pi --apply",
      };
    }
    return {
      target: TARGET,
      status: "ok",
      details: [`${path} → ${linkTarget}`],
      fix_hint: null,
    };
  },
};

function buildManifest(env: InstallEnv, target: string): ManifestEntry {
  return {
    target: TARGET,
    applied_at: env.now.toISOString(),
    operation: "symlink",
    config_path: null,
    owned_paths: [target],
  };
}

defaultRegistry.register(piAdapter);
