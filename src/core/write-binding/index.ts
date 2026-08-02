/**
 * The write binding — a config-declared boundary over CALLER-NAMED
 * write destinations (provenance-at-the-boundary, unit B).
 *
 * ## What this is, said precisely
 *
 * It is a WRITE BOUNDARY over the paths a caller names. It is NOT a
 * security boundary and it is NOT per-credential, and neither wording
 * belongs on any surface that reports it.
 *
 * There is no credential in this system to key a fence to. Agent
 * identity resolves as `VAULT_AGENT_NAME`, else the config `agent_name`,
 * else the literal `agent`, and twenty-two MCP tool schemas across
 * fifteen modules additionally accept a caller-supplied `agent` string
 * that overrides it, taken verbatim after a placeholder check. (Count it
 * with `grep -rn '^\s*agent:\s*{' src/mcp/`; it has only ever grown, and
 * understating it understates this argument.) A caller who can call the tool can
 * name itself anything, so a fence keyed to that name is bypassed by
 * passing a different string. The binding therefore reads NO identity at
 * all: its whole authority is `<vault>/Brain/_brain.yaml`, which the
 * operator controls and which no MCP call can rewrite.
 *
 * ## What it covers, and what it cannot
 *
 * Write destinations in this codebase split three ways, and only the
 * first admits a prefix boundary:
 *
 *   - CALLER-NAMED — `brain_create_note`, `brain_update_note`,
 *     `brain_append_note` and `brain_write_batch` take a vault-relative
 *     path from the caller. All four resolve it through one shared
 *     envelope (`resolveNoteTarget`), which is where this check runs.
 *   - SLUG-DERIVED — a signal, a preference, a dead end: the caller
 *     supplies a topic and the writer derives the filename.
 *   - FULLY DERIVED — daily logs, dream runs, continuity records and all
 *     telemetry compute their own destination.
 *
 * A prefix boundary over the last two could only refuse them wholesale,
 * which is an off switch rather than a boundary, so they are out of
 * scope and said so. `tests/core/architecture/write-site-census.test.ts`
 * is the standing record of every in-vault write site this does not
 * cover, so the gap is an asserted fact rather than a silent one.
 *
 * ## Absent is inert
 *
 * No block, or a block without `path_prefixes`, means no binding: every
 * write path behaves exactly as it did before the key existed, and
 * `tests/core/write-binding.test.ts` proves it by running all three
 * caller-named arms against a vault with no config and a vault whose
 * config omits the block and comparing the bytes.
 *
 * Inert means inert on the FAILURE paths too. A vault whose
 * `Brain/_brain.yaml` exists but does not validate raises here, and that
 * is not a new failure mode the binding introduced: the same shared
 * envelope already resolves the vault scope through the same loader one
 * step earlier, so a malformed config has always stopped every
 * caller-named write. What the envelope now guarantees is that the stop
 * is a TYPED refusal naming a vault-relative source and a registered
 * exit, on the binding arm and the scope arm alike.
 *
 * ## What the binding compares
 *
 * The REALPATH, not the name. A lexical comparison is not a boundary: one
 * symlinked directory under a declared prefix
 * (`Projects/link -> <vault>/Journal`) would turn `path_prefixes:
 * [Projects]` into "may write anywhere in the vault", and the success
 * payload would name a path that does not hold the bytes. Every check
 * therefore resolves the destination through the filesystem and requires
 * BOTH the name the caller gave and the place it resolves to to lie
 * under a declared prefix.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { brainConfigPath } from "../brain/paths.ts";
import { requireNextStep } from "../brain/next-step.ts";
import { loadBrainConfig } from "../brain/policy.ts";
import { toPosix } from "../path-safety.ts";
import { normaliseWriteBindingPrefix, writeBindingPrefixCovers } from "./prefix.ts";

export { normaliseWriteBindingPrefix, writeBindingPrefixCovers };

/**
 * Registry code the refusal resolves its forward pointer through. The
 * refusal NAMES no command of its own — the registry does, so the exit
 * is the same structural CLI string on every surface that reports it.
 */
export const WRITE_BINDING_REFUSED_CODE = "write-binding-refused";

