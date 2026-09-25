/**
 * Per-user base directories for the files this tool owns, per platform.
 *
 * One place answers "where does Open Second Brain keep its config, data,
 * state and cache, and where does `o2b install-cli` put its launchers", so
 * the config resolver, the session spools, the cron stamps and the install
 * surfaces cannot disagree about a path.
 *
 * POSIX (Linux, macOS, the BSDs): the XDG Base Directory layout, with the
 * `XDG_*_HOME` variables honoured and `$HOME/.config`, `$HOME/.local/share`,
 * `$HOME/.local/state`, `$HOME/.cache` as the defaults. macOS keeps the XDG
 * layout rather than `~/Library` because every existing install already
 * lives there.
 *
 * Windows: the `XDG_*_HOME` variables still win when set (an operator who
 * sets one has said where the files go), otherwise every root is
 * `%LOCALAPPDATA%` - the per-machine, non-roaming application-data root.
 * Local rather than Roaming because what lives here is machine-bound: the
 * vault path, the agent name (which carries the host), the search index
 * cursor, the session spools. A roaming profile carrying `vault:
 * D:\Vault` or `agent_name: claude-devbox-agent` to another machine would be
 * wrong there. Hermes Agent makes the same choice (`%LOCALAPPDATA%\hermes`).
 * Launchers go to `%USERPROFILE%\.local\bin`, the directory the native
 * Claude Code and uv installers already put on the user's PATH.
 *
 * Every function takes an injected {@link PlatformDirsEnv} so tests can
 * exercise any platform from any host; the zero-argument forms read the
 * running process.
 */

import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** Injected view of the environment the resolvers read. */
export interface PlatformDirsEnv {
  /** `process.platform` value. */
  readonly platform: string;
  /** `homedir()` value. */
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The directory name this tool uses under every base directory. */
export const APP_DIR_NAME = "open-second-brain";

/** The running process as a {@link PlatformDirsEnv}. */
export function processDirsEnv(): PlatformDirsEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** True on native Windows (not WSL, which reports `linux`). */
export function isWindows(source: Pick<PlatformDirsEnv, "platform"> = process): boolean {
  return source.platform === "win32";
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * `%LOCALAPPDATA%`, or `%USERPROFILE%\AppData\Local` when a stripped
 * environment (a service, a scheduled task with a minimal block) lacks it.
 */
export function windowsLocalAppData(source: PlatformDirsEnv): string {
  return nonEmpty(source.env["LOCALAPPDATA"]) ?? win32.join(source.home, "AppData", "Local");
}

/**
 * `%APPDATA%` (Roaming), or `%USERPROFILE%\AppData\Roaming` when unset.
 * Not used for this tool's own files; exposed for the hosts that keep
 * their state there (Cursor, VS Code).
 */
export function windowsRoamingAppData(source: PlatformDirsEnv): string {
  return nonEmpty(source.env["APPDATA"]) ?? win32.join(source.home, "AppData", "Roaming");
}

type BaseKind = "config" | "data" | "state" | "cache";

const XDG_VARIABLE: Readonly<Record<BaseKind, string>> = Object.freeze({
  config: "XDG_CONFIG_HOME",
  data: "XDG_DATA_HOME",
  state: "XDG_STATE_HOME",
  cache: "XDG_CACHE_HOME",
});

const POSIX_DEFAULT: Readonly<Record<BaseKind, ReadonlyArray<string>>> = Object.freeze({
  config: [".config"],
  data: [".local", "share"],
  state: [".local", "state"],
  cache: [".cache"],
});

function baseDir(kind: BaseKind, source: PlatformDirsEnv): string {
  const xdg = nonEmpty(source.env[XDG_VARIABLE[kind]]);
  if (xdg) return xdg;
  if (isWindows(source)) return windowsLocalAppData(source);
  return join(source.home, ...POSIX_DEFAULT[kind]);
}

/**
 * Base directory for user configuration: `$XDG_CONFIG_HOME`, else
 * `%LOCALAPPDATA%` on Windows, else `$HOME/.config`. Callers append
 * {@link APP_DIR_NAME} (or another tool's directory) themselves.
 */
export function configBaseDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return baseDir("config", source);
}

/** Base directory for user data (`$XDG_DATA_HOME` / `%LOCALAPPDATA%` / `~/.local/share`). */
export function dataBaseDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return baseDir("data", source);
}

/** Base directory for user state (`$XDG_STATE_HOME` / `%LOCALAPPDATA%` / `~/.local/state`). */
export function stateBaseDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return baseDir("state", source);
}

/** Base directory for user cache (`$XDG_CACHE_HOME` / `%LOCALAPPDATA%` / `~/.cache`). */
export function cacheBaseDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return baseDir("cache", source);
}

/**
 * Directory `o2b install-cli` publishes launchers into: `~/.local/bin` on
 * every platform (`%USERPROFILE%\.local\bin` on Windows).
 */
export function userBinDir(source: PlatformDirsEnv = processDirsEnv()): string {
  return join(source.home, ".local", "bin");
}

/**
 * The same directories written for humans, with the variables unexpanded:
 * what documentation and ownership listings print so the text is right on
 * the platform that reads it.
 */
export function describeBaseDir(kind: BaseKind, platform: string = process.platform): string {
  const xdg = XDG_VARIABLE[kind];
  if (platform === "win32") return `%${xdg}% if set, else %LOCALAPPDATA%`;
  return `\${${xdg}:-~/${POSIX_DEFAULT[kind].join("/")}}`;
}
