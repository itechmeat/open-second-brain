/**
 * The real per-user locations the real-home guard watches
 * (`tests/helpers/real-home-guard.ts`), resolved the way the product
 * resolves them (`src/core/platform-dirs.ts`, `src/core/install/adapters/`)
 * from an environment: each exported base and the home fallback beside it.
 */
import { posix, win32 } from "node:path";

/** Depth of Open Second Brain's own trees the guard follows. */
export const OWN_DEPTH = 6;
/** Depth of the host agents' homes the guard follows. */
export const HOST_DEPTH = 1;
const APP = "open-second-brain";

/**
 * The host agents' homes under the user's home: the ones `o2b install`
 * registers with (`src/core/install/adapters/`) and the ones session
 * imports read.
 */
const HOST_HOME_DIRS = [
  ".claude",
  ".codex",
  ".copilot",
  ".cursor",
  ".gemini",
  ".grok",
  ".hermes",
  ".kiro",
  ".openclaw",
  ".pi",
] as const;

/** The host agents' roots under the config base (`~/.config`). */
const HOST_CONFIG_DIRS = ["github-copilot", "opencode"] as const;

/** A tree the guard watches, rooted at `path`. */
export interface GuardRoot {
  readonly path: string;
  readonly depth: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/** `path.join` of the platform the locations are resolved for. */
function joinFor(platform: string): (...parts: string[]) => string {
  return platform === "win32" ? win32.join : posix.join;
}

const XDG_BASES = [
  ["XDG_CONFIG_HOME", [".config"]],
  ["XDG_DATA_HOME", [".local", "share"]],
  ["XDG_STATE_HOME", [".local", "state"]],
  ["XDG_CACHE_HOME", [".cache"]],
] as const;

/**
 * Every directory a per-user base can resolve to for `env`: the exported
 * value and the fallback a test reaches by clearing it.
 */
function baseCandidates(
  env: Env,
  home: string,
  platform: string,
  variable: (typeof XDG_BASES)[number][0],
  fallback: ReadonlyArray<string>,
): string[] {
  const j = joinFor(platform);
  const out: string[] = [];
  const exported = nonEmpty(env[variable]);
  if (exported) out.push(exported);
  if (platform === "win32") out.push(...localAppDataCandidates(env, home));
  else out.push(j(home, ...fallback));
  return out;
}

function localAppDataCandidates(env: Env, home: string): string[] {
  const out = [win32.join(home, "AppData", "Local")];
  const exported = nonEmpty(env["LOCALAPPDATA"]);
  if (exported) out.unshift(exported);
  return out;
}

function roamingAppDataCandidates(env: Env, home: string): string[] {
  const out = [win32.join(home, "AppData", "Roaming")];
  const exported = nonEmpty(env["APPDATA"]);
  if (exported) out.unshift(exported);
  return out;
}

/** The config bases (`~/.config`, an exported `XDG_CONFIG_HOME`) the host adapters fall back to. */
function hostConfigBases(env: Env, home: string, platform: string): string[] {
  const j = joinFor(platform);
  const out = [j(home, ".config")];
  const exported = nonEmpty(env["XDG_CONFIG_HOME"]);
  if (exported) out.unshift(exported);
  return out;
}

/** A host's home: its override variable when exported, and the default under the home. */
function hostHomes(
  env: Env,
  home: string,
  platform: string,
  dir: string,
  variable?: string,
): string[] {
  const j = joinFor(platform);
  const out = [j(home, dir)];
  const exported = variable ? nonEmpty(env[variable]) : null;
  if (exported) out.unshift(exported);
  return out;
}

/**
 * The folders below a host home's top level the product writes into
 * (`src/core/install/adapters/`, `src/core/install/ownership.ts`): the pi
 * skill, grok's hook file, the opencode plugin, Hermes' cron jobs, the
 * host-settings backups, and the CLI symlinks in `~/.local/bin`.
 */
export function hostWriteDirs(
  env: Env,
  home: string,
  platform: string = process.platform,
): GuardRoot[] {
  const j = joinFor(platform);
  const out: GuardRoot[] = [];
  for (const pi of hostHomes(env, home, platform, ".pi", "PI_HOME")) {
    out.push({ path: j(pi, "skills"), depth: 1 });
  }
  for (const grok of hostHomes(env, home, platform, ".grok", "GROK_HOME")) {
    out.push({ path: j(grok, "hooks"), depth: 1 });
  }
  for (const base of hostConfigBases(env, home, platform)) {
    out.push({ path: j(base, "opencode", "plugins"), depth: 1 });
  }
  out.push({ path: j(home, ".hermes", "cron"), depth: 1 });
  for (const claude of hostHomes(env, home, platform, ".claude", "CLAUDE_CONFIG_DIR")) {
    out.push({ path: j(claude, ".o2b-backups"), depth: 2 });
  }
  out.push({ path: j(home, ".local", "bin"), depth: 1 });
  return out;
}

/**
 * The homes the product can fall back to, from the environment the test
 * process started with and `osHome` (`os.homedir()`, which Bun fixes at
 * start). Most of the product resolves the home through `os.homedir()`,
 * which on Windows reads `USERPROFILE`, but a few readers take `HOME`
 * (`src/core/doctor-readiness.ts`, `src/core/brain/sessions/discover.ts`),
 * and a Windows shell can export a `HOME` that is another folder. So every
 * distinct one is watched: on Windows the profile first, then `HOME`; on
 * POSIX `HOME`, then `os.homedir()` should it differ.
 */
export function realHomes(env: Env, platform: string, osHome: string): string[] {
  const candidates =
    platform === "win32"
      ? [nonEmpty(env["USERPROFILE"]), osHome, nonEmpty(env["HOME"])]
      : [nonEmpty(env["HOME"]), osHome];
  const out: string[] = [];
  for (const home of candidates) {
    if (home && home.length > 0 && !out.includes(home)) out.push(home);
  }
  return out;
}

/** One tree once, at the deepest depth asked for it. */
export function dedupeRoots(roots: ReadonlyArray<GuardRoot>): GuardRoot[] {
  const byPath = new Map<string, GuardRoot>();
  for (const root of roots) {
    const seen = byPath.get(root.path);
    if (!seen || seen.depth < root.depth) byPath.set(root.path, root);
  }
  return [...byPath.values()];
}

/**
 * The real per-user locations for an environment, as the product resolves
 * them (`src/core/platform-dirs.ts`) plus the host agents' homes: each
 * exported base and the home fallback beside it. `home` is the home the
 * environment names (`HOME`, `USERPROFILE`).
 */
export function realHomeRoots(
  env: Env,
  home: string,
  platform: string = process.platform,
): GuardRoot[] {
  const j = joinFor(platform);
  const roots: GuardRoot[] = [];
  const own = (path: string | null): void => {
    if (path) roots.push({ path, depth: OWN_DEPTH });
  };
  const host = (path: string | null): void => {
    if (path) roots.push({ path, depth: HOST_DEPTH });
  };
  for (const [variable, fallback] of XDG_BASES) {
    for (const base of baseCandidates(env, home, platform, variable, fallback)) own(j(base, APP));
  }
  if (platform === "win32") {
    for (const base of localAppDataCandidates(env, home)) own(j(base, APP));
    for (const base of roamingAppDataCandidates(env, home)) own(j(base, APP));
  }
  own(nonEmpty(env["OPEN_SECOND_BRAIN_STORE_ROOT"]));
  const overrides: Readonly<Record<string, string>> = {
    ".claude": "CLAUDE_CONFIG_DIR",
    ".codex": "CODEX_HOME",
    ".grok": "GROK_HOME",
    ".pi": "PI_HOME",
  };
  for (const dir of HOST_HOME_DIRS) {
    for (const path of hostHomes(env, home, platform, dir, overrides[dir])) host(path);
  }
  for (const base of hostConfigBases(env, home, platform)) {
    for (const dir of HOST_CONFIG_DIRS) host(j(base, dir));
  }
  roots.push(...hostWriteDirs(env, home, platform));
  return dedupeRoots(roots);
}

/**
 * The small files the product edits in place, as the product resolves them:
 * the machine config and the profiles registry beside it, and each host's
 * config file `o2b install`, `o2b brain protect` or `o2b discipline
 * install` merges a block into. `~/.claude.json` is not among them: the
 * product never writes it, and a live Claude Code session rewrites it all
 * the time.
 */
export function realControlFiles(
  env: Env,
  home: string,
  platform: string = process.platform,
): string[] {
  const j = joinFor(platform);
  const files: string[] = [];
  const exportedConfig = nonEmpty(env["OPEN_SECOND_BRAIN_CONFIG"]);
  const configDirs: string[] = [];
  for (const base of baseCandidates(env, home, platform, "XDG_CONFIG_HOME", [".config"])) {
    configDirs.push(j(base, APP));
  }
  if (exportedConfig) files.push(exportedConfig, j(exportedConfig, "..", "profiles.json"));
  for (const dir of configDirs) files.push(j(dir, "config.yaml"), j(dir, "profiles.json"));
  for (const codex of hostHomes(env, home, platform, ".codex", "CODEX_HOME")) {
    files.push(j(codex, "config.toml"));
  }
  for (const grok of hostHomes(env, home, platform, ".grok", "GROK_HOME")) {
    files.push(j(grok, "config.toml"));
  }
  for (const claude of hostHomes(env, home, platform, ".claude", "CLAUDE_CONFIG_DIR")) {
    files.push(j(claude, "settings.json"));
  }
  files.push(
    j(home, ".gemini", "settings.json"),
    j(home, ".cursor", "mcp.json"),
    j(home, ".kiro", "settings.json"),
    j(home, ".aider.conf.yml"),
    j(home, ".hermes", "config.yaml"),
    nonEmpty(env["OSB_HERMES_JOBS"]) ?? j(home, ".hermes", "cron", "jobs.json"),
  );
  for (const base of hostConfigBases(env, home, platform)) {
    files.push(
      j(base, "github-copilot", "mcp.json"),
      j(base, "opencode", "opencode.json"),
      j(base, "opencode", "opencode.jsonc"),
      j(base, "opencode", "mcp.json"),
    );
  }
  return [...new Set(files.map((f) => (platform === "win32" ? win32 : posix).normalize(f)))];
}
