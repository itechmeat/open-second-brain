/**
 * Brain layer bootstrap.
 *
 * Creates the `<vault>/Brain/` directory tree, drops the default
 * `_brain.yaml`, and renders the operating manual the agent reads each
 * session at `Brain/_BRAIN.md`.
 *
 * Behaviour summary:
 *
 *   - Directory creation is idempotent.
 *   - `Brain/_brain.yaml` and `Brain/_BRAIN.md` are written on first
 *     run; subsequent runs without `force` skip them. `force: true`
 *     overwrites both.
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
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfigPath } from "../config.ts";
import { atomicWriteFileSync } from "../fs-atomic.ts";
import {
  BRAIN_BASES_REL,
  BRAIN_ROOT_REL,
  brainConfigPath,
  brainDirs,
  brainManualPath,
  vaultRelative,
} from "./paths.ts";
import { vaultIdentityPath, writeVaultIdentity } from "./vault-identity.ts";
import { formatPrimaryAgentYamlValue } from "./policy.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "./config-template.ts";
import { BASE_TEMPLATE_FILES, BASES_TEMPLATE_DIR, renderBrainManual } from "./templates.ts";

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
  /**
   * Instant the dropped bundle is aged to; defaults to the wall clock.
   * Passing the bundle's own anchor day reproduces the source bytes
   * exactly, which is what the fixed-`--now` tests rely on.
   */
  readonly now?: Date;
}

const DAY_MS = 86_400_000;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/**
 * The bundle's authored "today": the newest day in its `log/`.
 *
 * Read from the bundle rather than declared next to it, because a
 * constant here is one the next person to extend the log has to
 * remember to move, and nothing would fail if they did not.
 * Returns null for a bundle with no dated log day - a custom
 * `starterPath` in a test, typically - and such a bundle is copied
 * verbatim.
 */
function starterAnchorDay(src: string): string | null {
  let newest: string | null = null;
  let entries: string[];
  try {
    entries = readdirSync(join(src, "log"));
  } catch {
    return null;
  }
  for (const name of entries) {
    const day = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1];
    if (day !== undefined && (newest === null || day > newest)) newest = day;
  }
  return newest;
}

