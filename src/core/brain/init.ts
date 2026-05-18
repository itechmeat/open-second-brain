/**
 * Brain layer bootstrap.
 *
 * Creates the `<vault>/Brain/` directory tree, drops the default
 * `_brain.yaml`, and renders the two Markdown templates the agent reads
 * each session: `Brain/_BRAIN.md` (operating manual for the writable
 * layer) and `AI Wiki/_OPEN_SECOND_BRAIN.md` (Brain-first vault
 * overview that replaces the legacy file).
 *
 * Behaviour summary (design doc §15 Task 5, §12.1):
 *
 *   - Directory creation is idempotent.
 *   - `Brain/_brain.yaml` and `Brain/_BRAIN.md` are written on first
 *     run; subsequent runs without `force` skip them. `force: true`
 *     overwrites both.
 *   - `AI Wiki/_OPEN_SECOND_BRAIN.md` is **always** overwritten on every
 *     bootstrap, regardless of `force`. The design owner accepted this
 *     trade-off at near-zero current user count: the file is the
 *     instruction surface agents read first; stale copy hurts more
 *     than the (negligible) risk of overwriting a manual edit. The
 *     legacy file's prior content is not backed up.
 *   - Bootstrap refuses to run if the machine-level plugin config (the
 *     one `o2b init` writes) is missing, since callers must register
 *     the vault before any Brain operation. The error message names
 *     `o2b init` as the fix.
 *   - Every write is routed through {@link atomicWriteFileSync} so an
 *     interrupted run leaves either the prior version or the new one,
 *     never a torn hybrid.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfigPath } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  brainConfigPath,
  brainDirs,
  brainManualPath,
  vaultRelative,
} from "./paths.ts";
import {
  DEFAULT_BRAIN_CONFIG_YAML,
  formatPrimaryAgentYamlValue,
} from "./policy.ts";
import {
  LEGACY_OVERVIEW_REL_PATH,
  renderBrainManual,
  renderLegacyOverview,
} from "./templates.ts";

const STARTER_TARGETS = ["preferences", "retired", "inbox", "log"] as const;

const DEFAULT_STARTER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "brain-starter",
);

export class BrainStarterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainStarterError";
  }
}

export interface CopyStarterOptions {
  /** Override the source directory; defaults to the bundled `templates/brain-starter/`. */
  readonly starterPath?: string;
}

export interface StarterBundleResult {
  /** Vault-relative paths newly written. */
  readonly copied: ReadonlyArray<string>;
}

/**
 * Copy the bundled starter set into `<vault>/Brain/`. Refuses when any
 * of `preferences/`, `retired/`, `inbox/`, `log/` already contains a
 * non-dotfile entry — the starter is for fresh vaults.
 *
 * Hidden files (those whose name starts with `.`) are ignored when
 * checking emptiness so a `.gitkeep`-style placeholder does not block
 * the copy.
 */
