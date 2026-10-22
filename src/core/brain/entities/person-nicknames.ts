/**
 * Reader for the operator-supplied person nickname map
 * (write-honesty-egress-consent, F3).
 *
 * `Brain/entities/person-nicknames.json` - a JSON object keyed by
 * nickname, whose values are the full person names the nickname can
 * stand for. Same `Brain/entities/` neighbourhood as the derived
 * lexicon artifact, but this file is OPERATOR data, never
 * machine-derived, so there is no schema-version/freshness envelope -
 * the whole document is the map.
 *
 * This module was moved here verbatim from
 * `src/core/search/entity-alias.ts`, which had taken it in for query
 * expansion (C2). The registry's derived lookup lane (C4) and the
 * doctor's collision scan (C5) need the same reader, and the brain
 * layer must not import from `src/core/search/` - so the reader lives
 * on the brain side, beside the derivation kernel it feeds, and the
 * search module re-exports it to keep its public surface identical.
 *
 * A MISSING file is not an error - it means the vault declares no
 * nickname data - but a present file that fails to parse or violates
 * the shape is an operator-data fault, and it surfaces by name; every
 * consumer decides its own posture toward it (search expansion degrades
 * to the identity expansion, read resolution degrades to exact-only,
 * the doctor's collision scan degrades to no derived collisions).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeEntityName } from "./canonical.ts";
import { EMPTY_PERSON_NICKNAME_MAP, type PersonNicknameMap } from "./person-variants.ts";

/**
 * Vault-relative home of the operator-supplied nickname map.
 */
export const PERSON_NICKNAMES_ARTIFACT_REL = join("Brain", "entities", "person-nicknames.json");

/**
 * Raised when `person-nicknames.json` exists but cannot be used. A
 * MISSING file is not an error - it means the vault declares no
 * nickname data - but a present file that fails to parse or violates
 * the shape is an operator-data fault, and it surfaces by name; every
 * consumer decides its own posture toward it (search expansion degrades
 * to the identity expansion, read resolution degrades to exact-only).
 */
export class PersonNicknameConfigError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`unreadable person nickname config at ${path}: ${detail}`);
    this.name = "PersonNicknameConfigError";
    this.path = path;
    this.detail = detail;
  }
}

/** True for the ENOENT family: the artifact is simply not there. */
function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * A position-only note from a JSON parser error, or a fixed sentence when
 * the runtime exposes no position.
 *
 * The parser's own message can quote the bytes it choked on, and this
 * detail reaches doctor output and logs, so the raw message never
 * travels: only a line or offset number - which says nothing about the
 * content - or the fixed sentence ever leaves here.
 */
function jsonPositionNote(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = /line (\d+)/i.exec(raw)?.[1];
  if (line !== undefined) return `parse failed at line ${line}`;
  const offset = /position (\d+)/i.exec(raw)?.[1];
  if (offset !== undefined) return `parse failed at offset ${offset}`;
  return "the parser reported a syntax error";
}

/**
 * Fold one parsed JSON document into the normalized nickname map the
 * derivation kernel consumes: keys and values are run through
 * `normalizeEntityName` (the comparison is post-normalization, exactly
 * like the label denylist), empty normalized forms are dropped, and
 * value lists are deduplicated. Malformed shapes surface through
 * {@link PersonNicknameConfigError}.
 */
function parsePersonNicknameDocument(text: string, path: string): PersonNicknameMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PersonNicknameConfigError(path, `not parseable JSON (${jsonPositionNote(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PersonNicknameConfigError(path, "expected a JSON object mapping nickname to names");
  }
  const out = new Map<string, string[]>();
  let entryIndex = 0;
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    entryIndex += 1;
    const key = normalizeEntityName(rawKey);
    if (!key) continue;
    // The detail names the entry's POSITION, never the key's text: a key
    // is a person's nickname, and this detail reaches doctor output and
    // logs - the same channel the parse-error path keeps position-only.
    const shapeDetail = `value of entry #${entryIndex} must be an array of names`;
    if (!Array.isArray(rawValue)) {
      throw new PersonNicknameConfigError(path, shapeDetail);
    }
    const values: string[] = [];
    for (const entry of rawValue) {
      if (typeof entry !== "string") {
        throw new PersonNicknameConfigError(path, shapeDetail);
      }
      const normalized = normalizeEntityName(entry);
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }
    if (values.length === 0) continue;
    // Two raw keys that normalize alike ("Bob" and "bob ") are one
    // nickname: the value lists MERGE, because a silent replace would
    // make the expansion depend on the JSON key order.
    const prior = out.get(key) ?? [];
    out.set(key, [...prior, ...values.filter((v) => !prior.includes(v))]);
  }
  return Object.freeze(
    new Map([...out].map(([key, values]) => [key, Object.freeze(values)] as const)),
  );
}

/**
 * Resolve the operator nickname map for `vault`. A missing file yields
 * the empty map (no nickname data declared); a present but unreadable
 * or malformed one throws {@link PersonNicknameConfigError}, so a
 * caller that must not guess can tell "none declared" from "declared
 * but unusable".
 */
export function resolvePersonNicknameMap(vault: string): PersonNicknameMap {
  const path = join(vault, PERSON_NICKNAMES_ARTIFACT_REL);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissingFileError(err)) return EMPTY_PERSON_NICKNAME_MAP;
    throw new PersonNicknameConfigError(path, `not readable (${String(err)})`);
  }
  return parsePersonNicknameDocument(text, path);
}
