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
 * Pure read. `brain_doctor` is the surface that flags malformed
 * artifacts, not this aggregator — but an artifact this collector could
 * not parse is REPORTED here rather than skipped in silence, because a
 * dropped source produces a confidently wrong `count: 0` and the caller
 * has no way to tell that from a genuine zero
 * (a-label-is-not-a-boundary, U3; recon defect D4).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../vault.ts";
import { ownerScopeView } from "./owner-scope-view.ts";
import { relationFromFrontmatterField } from "../graph/relation-vocab.ts";
import { normalizeRelationTarget } from "../graph/frontmatter-relations.ts";
import { buildAliasIndex } from "./link-graph/alias-index.ts";
import { extractWikilinkRichBodies, parseWikilinkRich } from "./link-graph/parse-wikilink.ts";
import { listLogShardFiles, readLogDay } from "./log-jsonl.ts";
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
  /**
   * Semantic relation type (v3 / typed graph semantics) when the
   * carrying frontmatter field is a known relation
   * (`related` / `extends` / `contradicts` / `superseded_by`). Absent
   * for body wikilinks and non-relation fields (`evidenced_by`,
   * `supersedes`, `retired_by`, …). Classified via the single
   * vocabulary boundary in src/core/graph/relation-vocab.ts.
   */
  readonly relation?: string;
}

/**
 * One artifact whose references could not be collected, and why.
 *
 * `source` is the artifact id, never a host path: this record crosses the
 * MCP boundary through `brain_backlinks` and the contract at
 * `src/mcp/tools.ts:94-119` keeps absolute paths out of model context.
 */
export interface BacklinkParseFailure {
  /** Source id (basename without `.md`), as {@link BacklinkRef.source} spells it. */
  readonly source: string;
  /**
   * Which collector was reading it, in the SAME vocabulary
   * {@link BacklinkRef.sourceKind} uses - a failure and a ref describe
   * the same artifact, so a second spelling of "which lane" would be a
   * parallel vocabulary over one population. A log shard that cannot be
   * read has no event type to name, so it reports {@link LOG_READ_KIND}.
   */
  readonly sourceKind: BacklinkSourceKind;
  /** The failure's own message, with no host path in it. */
  readonly reason: string;
}

/**
 * `sourceKind` for a log shard whose entries could not be read at all.
 *
 * The per-ref form is `log-<eventType>`, and an unreadable shard has no
 * events to take a type from; this names the read itself instead, inside
 * the same `log-` namespace so no consumer needs a second branch.
 */
const LOG_READ_KIND = "log-read" as const;

/**
 * Frozen target → refs map, plus the artifacts the walk could not read.
 *
 * The failures ride on the index rather than in a second return value so
 * that the nine existing call sites keep compiling unchanged; the ones
 * that must report them read {@link BacklinkIndex.unparsed} and the rest
 * carry on using the map.
 */
export interface BacklinkIndex extends ReadonlyMap<string, ReadonlyArray<BacklinkRef>> {
  /**
   * Artifacts skipped because they could not be parsed.
   *
   * A `count: 0` beside a NON-EMPTY list here is not a measurement, and
   * a surface reporting the count must say so — the same distinction
   * `listDanglingTargets` draws between "measured zero" and "could not
   * measure". Empty on a healthy vault, so a clean payload is unchanged.
   */
  readonly unparsed: ReadonlyArray<BacklinkParseFailure>;
}

// ----- Public API ----------------------------------------------------------

/**
 * Build the inverted reference index for the current Brain state.
 *
 * The returned map is frozen and each entry's array is frozen too —
 * callers cannot mutate the shared index. Recompute by calling this
 * function again; there is no incremental update path on purpose.
 *
 * `ownerScope` (optional, second) drops every ref whose SOURCE artifact
 * the scope may not see, and drops it from `unparsed` too — an artifact
 * whose owner is unknowable is somebody else's, so naming it in a failure
 * report would leak exactly what the filter withheld. Absent (every
 * existing call site) means no ownership filtering at all.
 */