/**
 * Resolved at module scope on purpose. A refusal whose value is telling
 * the operator where to look is meaningless without its exit, so an
 * unregistered code is registry drift and fails at import rather than
 * inside the very refusal it was meant to explain (see `next-step.ts`).
 */
const REFUSED_EXIT = requireNextStep(WRITE_BINDING_REFUSED_CODE).nextCommand;

/** The declared binding in force for one vault. Never empty when present. */
export interface WriteBinding {
  /**
   * Vault-relative POSIX prefixes, already normalised by the block
   * parser. A target is admitted when it equals one of these or lies
   * under it segment-wise.
   */
  readonly pathPrefixes: ReadonlyArray<string>;
}

/** A caller-named target the declared binding does not admit. */
export interface WriteBindingRefusal {
  /** Always {@link WRITE_BINDING_REFUSED_CODE}; carried so a surface can resolve it. */
  readonly code: string;
  /** The vault-relative target that was refused, as the caller named it. */
  readonly relPath: string;
  /**
   * Where that name actually resolves on disk, vault-relative — the path
   * that would have held the bytes. Equal to {@link relPath} in the
   * ordinary case; different when a symlinked directory component
   * redirects the write, which is the case a lexical check missed. Null
   * when the destination resolves outside the vault entirely, which is a
   * different answer from "somewhere else inside it".
   */
  readonly resolvedRelPath: string | null;
  /** The prefixes in force, so the operator sees what WOULD be admitted. */
  readonly pathPrefixes: ReadonlyArray<string>;
  /** The registered exit for {@link code}. */
  readonly nextCommand: string;
  /**
   * The refusal, composed HERE and only here. Call sites raise it in
   * whatever error type their surface already speaks; none of them
   * assembles a sentence, so the wording cannot drift between the four
   * tools that share the envelope.
   */
  readonly message: string;
}

/** Separator between prefixes when the refusal lists them. */
const PREFIX_LIST_SEPARATOR = ", ";

/** How the refusal names a destination that leaves the vault entirely. */
const OUTSIDE_VAULT_LABEL = "a location outside the vault";

/**
 * One resolved binding plus the identity of the config bytes it was read
 * from, so the answer can be reused for as long as those bytes are the
 * ones on disk.
 */
interface CachedBinding {
  readonly vault: string;
  readonly identity: string;
  readonly binding: WriteBinding | null;
}

/**
 * Single-slot memo over {@link resolveWriteBinding}.
 *
 * A write batch resolves its target through the shared envelope once per
 * operation, so without this the whole `_brain.yaml` was read, parsed and
 * revalidated N times for one atomic batch against one unchanging file.
 * One slot is the right size: the loop that pays the cost hits the same
 * vault every iteration.
 *
 * The key is the config file's own identity, never a clock — see
 * {@link brainConfigIdentity}. A file that changed by any of inode, size
 * or mtime misses, so a cached answer can never outlive the declaration
 * it came from.
 */
let cachedBinding: CachedBinding | null = null;

/**
 * Identity of the config bytes at `path`, or `null` when the file is
 * ABSENT. Absence and inability-to-examine are different answers: an
 * ENOENT is a vault that predates `_brain.yaml`, while a permission
 * error is a declaration that may exist and cannot be read, and
 * answering "no binding" for the latter would silently widen the
 * boundary. Only ENOENT becomes `null`; every other errno is raised.
 */
function brainConfigIdentity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The binding declared for `vault`, or `null` when none is.
 *
 * `null` is the absent result rather than an empty-prefix record because
 * the two are different answers: an empty record would have to be read
 * as "admits nothing", and the block parser refuses that declaration
 * precisely so it can never arrive here.
 *
 * A vault with no `_brain.yaml` is absent, not broken — existing vaults
 * predate the file. A config that is present but does not load raises,
 * matching `loadBrainConfig`: the operator's settings exist and are not
 * the ones in force, and answering "no binding" would silently widen the
 * boundary they declared. Callers on a caller-named write path translate
 * that raise into their own typed refusal rather than letting it surface
 * as an untyped fault.
 */
