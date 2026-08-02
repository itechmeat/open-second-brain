/**
 * The prefix grammar of the write binding, and nothing else.
 *
 * This module IMPORTS NOTHING, deliberately. It is the cycle-safe home
 * shared by the two layers that must agree on what a declared prefix
 * means — the `_brain.yaml` block parser
 * (`brain/policy/blocks/write-binding.ts`) and the runtime matcher
 * (`./index.ts`) — in exactly the shape `vault-scope/defaults.ts`
 * already uses for the ignore-rule grammar.
 *
 * The split is load-bearing rather than tidy: the matcher reads the
 * configuration through `brain/policy.ts`, which reaches the block
 * parser, so a parser that imported the matcher would close a cycle and
 * make the initialisation order of both undefined.
 */

/**
 * The ONE separator this grammar knows. Declarations are POSIX, and so
 * is every path the matcher is handed: `inspectPath` returns its
 * segments joined with `/` on both platforms (on Windows it converts the
 * native separator first, on POSIX there is nothing to convert).
 *
 * A backslash is DELIBERATELY not a separator here. On POSIX it is an
 * ordinary filename character, so splitting on it made the matcher read
 * structure into a name: a binding on `Projects` admitted the literal
 * one-segment filename `Projects\evil.md`, which lands at the vault
 * ROOT. The caller-named write envelope
 * (`brain/notes/create-note.ts`, `assertHostPathSeparators`) refuses a
 * backslash-bearing path outright rather than reinterpreting it, so the
 * matcher never has to guess which reading the caller meant.
 */
const POSIX_SEP = "/";

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
  const segments: string[] = [];
  for (const segment of raw.split(POSIX_SEP)) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join(POSIX_SEP);
}

/**
 * Whether `relPath` lies at or under `prefix`, SEGMENT-WISE.
 *
 * Segment-wise is the whole point. A character-prefix test would let a
 * binding on `Projects` admit `ProjectsArchive/`, so the declaration
 * would silently cover a folder the operator never named.
 */
export function writeBindingPrefixCovers(prefix: string, relPath: string): boolean {
  const target = normaliseWriteBindingPrefix(relPath);
  if (target === prefix) return true;
  return target.startsWith(prefix + POSIX_SEP);
}