export function copyStarterBundle(
  vault: string,
  opts: CopyStarterOptions = {},
): StarterBundleResult {
  const src = opts.starterPath ?? DEFAULT_STARTER_DIR;
  try {
    if (!statSync(src).isDirectory()) {
      throw new BrainStarterError(
        `starter source is not a directory: ${src}`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrainStarterError(`starter source does not exist: ${src}`);
    }
    throw err;
  }
  for (const sub of STARTER_TARGETS) {
    const dir = join(vault, "Brain", sub);
    let entries;
    try {
      // `withFileTypes` returns Dirent objects so we avoid a `statSync`
      // per child entry — one syscall per directory instead of N+1.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BrainStarterError(
          `Brain/${sub} does not exist — run \`o2b brain init\` (without --starter) first`,
        );
      }
      throw err;
    }
    // "Non-empty" means anything the user (or a prior dream pass)
    // could have left here. The only acceptable non-dotfile entry
    // bootstrap places under a starter target is `inbox/processed/` —
    // we whitelist that one explicitly so a freshly initialised vault
    // does not trip the guard, but any other subdirectory (e.g. a
    // user-created `preferences/custom/`) counts as content and
    // refuses the starter.
    const hasUserContent = entries.some((e) => {
      if (e.name.startsWith(".")) return false;
      if (sub === "inbox" && e.isDirectory() && e.name === "processed") {
        return false;
      }
      return true;
    });
    if (hasUserContent) {
      throw new BrainStarterError(
        `Brain/${sub} already has content — \`--starter\` is intended for fresh vaults. `
          + `Inspect the bundle at ${src} and copy individual files manually if needed.`,
      );
    }
  }
  const copied: string[] = [];
  for (const sub of STARTER_TARGETS) {
    const srcDir = join(src, sub);
    if (!existsSync(srcDir)) continue;
    const destDir = join(vault, "Brain", sub);
    // Single recursive copy per subdir — orders of magnitude fewer
    // syscalls than file-by-file. The filter rejects dotfiles
    // (`.gitkeep`, `.DS_Store`) so the bundle stays focused on
    // Brain content. The pre-check above already guarantees the
    // destination is empty, so collisions are impossible.
    cpSync(srcDir, destDir, {
      recursive: true,
      filter: (p) => !basename(p).startsWith("."),
    });
    // Report from the source listing — bootstrapBrain may have left
    // sibling subdirs in the destination (e.g. `inbox/processed/`)
    // that we did not copy and should not surface as starter entries.
    for (const name of readdirSync(srcDir)) {
      if (name.startsWith(".")) continue;
      copied.push(join("Brain", sub, name));
    }
  }
  return Object.freeze({ copied });
}


export interface BootstrapBrainOptions {
  /** Overwrite `_brain.yaml` and `_BRAIN.md` if they already exist. */
  readonly force?: boolean;
  /**
   * Injection seam for deterministic tests. Currently unused in the
   * rendered output (templates carry static text), but reserved so
   * future timestamped substitutions stay test-friendly.
   */
  readonly now?: Date;
  /**
   * Override path of the machine-level plugin config. When unset, the
   * lookup chain in {@link defaultConfigPath} applies
   * (`OPEN_SECOND_BRAIN_CONFIG` env → XDG → `~/.config`).
   */
  readonly configPath?: string;
  /**
   * Optional primary-agent declaration for the vault. When provided on
   * a fresh init (or with `force`), the value is written into
   * `_brain.yaml.primary_agent`. On a re-run against an already
   * initialised `_brain.yaml` the value is ignored — use
   * `o2b brain set-primary` to mutate an existing config (it is
   * idempotent and won't disturb the rest of the file).
   */
  readonly primaryAgent?: string;
  /**
   * Drop the bundled starter set (8 preferences, 3 retired, 1 inbox
   * signal, 2 log days) into the freshly initialised `Brain/`.
   * Refuses to run if any of those subdirectories is non-empty;
   * `--starter` is for first-init only.
   */
  readonly starter?: boolean;
  /** Override the starter source path (defaults to bundled). */
  readonly starterPath?: string;
}

export interface BootstrapBrainResult {
  /** Vault-relative paths newly written. */
  readonly created: ReadonlyArray<string>;
  /** Vault-relative paths whose existing content was replaced. */
  readonly overwritten: ReadonlyArray<string>;
  /** Vault-relative paths left untouched because they already existed. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Bootstrap `<vault>/Brain/` and the legacy-overview replacement.
 *
 * @throws Error when the machine-level plugin config does not exist;
 *   the message names `o2b init` as the fix and the CLI surfaces it
 *   as exit code 1.
 */
export function bootstrapBrain(
  vault: string,
  opts: BootstrapBrainOptions = {},
): BootstrapBrainResult {
  const force = opts.force ?? false;
  const configPath = opts.configPath ?? defaultConfigPath();

  // Refuse to run before the vault has been registered. The machine
  // config carries the `vault:` field every subsequent `o2b brain *`
  // command relies on; bootstrapping without it would leave the user
  // with a half-wired install that fails on the first invocation
  // with a confusing "vault not configured" error far from the cause.
  if (!existsSync(configPath)) {
    throw new Error(
      `open-second-brain plugin config not found at ${configPath}; ` +
        "run `o2b init` first to register the vault",
    );
  }

  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];

