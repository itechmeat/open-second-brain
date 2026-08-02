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
 * else the literal `agent`, and ten MCP tool families additionally
 * accept a caller-supplied `agent` string that overrides it, taken
 * verbatim after a placeholder check. A caller who can call the tool can
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
 */

import { existsSync } from "node:fs";

import { brainConfigPath } from "../brain/paths.ts";
import { requireNextStep } from "../brain/next-step.ts";
import { loadBrainConfig } from "../brain/policy.ts";
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
  /** The vault-relative target that was refused. */
  readonly relPath: string;
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
 * boundary they declared.
 */
export function resolveWriteBinding(vault: string): WriteBinding | null {
  if (!existsSync(brainConfigPath(vault))) return null;
  const declared = loadBrainConfig(vault).write_binding?.path_prefixes;
  if (declared === undefined || declared.length === 0) return null;
  return Object.freeze({ pathPrefixes: Object.freeze([...declared]) });
}

/** Whether `binding` admits the vault-relative `relPath`. */
export function writeBindingAdmits(binding: WriteBinding, relPath: string): boolean {
  return binding.pathPrefixes.some((prefix) => writeBindingPrefixCovers(prefix, relPath));
}

/**
 * The refusal for a caller-named write to `relPath`, or `null` when the
 * write is admitted — including when no binding is declared at all.
 *
 * Takes no identity, by construction. See the module docblock for why a
 * fence keyed to the caller's claimed name would fence nothing.
 */
export function checkWriteBinding(vault: string, relPath: string): WriteBindingRefusal | null {
  const binding = resolveWriteBinding(vault);
  if (binding === null) return null;
  if (writeBindingAdmits(binding, relPath)) return null;
  return writeBindingRefusal(binding, relPath);
}

/** Build the refusal record for a target the binding does not admit. */
export function writeBindingRefusal(binding: WriteBinding, relPath: string): WriteBindingRefusal {
  const normalised = normaliseWriteBindingPrefix(relPath);
  const prefixes = binding.pathPrefixes.join(PREFIX_LIST_SEPARATOR);
  return Object.freeze({
    code: WRITE_BINDING_REFUSED_CODE,
    relPath: normalised,
    pathPrefixes: binding.pathPrefixes,
    nextCommand: REFUSED_EXIT,
    message:
      `${normalised} is outside the write binding declared in Brain/_brain.yaml ` +
      `(write_binding.path_prefixes: ${prefixes}); ${REFUSED_EXIT}`,
  });
}
