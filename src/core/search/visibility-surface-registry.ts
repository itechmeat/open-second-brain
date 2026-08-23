/**
 * Every surface that can hand a vault note's path, title, or body back to
 * a caller, classified as visibility-COVERED (routes through
 * `applyVisibilityScope`) or EXCLUDED with a written reason
 * (nothing-writes-silently, unit H, form B).
 *
 * `graph/visibility.ts`'s `visibility:` frontmatter field is real and
 * wired into exactly one place: `pipeline/pool-filters.ts:130`, inside
 * `search()`. It is caller-liftable scoping, not a boundary - any caller
 * may pass `visibility: ["private"]` and read a tagged page - but even
 * that weaker guarantee only holds for the ONE lane that calls `search()`.
 * Everywhere else, a page's tag is decorative. This module is the
 * enumeration that makes the gap a measured fact instead of a claim:
 * {@link tests/core/architecture/visibility-surface-census.test.ts} pins
 * that a mechanical sweep of `src/mcp/` and `src/cli/` finds nothing this
 * list does not already carry, and `search check` derives its honesty
 * finding's count from {@link excludedCallableVisibilitySurfaces} rather
 * than a hand-written number.
 *
 * The list is the census's POPULATION, not a claim to be every surface
 * there is: the MCP half is swept mechanically with the blind spots that
 * test's docblock states, and the CLI half is hand-enumerated one row per
 * MCP mirror. The `search check` line that reports it says so.
 *
 * This module makes NO enforcement change. It does not touch
 * `graph/visibility.ts`, the indexer, `listVaultPages`, or the
 * owner-scope path - see the census test's docblock for the coverage map
 * a future enforcement wave (Unit H form A, parked) would need.
 */

/** Whether a surface's data path passes through `applyVisibilityScope`. */
export const VISIBILITY_SURFACE_CATEGORY = Object.freeze({
  /** Routes through `applyVisibilityScope`, directly or via `search()`. */
  covered: "covered",
  /** Can return note path/title/body without ever consulting `visibility:`. */
  excluded: "excluded",
} as const);

export type VisibilitySurfaceCategory =
  (typeof VISIBILITY_SURFACE_CATEGORY)[keyof typeof VISIBILITY_SURFACE_CATEGORY];

/** Which interface a surface is reached through. */
export const VISIBILITY_SURFACE_KIND = Object.freeze({
  mcpTool: "mcp_tool",
  cliVerb: "cli_verb",
  mcpResource: "mcp_resource",
  /** A structural fact about the index's own storage, not a callable surface. */
  indexStore: "index_store",
} as const);

export type VisibilitySurfaceKind =
  (typeof VISIBILITY_SURFACE_KIND)[keyof typeof VISIBILITY_SURFACE_KIND];

export interface VisibilitySurfaceEntry {
  /** The tool name, `<group> <verb>` CLI path, resource URI, or fixed label. */
  readonly surface: string;
  readonly kind: VisibilitySurfaceKind;
  readonly category: VisibilitySurfaceCategory;
  /** What the category alone does not say - the source-verified argument. */
  readonly reason: string;
}

const K = VISIBILITY_SURFACE_KIND;
const C = VISIBILITY_SURFACE_CATEGORY;

/**
 * The population, hand-verified against source (main clone at
 * `feat/nothing-writes-silently`, HEAD `31561384` and after). The census
 * test's mechanical sweep is the check that this list has not gone
 * stale; the reasons below are what that sweep cannot itself produce.
 */