export function resolveWriteBinding(vault: string): WriteBinding | null {
  const configPath = brainConfigPath(vault);
  const identity = brainConfigIdentity(configPath);
  if (identity === null) return null;
  const hit = cachedBinding;
  if (hit !== null && hit.vault === vault && hit.identity === identity) return hit.binding;
  const declared = loadBrainConfig(vault).write_binding?.path_prefixes;
  const binding =
    declared === undefined || declared.length === 0
      ? null
      : Object.freeze({ pathPrefixes: Object.freeze([...declared]) });
  cachedBinding = Object.freeze({ vault, identity, binding });
  return binding;
}

/** Whether `binding` admits the vault-relative `relPath`. */
export function writeBindingAdmits(binding: WriteBinding, relPath: string): boolean {
  return binding.pathPrefixes.some((prefix) => writeBindingPrefixCovers(prefix, relPath));
}

/**
 * The realpath of `target`, resolving every symlink in the components
 * that exist and re-appending the components that do not yet.
 *
 * A write target is normally the LAST component and does not exist yet,
 * so `realpathSync` on it alone would only ever raise; what matters is
 * the directory chain above it, which does exist and is where a symlink
 * redirects the write. ENOENT walks one level up; any other errno is
 * raised, because a directory we cannot examine is not a directory we
 * know to be safe.
 */
function realpathOfDeepestExisting(target: string): string {
  try {
    return realpathSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    const parent = dirname(target);
    if (parent === target) return target;
    return join(realpathOfDeepestExisting(parent), basename(target));
  }
}

/**
 * Where `relPath` actually lands, as a vault-relative POSIX path, or
 * `null` when it lands outside the vault altogether.
 */
function resolveRealVaultRelative(vault: string, relPath: string): string | null {
  const realVault = realpathOfDeepestExisting(resolve(vault));
  const realTarget = realpathOfDeepestExisting(resolve(join(vault, relPath)));
  const rel = relative(realVault, realTarget);
  // `relative` emits the platform separator, so the "climbs out of the
  // root" test uses it too. An empty result means the target IS the
  // vault root, which is not a place a note can be written either.
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep)) return null;
  return toPosix(rel);
}

/**
 * The refusal for a caller-named write to `relPath`, or `null` when the
 * write is admitted — including when no binding is declared at all.
 *
 * Both the name and the destination must be admitted. The name alone is
 * not enough (a symlinked component redirects the bytes), and the
 * destination alone is not enough either (a caller must not be able to
 * name a path outside the binding and have it accepted because it
 * happens to resolve inside one).
 *
 * Takes no identity, by construction. See the module docblock for why a
 * fence keyed to the caller's claimed name would fence nothing.
 */
export function checkWriteBinding(vault: string, relPath: string): WriteBindingRefusal | null {
  const binding = resolveWriteBinding(vault);
  if (binding === null) return null;
  if (!writeBindingAdmits(binding, relPath)) return writeBindingRefusal(binding, relPath, relPath);
  const resolved = resolveRealVaultRelative(vault, relPath);
  if (resolved !== null && writeBindingAdmits(binding, resolved)) return null;
  return writeBindingRefusal(binding, relPath, resolved);
}

/**
 * Build the refusal record for a target the binding does not admit.
 *
 * `resolvedRelPath` is where the bytes would have gone; the message
 * names it beside the caller's own spelling whenever the two differ, so
 * an operator reading the refusal sees the redirection rather than
 * having to discover it.
 */
export function writeBindingRefusal(
  binding: WriteBinding,
  relPath: string,
  resolvedRelPath: string | null,
): WriteBindingRefusal {
  const normalised = normaliseWriteBindingPrefix(relPath);
  const prefixes = binding.pathPrefixes.join(PREFIX_LIST_SEPARATOR);
  const redirect =
    resolvedRelPath === normalised
      ? ""
      : ` (resolves to ${resolvedRelPath ?? OUTSIDE_VAULT_LABEL})`;
  return Object.freeze({
    code: WRITE_BINDING_REFUSED_CODE,
    relPath: normalised,
    resolvedRelPath,
    pathPrefixes: binding.pathPrefixes,
    nextCommand: REFUSED_EXIT,
    message:
      `${normalised}${redirect} is outside the write binding declared in Brain/_brain.yaml ` +
      `(write_binding.path_prefixes: ${prefixes}); ${REFUSED_EXIT}`,
  });
}
