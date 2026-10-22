/**
 * Preview-first restamp of informal privacy markers (write-honesty, F1).
 *
 * The read roots deny a remote read for a page saying `access: private`,
 * `confidentiality: secret` or `sensitivity: confidential` (see
 * `graph/privacy-markers.ts`), so those pages are already withheld from a
 * remote caller. What they do NOT carry is the formal `visibility:`
 * declaration, and every consumer that reads that key directly - derived
 * pages stamped through `strictestVisibility`, an export filtering on the
 * token, an operator auditing reservations - cannot see the claim.
 *
 * This verb makes the claim formal, and it does so the way the repair-verb
 * family already does (`authored-at-backfill.ts` is the template):
 *
 *   - DRY RUN BY DEFAULT. `planPrivacyMarkerRestamp` never writes; the
 *     caller opts into mutation with `{ apply: true }`.
 *   - ADDITIVE ONLY. The reserved token is unioned into `visibility:`.
 *     No key is removed, no declared token is dropped, and a page already
 *     carrying the reserved token is not a candidate at all.
 *   - IDEMPOTENT. A re-run over a restamped vault reports no candidates
 *     and writes nothing, byte for byte.
 *   - WRITE-GUARDED AT THE ENTRY POINT, ONLY WHEN THE CALL WILL WRITE.
 *     A preview is the operator's way to find out what is there, so it
 *     runs against a root the guard would refuse; an apply asserts
 *     `assertVaultIdentityForWrite` before touching the first file.
 *   - NO RE-EMBEDDING. Only frontmatter is edited; the body and the search
 *     index are untouched, and the index picks the change up on its next
 *     normal run.
 *
 * The scan is the vault walk every root shares (`listVaultPages`), so a
 * page the walk skips - `.git`, `.obsidian`, a generated `index.md` - is
 * not restamped here either. Paths in the result are vault-relative with
 * `/` separators, so a preview reads the same on every platform.
 */

import { join } from "node:path";

import { listVaultPages, parseFrontmatter, writeFrontmatterAtomic } from "../vault.ts";
import { vaultRelative } from "../path-safety.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN, normToken } from "../graph/visibility.ts";
import { hasPrivacyDenyMarker } from "../graph/privacy-markers.ts";
import type { FrontmatterMap } from "../types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** One page whose informal marker is not yet a formal reservation. */
export interface PrivacyMarkerRestampCandidate {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  /** The `visibility:` tokens the page would carry after the restamp. */
  readonly visibility: ReadonlyArray<string>;
  /** The frontmatter line those tokens render to, for a preview reader. */
  readonly visibilityLine: string;
}

export interface PrivacyMarkerRestampResult {
  /** Whether the run mutated files (`false` for a dry run). */
  readonly applied: boolean;
  /** Pages carrying an informal deny marker (candidates and stamped ones). */
  readonly scanned: number;
  /** Marker pages whose `visibility:` lacks the reserved token. */
  readonly candidates: ReadonlyArray<PrivacyMarkerRestampCandidate>;
  /** Files actually rewritten (0 on a dry run). */
  readonly updated: number;
}

export interface PrivacyMarkerRestampOptions {
  /**
   * When true, rewrite each candidate's frontmatter with the reserved
   * token unioned into `visibility:`. Default false - a pure preview.
   */
  readonly apply?: boolean;
}

/**
 * The page's declared `visibility:` tokens as WRITTEN: a string, or an
 * array, trimmed and with empty entries dropped. Unlike `pageVisibility`
 * this does not lower-case anything, because the restamp must not rewrite
 * a declared token's spelling on its way to adding one.
 */
function declaredTokens(meta: FrontmatterMap): string[] {
  const raw: unknown = meta["visibility"];
  const values: ReadonlyArray<unknown> = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null
      ? []
      : [raw];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** True when `tokens` already declares the reserved token, however spelled. */
function declaresReserved(tokens: ReadonlyArray<string>): boolean {
  return tokens.some((token) => normToken(token) === REMOTE_DENY_VISIBILITY_TOKEN);
}

/**
 * A frontmatter-safe rendering of ONE visibility token, matching the
 * writer's scalar rule closely enough for a preview: a plain identifier
 * renders bare, anything else is JSON-quoted.
 */
function renderToken(token: string): string {
  return /^[A-Za-z0-9_][\w.:/@+-]*$/.test(token) ? token : JSON.stringify(token);
}

/** The would-be frontmatter line for a token list. */
function renderVisibilityLine(tokens: ReadonlyArray<string>): string {
  return `visibility: [${tokens.map(renderToken).join(", ")}]`;
}

/** The absolute path of a vault-relative, `/`-separated candidate path. */
function absolutePath(vault: string, relPath: string): string {
  return join(vault, ...relPath.split("/"));
}

/**
 * Scan the vault for informal privacy markers that are not formally
 * reserved. When `apply` is set, union the reserved token into each
 * candidate's `visibility:` through {@link writeFrontmatterAtomic};
 * otherwise report the candidates and write nothing.
 */
export function planPrivacyMarkerRestamp(
  vault: string,
  opts: PrivacyMarkerRestampOptions = {},
): PrivacyMarkerRestampResult {
  const apply = opts.apply === true;
  // The write guard is a WRITE guard: a preview writes nothing, so it is
  // not gated. Asserted before the walk so a refusal cannot land after
  // the first byte.
  if (apply) assertVaultIdentityForWrite(vault);

  const candidates: PrivacyMarkerRestampCandidate[] = [];
  let scanned = 0;

  for (const page of listVaultPages(vault, { reach: MAINTENANCE_LANE_REACH })) {
    if (!hasPrivacyDenyMarker(page.metadata)) continue;
    scanned++;
    const declared = declaredTokens(page.metadata);
    // Already formal: the marker adds nothing, so the page is not a
    // candidate and the run stays a no-op on it.
    if (declaresReserved(declared)) continue;
    const visibility = Object.freeze([...declared, REMOTE_DENY_VISIBILITY_TOKEN]);
    candidates.push(
      Object.freeze({
        path: vaultRelative(page.path, vault),
        visibility,
        visibilityLine: renderVisibilityLine(visibility),
      }),
    );
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let updated = 0;
  if (apply) {
    for (const candidate of candidates) {
      const absolute = absolutePath(vault, candidate.path);
      const [meta, body] = parseFrontmatter(absolute);
      const next: FrontmatterMap = { ...meta, visibility: candidate.visibility };
      writeFrontmatterAtomic(absolute, next, body, { overwrite: true });
      updated++;
    }
  }

  return Object.freeze({
    applied: apply,
    scanned,
    candidates: Object.freeze(candidates),
    updated,
  });
}