export const VISIBILITY_SURFACE_REGISTRY: ReadonlyArray<VisibilitySurfaceEntry> = Object.freeze([
  // --- Covered: reaches search()'s pool-filters pipeline -------------------
  {
    surface: "brain_search",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "calls core/search/search.ts's search() directly, which runs assembleRankedResults -> " +
      "applyPoolFilters -> applyVisibilityScope (pool-filters.ts:130) on every result before " +
      "returning it, unconditionally - the empty-scope-hides-tagged-pages rule applies even when " +
      "the caller passes no visibility argument at all.",
  },
  {
    surface: "brain_file_context",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "src/mcp/search-tools.ts's toolBrainFileContext calls fileContextRecall " +
      "(core/brain/file-recall.ts), which calls search() with the derived query and no visibility " +
      "override, so it inherits the same pool-filters gate as brain_search. It is covered " +
      "transitively, not by an independent check of its own.",
  },
  {
    surface: "search query",
    kind: K.cliVerb,
    category: C.covered,
    reason:
      "src/cli/search/verbs/query.ts calls search() with the CLI's --visibility flag threaded " +
      "through, the same function and the same pool-filters gate brain_search uses.",
  },

  // --- Excluded: MCP tools ---------------------------------------------------
  {
    surface: "brain_search_expand",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "expandHit() (core/search/cards.ts) hydrates a chunk_id directly off the store and checks " +
      "only isPathOwnerVisible, and only when the caller supplies agentScope - it never calls " +
      "applyVisibilityScope or isVisible. A caller holding any valid chunk_id for a " +
      "visibility-tagged page - not necessarily one it received from a filtered brain_search call " +
      "- can read the full note through this tool.",
  },
  {
    surface: "second_brain_query",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "toolQuery (src/mcp/tools.ts) lists pages with listVaultPages(), which accepts only " +
      "skipDirs/skipFiles, and applies its own owner-scope check over the parsed frontmatter - " +
      "visibility: is never read on this path.",
  },
  {
    surface: "brain_context_pack",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "packContext() (core/brain/context-pack.ts) draws candidates only from Brain/preferences " +
      "and Brain/retired via collectPreferencePages, filtered by isTombstoned and ownerScope - " +
      "never by visibility. A Brain preference page tagged visibility: private is returned " +
      "verbatim, path and body both.",
  },
  {
    surface: "brain_query",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "queryByPreference / queryByTopic (core/brain/query.ts) return Brain preference, retired " +
      "and log records - id, principle, evidence trail - straight off disk with no visibility " +
      "check anywhere in the read path.",
  },
  {
    surface: "brain_backlinks",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "buildBacklinkIndex (core/brain/backlinks.ts) walks the vault with readdirSync + " +
      "parseFrontmatter directly, gated only by ownerScopeView; visibility: is not among the " +
      "fields it consults.",
  },
  {
    surface: "brain_unlinked_mentions",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "findUnlinkedMentions (core/brain/link-graph/unlinked-mentions.ts) walks the vault the same " +
      "way backlinks.ts does - readdirSync + parseFrontmatter, ownerScopeView only - and surfaces " +
      "the mentioning page's path regardless of any visibility tag on it.",
  },
  {
    surface: "brain_sources",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "aggregateSources (core/brain/portability/sources.ts) reads Brain's own signal registry " +
      "under readdirSync, with no visibility check - the field is not part of a signal's schema " +
      "and the reader never looks at a general vault page.",
  },
  {
    surface: "brain_audit",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "readPrefAudit (core/brain/pref-audit.ts) returns preference-mutation ledger records - " +
      "timestamp, pref_id, op, agent, revision hashes - never a note body or title, and no " +
      "visibility check runs over them. Included for completeness though its disclosure is " +
      "narrower than the other entries here: no page content crosses this surface at all.",
  },
  {
    surface: "brain_bridges",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "discoverBridges (core/brain/link-graph/bridge-discovery.ts) proposes links between " +
      "embedding-near notes read via listVaultPages and a raw Store handle, and list reads " +
      "Brain/proposals/bridges.md back - source/target note paths in both cases, with no " +
      "visibility check on either side of a proposed pair.",
  },
  {
    surface: "brain_clusters",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "detectCommunities / materializeClusterNotes (core/brain/link-graph/communities.ts) read " +
      "the link graph off a raw Store handle and member titles via parseFrontmatter, then " +
      "materialize cluster notes naming every member page - no visibility check anywhere in the " +
      "pass.",
  },
  {
    surface: "brain_moc_audit",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "auditMoc (core/brain/link-graph/moc-audit.ts) classifies a hub's outbound links through " +
      "buildBacklinkIndex, the same ownerScopeView-only, visibility-blind path brain_backlinks " +
      "uses.",
  },
  {
    surface: "brain_deep_synthesis",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "deepSynthesis (core/brain/deep-synthesis.ts) is mixed rather than uniformly unfiltered: " +
      "its matched-notes component calls search() and inherits pool-filters, but its " +
      "knowledge-gap component (dangling wikilinks) walks the vault directly via walkVault " +
      "(core/search/walker.ts), which applies no visibility check. The dossier as a whole cannot " +
      "be called covered because one of its two note-reading paths is not.",
  },
  {
    surface: "brain_idea_discovery",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "discoverIdeas / ideaCandidates (core/brain/idea-discovery.ts) walk the vault via " +
      "readdirSync + parseFrontmatter to find orphan research notes, with no visibility check on " +
      "any candidate page.",
  },
  {
    surface: "brain_dead_ends",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "listDeadEnds / recordDeadEnd (core/brain/dead-ends.ts) read and write Brain/dead-ends/ " +
      "notes directly via parseFrontmatterText, with no visibility check - though these are " +
      "Brain-authored records rather than general vault notes.",
  },
  {
    surface: "brain_claims",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "toolBrainClaims's own docblock (knowledge-tools.ts) states a claim row carries the " +
      "artifact's id, vault-relative path, topic and full principle text; every row-returning " +
      "operation is filtered by gatedOwnerScopeView (agent-scope), never by visibility.",
  },
  {
    surface: "brain_truth",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "the entity claim ledger (core/brain/truth/*) returns claim values, provenance wikilinks " +
      "and cross-agent collision records keyed by entity, with no visibility check anywhere in " +
      "ingest, slots, conflicts, aggregate or collisions.",
  },
  {
    surface: "brain_labels",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "show reads a caller-named page with parseFrontmatter and returns the caller's own path " +
      "plus its label set - no title or body crosses this surface, and no visibility check runs " +
      "over the read either way.",
  },
  {
    surface: "brain_tiers",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "check returns store.listTierDrift() unscoped across the whole index - every drifted " +
      "document's path, with no visibility check - and restore additionally reads the named " +
      "page's full frontmatter and body via parseFrontmatter.",
  },
  {
    surface: "brain_maintenance",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "the bridges and clusters lanes of this maintenance runner call discoverBridges / " +
      "detectCommunities directly in their own `run` steps, the same unfiltered vec-index and " +
      "link-graph reads brain_bridges/brain_clusters make - the response surfaces only per-lane " +
      "counts, but the reads themselves are unfiltered.",
  },
  {
    surface: "brain_secrets",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept into population because admin-tools.ts (its home file) also imports parseFrontmatter " +
      "and Store for brain_labels/brain_tiers/brain_maintenance beside it - the handler itself " +
      "returns only secret names and run results, never a note path, title, or body. Listed for " +
      "completeness of the file-level population rule rather than as a real disclosure.",
  },
  {
    surface: "brain_artifact_get",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "a generic preview-artifact cache read (src/mcp/tools.ts's toolArtifactGet): it returns " +
      "whatever string another tool call stored under artifact_id when its own response was " +
      "preview-truncated, with no check of its own. When the truncated response came from a " +
      "note-returning excluded tool, the cached payload is that same unfiltered content.",
  },
  {
    surface: "brain_diarize",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "diarize() (core/brain/diarization.ts) returns document_set - the entity's assembled " +
      "document set from the registry and sources - with no visibility check on any member path.",
  },
  {
    surface: "brain_context",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "toolBrainContext (context-tools.ts) returns Brain/active.md's rendered content via " +
      "parseFrontmatter - the standing-rules digest, a Brain-authored artifact - with no " +
      "visibility check; it is the always-loaded writer tool, not a general note reader.",
  },
  {
    surface: "brain_agent_query",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "queryAgentSources (core/brain/agent-source/query.ts) returns, by the handler's own " +
      "comment, 'contribution rows - ids, topics and the record text' from the provenance fold, " +
      "gated by an explicit agent_scope argument only - never by visibility.",
  },
  {
    surface: "brain_agent_diff",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "diffAgentSources returns the same contribution rows brain_agent_query does, gated by the " +
      "GATED server identity (owner_scope_delivery, off by default) rather than an argument - " +
      "visibility is not part of either gate.",
  },
  {
    surface: "brain_anticipatory_context",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "reads the anticipatory-context cache (core/brain/anticipatory-cache.ts), which mirrors " +
      "brain_context_pack's own candidate items - no visibility check runs over the cached read.",
  },
  {
    surface: "brain_context_receipts",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "show returns a stored receipt's full payload verbatim - the same content a prior " +
      "brain_context_pack call recorded - with no visibility re-check at read time; only a " +
      "receipt-level private/redacted flag applies, which is a different axis.",
  },
  {
    surface: "brain_event_trace",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "resolveLogEventTraces (core/brain/event-trace.ts) returns Brain log event bodies, which " +
      "can name a note path per event; gated by a keep_private argument over the event's own " +
      "flag, not by the named artifact's visibility.",
  },
  {
    surface: "brain_foresight",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "assembles recurring routines, open commitments and open questions from Brain's own " +
      "recurrence/obligation/question stores - Brain-authored records, not general vault notes - " +
      "with no visibility check.",
  },
  {
    surface: "brain_pinned_context",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "reads/writes Brain/pinned.md, a single Brain-authored scratchpad file, with no visibility " +
      "check - the field would be meaningless on a file with exactly one owner-less instance.",
  },
  {
    surface: "brain_write_session",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "dispatchSubmit / listWriteSessions / readWriteSession (core/brain/write-session/*) read " +
      "and mutate staged write-session records - Brain's own queue, not general vault notes - " +
      "with no visibility check.",
  },
  {
    surface: "brain_pre_compress_pack",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "buildPreCompressPack (core/brain/pre-compress-pack.ts) returns id/principle items from " +
      "the same Brain/preferences pool brain_context_pack draws from, gated by agentScope only.",
  },
  {
    surface: "brain_pre_compact_extract",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "extractPreCompactRecords (core/brain/pre-compact-extract.ts) extracts records from " +
      "caller-SUPPLIED conversation text, not from vault notes - included for completeness of " +
      "the file-level sweep rather than as a real vault-content disclosure.",
  },
  {
    surface: "brain_recall_gate",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "a diagnostic classifier over caller-supplied scores/match_quality - it runs no search and " +
      "returns no note content; included for completeness of the file-level sweep only.",
  },
  {
    surface: "brain_recall_feedback",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "records a relevance verdict for a prior recall result and returns a confirmation, not note " +
      "content; included for completeness of the file-level sweep only.",
  },
  {
    surface: "brain_eval",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "scores retrieval quality (hit@k, MRR, …) over an operator-supplied dataset and returns " +
      "metrics, not note bodies; included for completeness of the file-level sweep only.",
  },
  {
    surface: "brain_codegraph_report",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "reports codegraph index state and counts - no vault note crosses this surface at all; " +
      "included for completeness of the file-level sweep only.",
  },
  {
    surface: "brain_context_presets",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "diagnoses/suggests context-pack preset configuration and returns config diffs, not note " +
      "content; included for completeness of the file-level sweep only.",
  },
  {
    surface: "second_brain_capabilities",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "returns the process's own capability report (tool counts, withheld-tool reasons) from " +
      "ctx.capabilityReport - it never touches the vault, let alone a note path, title or body; " +
      "included for completeness of the file-level sweep only. Registered as " +
      "`name: CAPABILITY_DIAGNOSTIC_TOOL` rather than a literal, which is exactly why the sweep " +
      "resolves constants: this row was missing while the census passed.",
  },
  {
    surface: "second_brain_status",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "reports install/config/vault status blocks - no note path, title, or body crosses this " +
      "surface; included for completeness of the file-level sweep only (tools.ts imports " +
      "listVaultPages for second_brain_query, defined in the same file).",
  },
  {
    surface: "vault_health",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "runs vault/config/plugin-manifest health checks and state-surface inventory - no note " +
      "content crosses this surface; included for completeness of the file-level sweep only.",
  },

  // --- Excluded: CLI verbs, one per MCP tool above that has a CLI mirror ----
  {
    surface: "search expand",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/search/verbs/expand.ts calls expandHit() directly - the same chunk_id hydration " +
      "brain_search_expand uses, with the same absence of a visibility check.",
  },
  {
    surface: "brain backlinks",
    kind: K.cliVerb,
    category: C.excluded,
    reason: "src/cli/brain/verbs/backlinks.ts calls buildBacklinkIndex, same as brain_backlinks.",
  },
  {
    surface: "brain bridges",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/bridges.ts drives the same bridge-discovery.ts core as brain_bridges.",
  },
  {
    surface: "brain clusters",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/clusters.ts drives the same communities.ts core as brain_clusters.",
  },
  {
    surface: "brain moc-audit",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/moc-audit.ts calls auditMoc, the same buildBacklinkIndex-backed, " +
      "visibility-blind path brain_moc_audit uses.",
  },
  {
    surface: "brain deep-synthesis",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/deep-synthesis.ts drives the same mixed deepSynthesis() core as " +
      "brain_deep_synthesis.",
  },
  {
    surface: "brain ideas",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/ideas.ts drives the same idea-discovery.ts core as brain_idea_discovery.",
  },
  {
    surface: "brain dead-end",
    kind: K.cliVerb,
    category: C.excluded,
    reason: "src/cli/brain/verbs/dead-end.ts drives the same dead-ends.ts core as brain_dead_ends.",
  },
  {
    surface: "brain file-context",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/file-context.ts calls fileContextRecall(), the same wrapper " +
      "brain_file_context uses - listed here as an entry of record even though the underlying " +
      "path is visibility-covered, so a reader of this registry does not have to cross-reference " +
      "the MCP list to learn the CLI verb's answer.",
  },
  {
    surface: "brain context-pack",
    kind: K.cliVerb,
    category: C.excluded,
    reason: "src/cli/brain/verbs/context-pack.ts calls packContext, same as brain_context_pack.",
  },
  {
    surface: "brain query",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/query.ts calls queryByPreference / queryByTopic, the same " +
      "visibility-blind Brain-record path brain_query uses.",
  },
  {
    surface: "brain sources",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/sources.ts calls aggregateSources, the same Brain signal-registry " +
      "read brain_sources uses, with no visibility check either.",
  },
  {
    surface: "brain audit",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/audit.ts calls readPrefAudit, the same preference-mutation ledger " +
      "read brain_audit uses; no note body or title crosses either surface.",
  },
  {
    surface: "brain claims",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/claims.ts drives the same claim-graph core (path, topic, principle " +
      "text per row) that brain_claims's own docblock describes as agent-scope-gated only.",
  },
  {
    surface: "brain truth",
    kind: K.cliVerb,
    category: C.excluded,
    reason: "src/cli/brain/verbs/truth.ts drives the same entity claim ledger as brain_truth.",
  },
  {
    surface: "brain label",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/label.ts drives the same labels.ts core as brain_labels; neither " +
      "surface returns a note title or body, only the caller's own path and a label set.",
  },
  {
    surface: "brain tiers",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/tiers.ts drives the same Store.listTierDrift() path as brain_tiers.",
  },
  {
    surface: "brain secret",
    kind: K.cliVerb,
    category: C.excluded,
    reason: "src/cli/brain/verbs/secret.ts mirrors brain_secrets; no note content crosses either.",
  },
  {
    surface: "brain maintenance",
    kind: K.cliVerb,
    category: C.excluded,
    reason:
      "src/cli/brain/verbs/maintenance.ts mirrors brain_maintenance; no note content crosses either.",
  },

  // --- Excluded: MCP resources -----------------------------------------------
  {
    surface: "osb://preferences/active",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "one of resources.ts's three whole-vault readers, deliberately unfiltered by its own " +
      "docblock (Brain/active.md is shared by construction) - and visibility: is not part of " +
      "that decision either way; the field is never consulted.",
  },
  {
    surface: "osb://lessons",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "same whole-vault-reader class as osb://preferences/active; visibility: is never consulted.",
  },
  {
    surface: "osb://digest/latest",
    kind: K.mcpResource,
    category: C.excluded,
    reason: "renderDigest() output, same unfiltered whole-vault-reader class; no visibility check.",
  },
  {
    surface: "osb://status",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "computeBrainStatus() output, same unfiltered whole-vault-reader class; no visibility check.",
  },
  {
    surface: "osb://preference/{id}",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "gated by gatedOwnerScopeView (agent-scope), per resources.ts's own docblock on why the " +
      "four templated readers exist - a visibility-tagged preference page is returned in full, " +
      "frontmatter and body, once the owner-scope check passes.",
  },
  {
    surface: "osb://topic/{slug}",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "same gatedOwnerScopeView-only path as osb://preference/{id}; visibility: is never read.",
  },
  {
    surface: "osb://log/{date}",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "withVisibleLogEvents filters rendered log sections by gatedOwnerScopeView over the " +
      "artifacts each event names; no visibility check on those artifacts.",
  },
  {
    surface: "osb://backlinks/{id}",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "calls buildBacklinkIndex directly - resources.ts's own comment calls it 'the last " +
      "unscoped buildBacklinkIndex call in the product' - gated only by gatedOwnerScopeView.",
  },

  // --- Excluded: the index's own storage --------------------------------------
  {
    surface: "search index chunks/chunk_fts tables",
    kind: K.indexStore,
    category: C.excluded,
    reason:
      "chunker.ts's packBlocks emits a page's frontmatter block as its own chunk verbatim " +
      "(chunk_index 0), and the body as the chunks after it - indexer.ts applies no visibility " +
      "predicate anywhere in that pass, so a private page's full text, frontmatter included, is " +
      "stored in chunks and mirrored into chunk_fts regardless of any read-side filter. A copy of " +
      "the index carries the content a read-side filter only ever hides at query time.",
  },
]);

/** {@link VISIBILITY_SURFACE_REGISTRY}, restricted to the excluded rows. */
export function excludedVisibilitySurfaces(): ReadonlyArray<VisibilitySurfaceEntry> {
  return VISIBILITY_SURFACE_REGISTRY.filter((entry) => entry.category === C.excluded);
}

/**
 * The rows that name something a caller can INVOKE - every kind but
 * `index_store`, whose one row is a structural fact about the index's own
 * storage and says so in its own vocabulary comment.
 *
 * The distinction exists because a count is reported to operators. "N of
 * M note-returning surfaces" has to be M surfaces somebody could call;
 * folding the storage fact into that denominator quietly inflates it by
 * one, which is the kind of arithmetic this wave is about.
 */
export function callableVisibilitySurfaces(): ReadonlyArray<VisibilitySurfaceEntry> {
  return VISIBILITY_SURFACE_REGISTRY.filter((entry) => entry.kind !== K.indexStore);
}

/** {@link callableVisibilitySurfaces}, restricted to the excluded rows. */
export function excludedCallableVisibilitySurfaces(): ReadonlyArray<VisibilitySurfaceEntry> {
  return callableVisibilitySurfaces().filter((entry) => entry.category === C.excluded);
}
