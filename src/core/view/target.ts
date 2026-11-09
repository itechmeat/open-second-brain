/**
 * Where the human view is written (spec `human-view` "Configurable
 * target"): a folder inside the vault, any other folder, or none.
 *
 * The target comes from `OPEN_SECOND_BRAIN_VIEW_TARGET`, then the
 * `view_target` machine-config key; with neither there is no view, and
 * every brain operation still works. It is device-local config because a
 * folder path differs per machine, and only the view writer reads it. A
 * relative config value anchors to the config file's directory, the way
 * `store_root` does.
 *
 * A target inside the store root is refused: the store holds records
 * only, and a page written into a synced partition would reach every
 * machine as a file the readers do not know. The vault is a valid target,
 * except its `Brain/` tree. Paths are built with the rules of the
 * source's platform, so a resolver handed another platform's source
 * answers as that platform would.
 */

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { defaultConfigPath, discoverConfig } from "../config.ts";
import { BRAIN_ROOT_REL } from "../brain/path-constants.ts";
import { isPathInsideResolved } from "../store/store-paths.ts";
import { VIEW_TARGET_CONFIG_KEY, VIEW_TARGET_ENV } from "./constants.ts";

export type ViewTargetOrigin = "env" | "config";

export interface ViewTarget {
  readonly dir: string;
  readonly origin: ViewTargetOrigin;
}

/** A configured view folder the view writer cannot use. */
export class ViewTargetError extends Error {
  /** The refused folder and the setting that named it. */
  readonly target: { readonly path: string; readonly origin: ViewTargetOrigin };
  constructor(message: string, target: { path: string; origin: ViewTargetOrigin }) {
    super(message);
    this.target = target;
    this.name = "ViewTargetError";
  }
}

/** What the target is resolved from: the environment, the home folder and the machine config. */
export interface ViewTargetSource {
  readonly platform: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Parsed machine config (`key: value`). */
  readonly config: Readonly<Record<string, string>>;
  /** Path of the machine config file; a relative value anchors to its directory. */
  readonly configPath: string;
}

/** The path rules of the source's platform, not the host's (as `store-paths.ts` does). */
function pathsFor(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function expandHome(value: string, source: ViewTargetSource): string {
  if (value === "~") return source.home;
  if (value.startsWith("~/") || (source.platform === "win32" && value.startsWith("~\\"))) {
    return pathsFor(source.platform).join(source.home, value.slice(2));
  }
  return value;
}

function settingName(origin: ViewTargetOrigin): string {
  return origin === "env"
    ? `the ${VIEW_TARGET_ENV} environment variable`
    : `\`${VIEW_TARGET_CONFIG_KEY}\` in the machine config`;
}

/**
 * The view folder `source` names, without checking it: `null` when none
 * is configured. {@link resolveViewTargetFrom} adds the store check.
 */
export function configuredViewTarget(source: ViewTargetSource): ViewTarget | null {
  const paths = pathsFor(source.platform);
  const env = source.env[VIEW_TARGET_ENV]?.trim();
  if (env) return { dir: paths.resolve(expandHome(env, source)), origin: "env" };
  const configured = source.config[VIEW_TARGET_CONFIG_KEY]?.trim();
  if (!configured) return null;
  const expanded = expandHome(configured, source);
  return {
    dir: paths.isAbsolute(expanded)
      ? paths.normalize(expanded)
      : paths.resolve(paths.dirname(source.configPath), expanded),
    origin: "config",
  };
}

/**
 * The view folder `source` names, or `null` when none is configured.
 * Throws {@link ViewTargetError} when it lies inside the store root, or
 * inside the `Brain/` tree of `vault`: a switched machine writes no byte
 * there, and the migration and the removal scan it.
 */
export function resolveViewTargetFrom(
  source: ViewTargetSource,
  storeRoot: string,
  vault: string | null = null,
): ViewTarget | null {
  const target = configuredViewTarget(source);
  if (target === null) return null;
  if (
    vault !== null &&
    isPathInsideResolved(
      target.dir,
      pathsFor(source.platform).join(vault, BRAIN_ROOT_REL),
      source.platform,
    )
  ) {
    throw new ViewTargetError(
      `the human view folder ${target.dir} (from ${settingName(target.origin)}) is inside the ` +
        `vault's ${BRAIN_ROOT_REL}/ tree, which belongs to the brain. Point the view at another ` +
        `folder of the vault, outside ${BRAIN_ROOT_REL}/`,
      { path: target.dir, origin: target.origin },
    );
  }
  if (isPathInsideResolved(target.dir, storeRoot, source.platform)) {
    throw new ViewTargetError(
      `the human view folder ${target.dir} (from ${settingName(target.origin)}) is inside the ` +
        `brain store ${storeRoot}; the store holds records only. Point the view at a folder ` +
        "outside the store, for example one inside the vault",
      { path: target.dir, origin: target.origin },
    );
  }
  return target;
}

/** {@link resolveViewTargetFrom} for this process and the machine config at `configPath`. */
export function resolveViewTarget(
  storeRoot: string,
  configPath?: string,
  vault: string | null = null,
): ViewTarget | null {
  const path = configPath ?? defaultConfigPath();
  return resolveViewTargetFrom(
    {
      platform: process.platform,
      home: homedir(),
      env: process.env,
      config: discoverConfig(path).data,
      configPath: path,
    },
    storeRoot,
    vault,
  );
}

/**
 * The view folder this process and the machine config at `configPath`
 * name, without the store check: what a caller-facing redaction needs to
 * recognise the folder as a host path. `null` when none is configured.
 */
export function configuredViewTargetDir(configPath?: string): string | null {
  const path = configPath ?? defaultConfigPath();
  return (
    configuredViewTarget({
      platform: process.platform,
      home: homedir(),
      env: process.env,
      config: discoverConfig(path).data,
      configPath: path,
    })?.dir ?? null
  );
}
