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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import type { BrainConfig } from "./types.ts";
import { DEFAULT_BRAIN_CONFIG } from "./policy.ts";

// Resolve template paths relative to this source file. `import.meta.url`
// is stable under both `bun run` (TS source) and any future build that
// keeps the template files alongside the bundled JS.
const TEMPLATE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "templates",
);

const BRAIN_MANUAL_TEMPLATE_PATH = join(TEMPLATE_DIR, "_BRAIN.md.tpl");
const LEGACY_OVERVIEW_TEMPLATE_PATH = join(
  TEMPLATE_DIR,
  "_OPEN_SECOND_BRAIN.md.tpl",
);

/** Vault-relative target for the legacy-overview replacement. */
const LEGACY_OVERVIEW_REL_PATH = join("AI Wiki", "_OPEN_SECOND_BRAIN.md");

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
  const manualBody = renderTemplate(
    readTemplate(BRAIN_MANUAL_TEMPLATE_PATH),
    buildSubstitutions(vault, DEFAULT_BRAIN_CONFIG),
  );
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
  const overviewBody = renderTemplate(
    readTemplate(LEGACY_OVERVIEW_TEMPLATE_PATH),
    buildSubstitutions(vault, DEFAULT_BRAIN_CONFIG),
  );
  const overviewExisted = existsSync(overviewPath);
  atomicWriteFileSync(overviewPath, overviewBody);
  if (overviewExisted) {
    overwritten.push(overviewRel);
  } else {
    created.push(overviewRel);
  }

  return { created, overwritten, skipped };
}

/**
 * Read a template file from disk. Wrapped so a missing template (which
 * would indicate a broken build / packaging) surfaces with a clear
 * pointer rather than the bare `ENOENT` Node throws.
 */
function readTemplate(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load Brain template at ${path}: ${message}. ` +
        "This indicates a broken open-second-brain install — the " +
        "src/core/brain/templates/ directory must ship alongside init.ts.",
    );
  }
}

/**
 * Compute `{{key}}` substitutions for the current vault. Kept tiny on
 * purpose: the templates carry static prose and only need to thread a
 * couple of contextual values (vault name, schema version). Adding more
 * substitutions later is a one-line change here.
 */
function buildSubstitutions(
  vault: string,
  config: BrainConfig,
): ReadonlyMap<string, string> {
  return new Map<string, string>([
    ["vault_name", vaultDisplayName(vault)],
    ["schema_version", String(config.schema_version)],
  ]);
}

/**
 * Apply `{{key}}` substitutions to `template`. Unknown placeholders are
 * left intact so a typo surfaces in the rendered file (and in the
 * line-count test) rather than disappearing silently.
 */
function renderTemplate(
  template: string,
  substitutions: ReadonlyMap<string, string>,
): string {
  let out = template;
  for (const [key, value] of substitutions) {
    // Escape regex metachars in the key in case future keys carry
    // anything other than `[a-z_]`. Today they don't; defensive anyway.
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g");
    out = out.replace(pattern, value);
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Best-effort display name for the vault: the trailing directory name
 * with separators stripped. Falls back to the literal `Second Brain`
 * if the vault path has no usable basename.
 */
function vaultDisplayName(vault: string): string {
  const parts = vault.split(/[\\/]/).filter((p) => p.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1]! : "";
  return last !== "" ? last : "Second Brain";
}
