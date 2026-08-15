/**
 * The prefix grammar of the write binding, and nothing else.
 *
 * This module is the cycle-safe home shared by the two layers that must
 * agree on what a declared prefix means — the `_brain.yaml` block parser
 * (`brain/policy/blocks/write-binding.ts`) and the runtime matcher
 * (`./index.ts`).
 *
 * The split is load-bearing rather than tidy: the matcher reads the
 * configuration through `brain/policy.ts`, which reaches the block
 * parser, so a parser that imported the matcher would close a cycle and
 * make the initialisation order of both undefined.
 *
 * It imports exactly one module, `vault-scope/defaults.ts`, and that is
 * the only import it may ever grow: that leaf reaches nothing but the
 * path constants, so it cannot reach `brain/policy.ts` and cannot close
 * the loop this file exists to prevent. The rules the grammar is built
 * on — POSIX separators, segment-wise coverage — are not specific to
 * write bindings, and this module carried the only copy that ever
 * explained them while four other modules re-derived them in silence.
 */

import { normalisePathSegments, pathCovers } from "../vault-scope/defaults.ts";

/**
 * Canonical form of one declared prefix: no `./` segments, no repeated
 * or trailing slashes.
 *
 * Returns the empty string for a declaration that carries no segments at
 * all (`.`, `/`, `///`). That is not a usable prefix — it would admit
 * the whole vault — and the block parser refuses it rather than letting
 * a typo silently widen the boundary.
 */
export function normaliseWriteBindingPrefix(raw: string): string {
  return normalisePathSegments(raw);
}

/**
 * Whether `relPath` lies at or under a declared binding `prefix`.
 *
 * Segment-wise, via the shared predicate: a character-prefix test would
 * let a binding on `Projects` admit `ProjectsArchive/`, so the
 * declaration would silently cover a folder the operator never named.
 * The block parser normalises every declared prefix, which is the
 * precondition {@link pathCovers} states.
 */
export function writeBindingPrefixCovers(prefix: string, relPath: string): boolean {
  return pathCovers(prefix, relPath);
}