  // 1. Directories. mkdirSync({ recursive: true }) is idempotent and
  //    does not throw on existing paths, so we do not track create
  //    counts for directories — only files end up in the report.
  const dirs = brainDirs(vault);
  for (const dir of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // 2. `_brain.yaml` — default config (with optional primary_agent).
  const brainYamlPath = brainConfigPath(vault);
  const brainYamlRel = vaultRelative(brainYamlPath, vault);
  const initialYaml = applyPrimaryAgentToYaml(
    DEFAULT_BRAIN_CONFIG_YAML,
    opts.primaryAgent,
  );
  if (existsSync(brainYamlPath)) {
    if (force) {
      atomicWriteFileSync(brainYamlPath, initialYaml);
      overwritten.push(brainYamlRel);
    } else {
      skipped.push(brainYamlRel);
    }
  } else {
    atomicWriteFileSync(brainYamlPath, initialYaml);
    created.push(brainYamlRel);
  }

  // 3. `Brain/_BRAIN.md` — operating manual rendered from template.
  const manualPath = brainManualPath(vault);
  const manualRel = vaultRelative(manualPath, vault);
  const manualBody = renderBrainManual(vault);
  if (existsSync(manualPath)) {
    if (force) {
      atomicWriteFileSync(manualPath, manualBody);
      overwritten.push(manualRel);
    } else {
      skipped.push(manualRel);
    }
  } else {
    atomicWriteFileSync(manualPath, manualBody);
    created.push(manualRel);
  }

  // 4. `AI Wiki/_OPEN_SECOND_BRAIN.md` — always overwritten. The
  //    parent directory may not exist if the caller never ran
  //    `o2b init` against this vault directly (e.g. they registered a
  //    different vault path in the machine config and ran Brain init
  //    elsewhere). We create it on demand: the file is meaningful even
  //    without the rest of `AI Wiki/`.
  const overviewPath = join(vault, LEGACY_OVERVIEW_REL_PATH);
  const overviewRel = LEGACY_OVERVIEW_REL_PATH;
  mkdirSync(dirname(overviewPath), { recursive: true });
  const overviewBody = renderLegacyOverview(vault);
  const overviewExisted = existsSync(overviewPath);
  atomicWriteFileSync(overviewPath, overviewBody);
  if (overviewExisted) {
    overwritten.push(overviewRel);
  } else {
    created.push(overviewRel);
  }

  if (opts.starter === true) {
    const starterResult = copyStarterBundle(vault, {
      starterPath: opts.starterPath,
    });
    created.push(...starterResult.copied);
  }

  return { created, overwritten, skipped };
}

/**
 * Replace the `primary_agent: null` line in the default `_brain.yaml`
 * body with the operator-supplied value, when provided. Trimmed,
 * empty-string-rejecting (the validator would catch that at load time,
 * but we fail loud here so an init that intended to declare a primary
 * does not silently fall back to `null`).
 *
 * The substitution is anchored on the literal `^primary_agent:` line
 * so re-running the helper against an already-customised YAML stays
 * idempotent for the relevant slot.
 */
function applyPrimaryAgentToYaml(
  yamlBody: string,
  primaryAgent: string | undefined,
): string {
  if (primaryAgent === undefined) return yamlBody;
  const line = `primary_agent: ${formatPrimaryAgentYamlValue(primaryAgent)}`;
  return yamlBody.replace(/^primary_agent:.*$/m, line);
}