export function buildBacklinkIndex(vault: string, ownerScope?: string | null): BacklinkIndex {
  const dirs = brainDirs(vault);
  const view = ownerScopeView(vault, ownerScope ?? null);
  const aliasIndex = buildAliasIndex(vault);
  const unparsed: BacklinkParseFailure[] = [];
  const map = new Map<string, BacklinkRef[]>();
  // Dedup key: `<source>\x00<canonical>\x00<anchor>\x00<block>`.
  // Anchor + block are part of the dedup key so two refs to
  // different anchors of the same target keep both entries (Unit 3
  // requirement).
  const seen = new Set<string>();

  const push = (target: string, ref: BacklinkRef): void => {
    // The SOURCE decides visibility: a ref names the artifact that wrote
    // it, so publishing one publishes that artifact's id.
    if (!view.visible(ref.source)) return;
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

  const fail = (row: BacklinkParseFailure): void => {
    if (!view.visible(row.source)) return;
    unparsed.push(Object.freeze(row));
  };

  collectPreferences(dirs.preferences, "preference", push, fail);
  collectPreferences(dirs.retired, "retired", push, fail);
  collectSignals(dirs.inbox, push, fail);
  collectSignals(dirs.processed, push, fail);
  collectLog(vault, dirs.log, push, fail);

  // Freeze each entry's array so downstream callers can't mutate the
  // shared index.
  const frozen = new Map<string, ReadonlyArray<BacklinkRef>>();
  for (const [k, v] of map) frozen.set(k, Object.freeze(v));
  return Object.assign(frozen, { unparsed: Object.freeze(unparsed) });
}

/** The failure's own message, never the host path it happened at. */
function failureReason(err: unknown, path: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split(path).join("").replaceAll(" ()", "").trim();
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
  fail: (row: BacklinkParseFailure) => void,
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
    } catch (err) {
      // The row still aborts - the fields cannot be read - but it aborts
      // LOUDLY. `normalizeDerivedKeys` throws on the un-prefixed Group C
      // shape a legacy vault is full of, and the silent `continue` this
      // replaced produced an index missing every preference-sourced ref
      // with no diagnostic anywhere.
      fail({ source, sourceKind: kind, reason: failureReason(err, full) });
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
      const retiredBy = meta["retired_by"];
      if (typeof retiredBy === "string" && retiredBy.length > 0) {
        push(retiredBy, { source, sourceKind: kind, field: "retired_by" });
      }
    }
    // Typed semantic relations (v3): map known relation frontmatter
    // fields (related / extends / contradicts / superseded_by) to a
    // relation type via the single vocabulary boundary. Covers any
    // preference or retired artifact, generalising the prior
    // retired-only `superseded_by` handling. Runs before the body
    // wikilink pass so the relation-tagged ref wins dedup over a bare
    // body reference to the same target.
    for (const [field, value] of Object.entries(meta)) {
      const relation = relationFromFrontmatterField(field);
      if (!relation) continue;
      const list = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
      for (const t of list) {
        if (typeof t !== "string" || t.length === 0) continue;
        // The lightweight frontmatter parser can mangle `[[id]]` into
        // `[id]`; recover the bare target before pushing.
        const target = normalizeRelationTarget(t);
        if (target) push(target, { source, sourceKind: kind, field, relation });
      }
    }
    for (const body0 of extractWikilinkRichBodies(body)) {
      push(body0, { source, sourceKind: kind, field: "body" });
    }
  }
}

function collectSignals(
  dir: string,
  push: (target: string, ref: BacklinkRef) => void,
  fail: (row: BacklinkParseFailure) => void,
): void {
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
    } catch (err) {
      fail({ source, sourceKind: "signal", reason: failureReason(err, full) });
      continue;
    }
  }
}

function collectLog(
  vault: string,
  dir: string,
  push: (target: string, ref: BacklinkRef) => void,
  fail: (row: BacklinkParseFailure) => void,
): void {
  if (!existsSync(dir)) return;
  // Shard-aware (Memory Integrity Suite): merged per-day reads. List the
  // log directory once and share it across every date's readLogDay call
  // instead of one readdirSync+sort per date (this loop can span a
  // vault's entire log history).
  const shards = listLogShardFiles(vault);
  const dates = [...new Set(shards.map((f) => f.date))].toSorted();
  for (const date of dates) {
    const source = `log-${date}`;
    let entries;
    try {
      entries = readLogDay(vault, date, shards).entries;
    } catch (err) {
      fail({ source, sourceKind: LOG_READ_KIND, reason: failureReason(err, dir) });
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
