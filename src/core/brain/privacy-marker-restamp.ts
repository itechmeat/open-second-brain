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
 *   - WRITTEN FROM A RE-READ. The apply loop re-parses each candidate
 *     immediately before its write and recomputes the token list from
 *     that parse, so an edit that landed between the scan and the write
 *     is honoured, and a page whose marker vanished is skipped (it stays
 *     in the reported candidate list, which is what the scan found).
 *     The re-parse is the notice-carrying one: a page whose frontmatter
 *     carries a line the scanner drops would lose that line in a
 *     rewrite, so the apply pass refuses it by name (reported in
 *     `skipped`, with the reason) and leaves its bytes untouched. The
 *     raw block is checked too, for the losses the scanner does not
 *     report: a `#` comment line and an indented nested mapping are
 *     skipped or flattened without a notice, and a rewrite would lose
 *     them all the same.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FRONTMATTER_RE,
  listVaultPages,
  parseFrontmatterWithNotices,
  writeFrontmatterAtomic,
} from "../vault.ts";
import { DEGRADATION_CODE } from "../integrity/degradation.ts";
import { vaultRelative } from "../path-safety.ts";
import { MAINTENANCE_LANE_REACH } from "../graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN, normToken } from "../graph/visibility.ts";
import { hasPrivacyDenyMarker } from "../graph/privacy-markers.ts";
import type { FrontmatterMap } from "../types.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** U+FEFF, which may precede a page's opening fence (see vault.ts). */
const BYTE_ORDER_MARK = 0xfeff;

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
  /**
   * Candidates the apply pass REFUSED to rewrite, by name, with the
   * reason. A page whose frontmatter parse reports dropped lines stays
   * untouched: the line-based scanner cannot round-trip those lines, so
   * a rewrite would silently drop them and break the no-key-removed
   * promise. Empty on a dry run; the candidate list still shows what the
   * scan found.
   */
  readonly skipped: ReadonlyArray<PrivacyMarkerRestampSkip>;
}

/** One page the apply pass refused, and why. */
export interface PrivacyMarkerRestampSkip {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  /** Why the page was not rewritten. */
  readonly reason: string;
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
 * The first line of the raw frontmatter block that a rewrite through the
 * writer cannot round-trip even though the scanner raised NO notice - so
 * the refuse-on-notice guard cannot see it. The scanner skips a `#`
 * comment line silently (the format documents comments as content it
 * discards) and trims each line before matching key/value, so an indented
 * nested mapping is silently flattened into top-level keys. Either way a
 * rewrite re-serialises the parsed map and the original bytes are gone:
 * a comment is deleted, a nested map is flattened. Spelled from the raw
 * text, not from the parsed map, because the loss is in the bytes the
 * parse throws away.
 */
function unroundtrippableFrontmatterLine(raw: string): string | null {
  const text = raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) return null;
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) return `frontmatter line ${i + 1} is a comment`;
    if (/^\s/.test(line)) return `frontmatter line ${i + 1} is indented`;
  }
  return null;
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
  const skipped: PrivacyMarkerRestampSkip[] = [];
  if (apply) {
    for (const candidate of candidates) {
      const absolute = absolutePath(vault, candidate.path);
      // Write-time recompute: the candidate list describes the vault as
      // the scan saw it, but the page is re-parsed here, immediately
      // before its write, and an edit that landed in between (operator,
      // sync) is the state this write is responsible for. The tokens are
      // therefore recomputed from the just-parsed frontmatter - the
      // declared tokens as they stand now, plus the reserved token while
      // the marker is still present - never copied off the scanned
      // candidate, which would clobber a token the edit declared. A page
      // whose marker vanished is no longer a reservation this run owes:
      // it is skipped, while staying in the reported candidate list,
      // which is what the scan found. The already-reserved case skips
      // for the same reason the scan never nominated such a page.
      //
      // The re-parse is the NOTICE-CARRYING one, and a notice skips the
      // page by name: the scanner is line-based, so a line it drops (a
      // folded block scalar, a stray dash item) cannot round-trip through
      // the writer - rewriting would silently lose it and break the
      // no-key-removed promise above. The page keeps its informal marker
      // (the read roots still deny it) and stays in the candidate list;
      // the refusal is reported, never silent.
      const [meta, body, parseNotices] = parseFrontmatterWithNotices(absolute);
      if (parseNotices.length > 0) {
        // The reason names the failure the page actually has: a notice
        // whose code is `frontmatter-unreadable` is a READ failure (the
        // file was deleted or moved between the scan and the write), not
        // a YAML problem, and saying "dropped line" would send the
        // operator looking at frontmatter the page does not have.
        const first = parseNotices[0]!;
        skipped.push(
          Object.freeze({
            path: candidate.path,
            reason:
              first.code === DEGRADATION_CODE.frontmatterUnreadable
                ? `page could not be re-read before the write (${first.detail})`
                : parseNotices.length === 1
                  ? `frontmatter parse dropped 1 line; rewriting would lose it (${first.code})`
                  : `frontmatter parse dropped ${parseNotices.length} lines; rewriting would lose them (${first.code})`,
          }),
        );
        continue;
      }
      // The notice guard above covers the lines the scanner REPORTS. A
      // comment line and an indented nested mapping are lost silently -
      // the scanner skips or flattens them without a notice - so the raw
      // block is checked for them here, before any write. The re-read is
      // guarded on its own: a page that vanished between the parse above
      // and this read is refused as unreadable rather than crashing the
      // apply pass.
      let raw: string;
      try {
        raw = readFileSync(absolute, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? String(err);
        skipped.push(
          Object.freeze({
            path: candidate.path,
            reason: `page could not be re-read before the write (${code})`,
          }),
        );
        continue;
      }
      const loss = unroundtrippableFrontmatterLine(raw);
      if (loss !== null) {
        skipped.push(
          Object.freeze({
            path: candidate.path,
            reason: `${loss}; the writer cannot round-trip it, so rewriting would lose it`,
          }),
        );
        continue;
      }
      if (!hasPrivacyDenyMarker(meta)) continue;
      const declared = declaredTokens(meta);
      if (declaresReserved(declared)) continue;
      const next: FrontmatterMap = {
        ...meta,
        visibility: Object.freeze([...declared, REMOTE_DENY_VISIBILITY_TOKEN]),
      };
      writeFrontmatterAtomic(absolute, next, body, { overwrite: true });
      updated++;
    }
  }

  return Object.freeze({
    applied: apply,
    scanned,
    candidates: Object.freeze(candidates),
    updated,
    skipped: Object.freeze(skipped),
  });
}