function shiftDay(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * Age one copied entry in place, descending into it when it is a
 * directory. The copy above is recursive, so a custom `starterPath` may
 * put a subtree under a starter target and reading it as a file would
 * fail the whole install with `EISDIR`. Only Markdown bodies are
 * rewritten - a starter target holds Brain notes, and a bundle that
 * smuggled a binary in should come back out with its bytes intact.
 */
function ageStarterEntry(abs: string, days: number): void {
  if (statSync(abs).isDirectory()) {
    for (const child of readdirSync(abs)) {
      const childAbs = join(abs, child);
      ageStarterEntry(childAbs, days);
      const moved = child.replace(DATE_RE, (d) => shiftDay(d, days));
      if (moved !== child) renameSync(childAbs, join(abs, moved));
    }
    return;
  }
  if (!abs.endsWith(".md")) return;
  atomicWriteFileSync(
    abs,
    readFileSync(abs, "utf8").replace(DATE_RE, (d) => shiftDay(d, days)),
  );
}

/**
 * Age the copied bundle so its history ends on the day it was dropped.
 *
 * The bundle carries a fictional five-day history with fixed dates, and
 * one of its preferences is `pinned`. Left as authored, that pin passed
 * `stale_evidence_days` ninety days after the bundle was written and
 * every vault initialised after that woke up with a doctor warning on
 * its first run - a bundle that is only clean for one quarter is not a
 * starting point. Every date moves by the same whole number of days, so
 * every interval the bundle demonstrates - the trial window still open,
 * the evidence two days back, the retired entries months behind -
 * survives the move exactly.
 */
function ageStarterCopy(
  vault: string,
  copied: ReadonlyArray<string>,
  days: number,
): ReadonlyArray<string> {
  if (days === 0) return copied;
  const renamed: string[] = [];
  for (const rel of copied) {
    const abs = join(vault, rel);
    ageStarterEntry(abs, days);
    const name = basename(rel);
    const moved = name.replace(DATE_RE, (d) => shiftDay(d, days));
    if (moved === name) {
      renamed.push(rel);
      continue;
    }
    const target = join(dirname(rel), moved);
    renameSync(abs, join(vault, target));
    renamed.push(target);
  }
  return Object.freeze(renamed);
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
      throw new BrainStarterError(`starter source is not a directory: ${src}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrainStarterError(`starter source does not exist: ${src}`);
    }
    throw err;
  }
  for (const sub of STARTER_TARGETS) {
    const dir = join(vault, BRAIN_ROOT_REL, sub);
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
        `Brain/${sub} already has content — \`--starter\` is intended for fresh vaults. ` +
          `Inspect the bundle at ${src} and copy individual files manually if needed.`,
      );
    }
  }
  const copied: string[] = [];
  for (const sub of STARTER_TARGETS) {
    const srcDir = join(src, sub);
    if (!existsSync(srcDir)) continue;
    const destDir = join(vault, BRAIN_ROOT_REL, sub);
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
      copied.push(join(BRAIN_ROOT_REL, sub, name));
    }
  }
  const anchor = starterAnchorDay(src);
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const days =
    anchor === null
      ? 0
      : Math.round(
          (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${anchor}T00:00:00Z`).getTime()) /
            DAY_MS,
        );
  return Object.freeze({ copied: ageStarterCopy(vault, copied, days) });
}

export interface BootstrapBrainOptions {
  /** Overwrite `_brain.yaml` and `_BRAIN.md` if they already exist. */
  readonly force?: boolean;
  /**
   * Injection seam for deterministic tests. The rendered `_brain.yaml`
   * and `_BRAIN.md` carry static text and ignore it; `--starter` ages
   * the dropped bundle to this instant instead of the wall clock.
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
  //
  //    Enumerated from `brainDirs` rather than from a list repeated
  //    here: a hand-written list is how `pending` and `entities` came to
  //    be DECLARED by `brainDirs` and never created (their writers made
  //    them lazily, so a freshly-bootstrapped vault was missing two of
  //    the ten directories it advertises). Iterating the struct makes
  //    "declared but not created" unrepresentable.
  const dirs = brainDirs(vault);
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true });
  }

  // 1b. `Brain/vault-id.json` — the vault identity marker (Unit J). The
  //     bootstrap path is what legitimately creates a Brain tree, so it
  //     stamps the marker rather than being gated on it. Idempotent: a
  //     vault that already has an identity keeps it, since rotating the
  //     id would make every synced peer look like a different store.
  const identityPath = vaultIdentityPath(vault);
  const identityExisted = existsSync(identityPath);
  writeVaultIdentity(vault);
  if (!identityExisted) created.push(vaultRelative(identityPath, vault));

  // 2. `_brain.yaml` — default config (with optional primary_agent).
  const brainYamlPath = brainConfigPath(vault);
  const brainYamlRel = vaultRelative(brainYamlPath, vault);
  const initialYaml = applyPrimaryAgentToYaml(DEFAULT_BRAIN_CONFIG_YAML, opts.primaryAgent);
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

  // 4. `Brain/bases/*.base` — Obsidian Bases view definitions. Stamped
  //    like the operating manual (always, not opt-in): they are inert
  //    structural scaffolding, not example data. Each file is written
  //    only when absent unless `force` is set.
  const bases = stampBaseTemplates(vault, force);
  created.push(...bases.created);
  overwritten.push(...bases.overwritten);
  skipped.push(...bases.skipped);

  if (opts.starter === true) {
    const starterResult = copyStarterBundle(vault, {
      starterPath: opts.starterPath,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
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
function applyPrimaryAgentToYaml(yamlBody: string, primaryAgent: string | undefined): string {
  if (primaryAgent === undefined) return yamlBody;
  const line = `primary_agent: ${formatPrimaryAgentYamlValue(primaryAgent)}`;
  return yamlBody.replace(/^primary_agent:.*$/m, line);
}

interface StampResult {
  readonly created: string[];
  readonly overwritten: string[];
  readonly skipped: string[];
}

/**
 * Copy the bundled Obsidian Bases view definitions into
 * `Brain/bases/`. Each file is written only when absent; `force`
 * overwrites. Returns the per-file create/overwrite/skip breakdown in
 * the same vault-relative shape `bootstrapBrain` reports.
 *
 * The source assets ship under `src/core/brain/templates/bases/` so
 * they travel with the published `src/` tree (the `package.json`
 * `files` allowlist), unlike the opt-in `templates/brain-starter/`
 * bundle.
 */
function stampBaseTemplates(vault: string, force: boolean): StampResult {
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const name of BASE_TEMPLATE_FILES) {
    const body = readFileSync(join(BASES_TEMPLATE_DIR, name), "utf8");
    const dest = join(vault, BRAIN_BASES_REL, name);
    const rel = vaultRelative(dest, vault);
    if (existsSync(dest)) {
      if (force) {
        atomicWriteFileSync(dest, body);
        overwritten.push(rel);
      } else {
        skipped.push(rel);
      }
    } else {
      atomicWriteFileSync(dest, body);
      created.push(rel);
    }
  }
  return { created, overwritten, skipped };
}
