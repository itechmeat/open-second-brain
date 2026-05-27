/**
 * Backlink index over the Brain layer.
 *
 * A "backlink" is any reference from one Brain artifact to another's
 * id via the Obsidian wikilink form `[[<id>]]`. The index inverts this
 * graph: given a target id, return every source that points at it.
 *
 * Sources walked:
 *
 *   - `Brain/preferences/pref-*.md` — frontmatter (`supersedes`,
 *     `evidenced_by[]`) and the body prose (any embedded `[[...]]`).
 *   - `Brain/retired/ret-*.md` — same fields, plus `superseded_by` and
 *     `retired_by`.
 *   - `Brain/log/<YYYY-MM-DD>.md` — every event whose payload references
 *     a preference (`preference`, `signal`, `superseded_by`, `run_id`,
 *     etc.). The log is append-only so we don't lose history.
 *
 * The index is recomputed on demand (no on-disk cache). The cost is
 * O(N+L) parse work per build where N is preferences+retired+signals
 * and L is total log entries. For typical vaults this is a small
 * fraction of `dream`'s cost; a smarter cache can land later if a
 * profile shows it pays.
 *
 * Pure read. Skips files that fail to parse — `brain_doctor` is the
 * surface that flags malformed artifacts, not this aggregator.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { buildAliasIndex } from "./link-graph/alias-index.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import { parseLogDay } from "./log.ts";
import { brainDirs } from "./paths.ts";
import { normalizeDerivedKeys } from "./preference.ts";
import { normaliseWikilinkTarget } from "./wikilink.ts";

// ----- Public types --------------------------------------------------------

export type BacklinkSourceKind = "preference" | "retired" | "signal" | `log-${string}`;

export interface BacklinkRef {
  /** Source id (basename without `.md`, e.g. `pref-foo`, `ret-bar`, `sig-2026-05-14-baz`). */
  readonly source: string;
  /** Where the reference lives. `log-<kind>` for log entries (e.g. `log-apply-evidence`). */
  readonly sourceKind: BacklinkSourceKind;
  /** Field name carrying the reference (`principle`, `supersedes`, body text, etc.). */
  readonly field: string;
  /** ISO-8601 timestamp for log entries; absent for preference/retired sources. */
  readonly timestamp?: string;
  /**
   * Heading-anchor text from `[[target#Heading]]` (v0.10.17+). Present
   * only when the wikilink carried a heading anchor; absent for plain
   * targets and for block references.
   */
  readonly targetAnchor?: string;
  /**
   * Block-id text from `[[target#^abc]]` (v0.10.17+). Present only
   * when the wikilink carried a block anchor; absent otherwise. The
   * `^` sigil is stripped; just the bare id is recorded.
   */
  readonly targetBlock?: string;
  /**
   * When the wikilink was written via an alias declared in the
   * target's frontmatter `aliases:` array (v0.10.17+), the alias
   * string the linker actually typed. `source` still keys against the
   * canonical id; this field surfaces the alias spelling for
   * downstream consumers (digest, doctor, concept synthesis) that
   * want to show how the link was phrased.
   */
  readonly aliasSource?: string;
}

/** Frozen target → refs map. Keys are normalised wikilink targets. */
export type BacklinkIndex = ReadonlyMap<string, ReadonlyArray<BacklinkRef>>;

// ----- Public API ----------------------------------------------------------

/**
 * Build the inverted reference index for the current Brain state.
 *
 * The returned map is frozen and each entry's array is frozen too —
 * callers cannot mutate the shared index. Recompute by calling this
 * function again; there is no incremental update path on purpose.
 */
export function buildBacklinkIndex(vault: string): BacklinkIndex {
  const dirs = brainDirs(vault);
  const aliasIndex = buildAliasIndex(vault);
  const map = new Map<string, BacklinkRef[]>();
  // Dedup key: `<source>\x00<canonical>\x00<anchor>\x00<block>`.
  // Anchor + block are part of the dedup key so two refs to
  // different anchors of the same target keep both entries (Unit 3
  // requirement).
  const seen = new Set<string>();

  const push = (target: string, ref: BacklinkRef): void => {
    const parsed = parseWikilinkRich(target);
    const bare = parsed.target;
    if (!bare) return;

    // Resolve via the alias index. Lookup key is NFC + lower-case
    // (matches the key normalisation `buildAliasIndex` emits). The
    // alias resolves to a different canonical id only when the
    // alias entry actually maps somewhere else.
    const aliasKey = bare.normalize("NFC").toLowerCase();
    let canonicalId = normaliseWikilinkTarget(bare);
    let aliasSource: string | undefined;
    const aliasHit = aliasIndex.get(aliasKey);
    if (aliasHit && aliasHit !== canonicalId) {
      aliasSource = bare;
      canonicalId = aliasHit;
    }
    if (!canonicalId || canonicalId === ref.source) return;

    const key = `${ref.source}\x00${canonicalId}\x00${parsed.anchor ?? ""}\x00${parsed.block ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);

    const enriched: BacklinkRef = {
      ...ref,
      ...(parsed.anchor !== undefined ? { targetAnchor: parsed.anchor } : {}),
      ...(parsed.block !== undefined ? { targetBlock: parsed.block } : {}),
      ...(aliasSource !== undefined ? { aliasSource } : {}),
    };

    const arr = map.get(canonicalId);
    if (arr) arr.push(enriched);
    else map.set(canonicalId, [enriched]);
  };

  collectPreferences(dirs.preferences, "preference", push);
  collectPreferences(dirs.retired, "retired", push);
  collectSignals(dirs.inbox, push);
  collectSignals(dirs.processed, push);
  collectLog(vault, dirs.log, push);

  // Freeze each entry's array so downstream callers can't mutate the
  // shared index.
  const frozen = new Map<string, ReadonlyArray<BacklinkRef>>();
  for (const [k, v] of map) frozen.set(k, Object.freeze(v));
  return frozen;
}

/**
 * Convenience: count of inbound references for one target id. Equal to
 * `(index.get(target) ?? []).length`. Kept as a named helper so call
 * sites that only need the count don't fight `undefined`.
 */
export function backlinkCount(index: BacklinkIndex, target: string): number {
  const norm = normaliseWikilinkTarget(target);
  return index.get(norm)?.length ?? 0;
}

// ----- Collectors ----------------------------------------------------------

function collectPreferences(
  dir: string,
  kind: "preference" | "retired",
  push: (target: string, ref: BacklinkRef) => void,
): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    const source = name.slice(0, -".md".length);
    // Single read: pull both frontmatter and body in one pass so we
    // don't pay 2× readFileSync per preference on every index build.
    // Field extraction is defensive — schema enforcement is the
    // doctor's job, not the backlink scanner's.
    let meta: Record<string, unknown>;
    let body: string;
    try {
      const [rawMeta, rawBody] = parseFrontmatter(full);
      // Collapse legacy / `_`-prefixed Group C keys so this
      // collector reads the same shape regardless of which the file
      // was written in. Collision aborts the row (caller's job to
      // flag via `brain_doctor`), but the rest of the index keeps
      // building.
      meta = normalizeDerivedKeys(rawMeta);
      body = rawBody;
    } catch {
      continue;
    }

    const evidenced = meta["evidenced_by"];
    if (Array.isArray(evidenced)) {
      for (const e of evidenced) {
        if (typeof e === "string") {
          push(e, { source, sourceKind: kind, field: "evidenced_by" });
        }
      }
    }
    const supersedes = meta["supersedes"];
    if (typeof supersedes === "string" && supersedes.length > 0) {
      push(supersedes, { source, sourceKind: kind, field: "supersedes" });
    }
    if (kind === "retired") {
      const supersededBy = meta["superseded_by"];
      if (typeof supersededBy === "string" && supersededBy.length > 0) {
        push(supersededBy, { source, sourceKind: kind, field: "superseded_by" });
      }
      const retiredBy = meta["retired_by"];
      if (typeof retiredBy === "string" && retiredBy.length > 0) {
        push(retiredBy, { source, sourceKind: kind, field: "retired_by" });
      }
    }
    for (const body0 of extractWikilinkRichBodies(body)) {
      push(body0, { source, sourceKind: kind, field: "body" });
    }
  }
}

function collectSignals(dir: string, push: (target: string, ref: BacklinkRef) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    if (!name.startsWith("sig-")) continue;
    const source = name.slice(0, -".md".length);
    try {
      const [meta, body] = parseFrontmatter(full);
      const sources = meta["source"];
      const list = Array.isArray(sources) ? sources : sources ? [String(sources)] : [];
      for (const t of list) push(t, { source, sourceKind: "signal", field: "source" });
      for (const body0 of extractWikilinkRichBodies(body)) {
        push(body0, { source, sourceKind: "signal", field: "body" });
      }
    } catch {
      continue;
    }
  }
}

function collectLog(
  vault: string,
  dir: string,
  push: (target: string, ref: BacklinkRef) => void,
): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const date = name.slice(0, -".md".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const source = `log-${date}`;
    let entries;
    try {
      entries = parseLogDay(vault, date).entries;
    } catch {
      continue;
    }
    for (const e of entries) {
      // Walk every payload value, pulling wikilink targets out of
      // scalar fields and string arrays alike. We don't whitelist
      // which fields can carry references — the payload key becomes
      // the `field` so callers can filter per-event-kind downstream.
      //
      // A payload value carries a wikilink either as the `[[...]]`
      // form or as bare text that happens to be a Brain id
      // (`pref-...`, `ret-...`, `sig-...`, `dream-...`). Both shapes
      // route through the same push.
      for (const [field, value] of Object.entries(e.body)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v !== "string") continue;
          if (!v.startsWith("[[") && !/^(pref|ret|sig|dream)-/.test(v)) continue;
          push(v, {
            source,
            sourceKind: `log-${e.eventType}`,
            field,
            timestamp: e.timestamp,
          });
        }
      }
    }
  }
}
