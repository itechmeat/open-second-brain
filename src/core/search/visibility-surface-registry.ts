/**
 * Every surface that can hand a vault note's path, title, or body back to
 * a caller, classified as visibility-COVERED (a read root decides for it)
 * or EXCLUDED with a written reason (nothing-writes-silently, unit H,
 * form B).
 *
 * `graph/visibility.ts`'s `visibility:` field carries two independent
 * rules, and this list is about the second of them:
 *
 *   - the caller's requested SCOPE, which any caller may lift by asking
 *     for a token, and which reaches only the lanes that call `search()`;
 *   - ONE reserved token, which a caller cannot lift and which three read
 *     roots enforce - the search pipeline, `listVaultPages`, and the
 *     key-addressed reads.
 *
 * This module is the enumeration that makes the remaining gap a measured
 * fact instead of a claim:
 * {@link tests/core/architecture/visibility-surface-census.test.ts} pins
 * that a mechanical sweep of `src/mcp/`, `src/cli/` and `src/openclaw/`
 * finds nothing this list does not already carry, and `search check`
 * derives its honesty finding's counts from
 * {@link excludedCallableVisibilitySurfaces} and from the index's own
 * column rather than from hand-written numbers.
 *
 * The list is the census's POPULATION, not a claim to be every surface
 * there is: the MCP half is swept mechanically with the blind spots that
 * test's docblock states, and the CLI half is hand-enumerated one row per
 * MCP mirror. The `search check` line that reports it says so.
 *
 * HISTORY, because a stale claim here is worse than none. This module
 * shipped as a pure measurement, and its header said so: "makes NO
 * enforcement change ... a future enforcement wave (Unit H form A,
 * parked)". That wave is this branch. `graph/visibility.ts`, the indexer
 * and `listVaultPages` are all touched now, the reserved token is
 * enforced at the three roots, and the reasons below say per row which
 * root covers a surface - so the header that described the parked state
 * would now be describing a state that no longer exists.
 */

/** Whether a read root decides what a surface may hand back. */
export const VISIBILITY_SURFACE_CATEGORY = Object.freeze({
  /**
   * A read root decides for it: the search pipeline's pool filters, the
   * `listVaultPages` walk, or the key-addressed read's own ask at the
   * site of the read. Was "routes through `applyVisibilityScope`", which
   * described the only root that existed when this list was written.
   */
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
    category: C.covered,
    reason:
      "expandHit() (core/search/cards.ts) hydrates a chunk_id straight off the store, so it is " +
      "root C - the key-addressed read. It asks isPathReadableAtReach on EVERY call rather than " +
      "only when an argument arrived, and refuses a reserved page with the SAME error an absent " +
      "chunk produces, because a chunk id is a sequential integer and a distinguishable refusal " +
      "over an enumerable key space is an existence oracle.",
  },
  {
    surface: "second_brain_query",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "toolQuery (src/mcp/tools.ts) lists pages with listVaultPages(), which is root B: the walk " +
      "takes the reach the transport minted and drops a reserved page over the frontmatter it has " +
      "already parsed, before the sort and before the array leaves the function - so the ownership " +
      "filter below it and the total it reports both see the same pages the caller does.",
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
    category: C.covered,
    reason:
      "queryByPreference / queryByTopic (core/brain/query.ts) return Brain records by id, so this " +
      "is root C over reference-shaped rows. The topic mode carries the reach into the SELECTION, " +
      "because a topic resolves to exactly one preference and filtering afterwards would report a " +
      "topic as having no rule whenever a reserved one sorted first; the signals, the log events " +
      "and the preference-mode lookup are filtered through reachView, and a reserved preference " +
      "answers with the message an absent one produces.",
  },
  {
    surface: "brain_backlinks",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "buildBacklinkIndex (core/brain/backlinks.ts) walks the vault itself, and every ref it " +
      "yields NAMES its source artifact - so root C is applied to the refs as well as to the " +
      "target. A withheld target answers as an absent one (the empty backlink document) rather " +
      "than refusing, because an unknown target is a legitimate zero here and a refusal would be " +
      "the one response shape that proves the page exists.",
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
    category: C.covered,
    reason:
      "BOTH modes, because classifying the tool off the list mode alone was the registry making " +
      "a claim the tool did not hold. The list mode readFileSyncs Brain/proposals/bridges.md by " +
      "path rather than through a read root, so it asks reachView at the site of the read and a " +
      "reserved proposals page answers exactly as an absent one does - registered as a guarded " +
      "direct vault read by the root-closure sweep in the architecture census. The discover mode " +
      "returned discoverBridges()'s proposals verbatim, each naming two pages by path off the " +
      "vec index, which keeps reserved pages by design (the column reports, it does not " +
      "exclude); it now drops a proposal WHOLE when either end is withheld. Detection stays " +
      "vault-wide and the shared artifact is still written unfiltered - a bridge proposed from " +
      "the visible half of a link graph would differ per caller - so the rule is applied to what " +
      "the caller is told, which is the same shape brain_clusters run uses.",
  },
  {
    surface: "brain_clusters",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the list mode readdirSyncs Brain/clusters/*.md by path rather than through a read root, so " +
      "it asks reachView at the site of the read: a withheld cluster is dropped and nothing " +
      "counts it, which is the row the root-closure sweep in " +
      "tests/core/architecture/visibility-surface-census.test.ts registers as guarded.",
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
    category: C.covered,
    reason:
      "deepSynthesis (core/brain/deep-synthesis.ts) reaches its matched notes through search(), " +
      "so it is covered transitively by root A: the tool threads contextReach(ctx) into " +
      "SearchOptions.transportReach and inherits the same pool-filters gate brain_search has.",
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
    surface: "brain_writes",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "listNoteWrites (core/brain/notes/write-log.ts) projects `note-write` events out of the " +
      "Brain log and never opens the notes they name, so no `visibility:` is on the path to be " +
      "consulted. It returns a target PATH and two content digests rather than any note body - " +
      "which bounds the exposure to the existence of a page and its name, not its prose - but " +
      "the path of a note marked private is still reported, so this is excluded rather than " +
      "covered.",
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
    category: C.covered,
    reason:
      "captureRecallFeedback (core/search/feedback.ts) re-runs the judged query through search() " +
      "and reports whether the path came back, which is an existence oracle for any page the " +
      "caller cannot read - so the re-run carries contextReach(ctx) and is covered by root A.",
  },
  {
    surface: "brain_eval",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "scores retrieval quality (hit@k, MRR, …) over a CALLER-supplied dataset, so 'metrics, not " +
      "note bodies' was the wrong reason to exclude it: `hit` / `rank` / `expectedFound` answer " +
      "for caller-named paths and `answerContained` substring-tests a caller-supplied string " +
      "against the retrieved content, which is an existence oracle and a content oracle over " +
      "whatever corpus the run scored. runRecallBenchmark now takes the reach and passes it to " +
      "every search() it makes, so the benchmark measures the corpus this caller can reach and " +
      "root A does the withholding. brain_tune inherits it: the grid is scored with the same " +
      "benchmark.",
  },
  {
    surface: "brain_hygiene",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the freshness detector's population comes from listVaultPages(MAINTENANCE_LANE_REACH), so " +
      "reserved pages are walked IN on purpose - a scan that stopped seeing them would diagnose a " +
      "smaller vault than the one it is diagnosing - and every finding puts its page's " +
      "vault-relative path in `targets` with a title stating a fact about it. The rule is asked " +
      "on the seam the owner rule already sits on, over what the caller is told, so a detector " +
      "registered after this one inherits it; `counts` is recomputed from the visible findings and " +
      "a withheld " +
      "id lands in `unknown_ids` exactly as one nobody issued does.",
  },
  {
    surface: "brain_skill_proposals",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the page_candidates operation calls planSkillPageDrafts, which walks with " +
      "MAINTENANCE_LANE_REACH, and returns a path and title per page in `admitted` and in " +
      "`skipped` - the latter with a `detail` stating why the gate turned the page down. Both " +
      "lists are filtered at the handler and `pages_scanned` is recomputed from them whenever a " +
      "rule is live, because a corpus size taken before the filter states how many pages were " +
      "withheld.",
  },
  {
    surface: "brain_procedural_memory",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "collectEntries walks the configured roots with parseFrontmatter and returns `sourcePath` " +
      "and `title` per entry, so this surface DOES disclose a page's path and title - it is " +
      "excluded rather than swept in for completeness, and the distinction is the point of the " +
      "row. It reads procedure-kind pages under caller-named roots rather than through any of " +
      "the three read roots, and closing it means giving that walk a reach the way listVaultPages " +
      "has one, which is a fourth root to build rather than a filter to add.",
  },
  {
    surface: "brain_procedural_graph",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "rebuilds the procedural graph and hints over the same population brain_procedural_memory " +
      "walks, and reports node/edge/entry COUNTS plus generated_at rather than any page's path, " +
      "title or body - so it inherits that surface's population without inheriting its " +
      "disclosure. Excluded on the same terms and named here so the pair is visible together.",
  },
  {
    surface: "brain_recurrence",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept in for file-level completeness: it shares procedure-tools.ts with " +
      "brain_skill_proposals but reads only the recurrence ledger, whose entries are content " +
      "hashes, scope names, support counts and source ids - no page path, title or body reaches " +
      "this handler at all.",
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
    category: C.covered,
    reason:
      "src/cli/search/verbs/expand.ts calls expandHit() directly - the same root-C chunk_id " +
      "hydration brain_search_expand uses - and passes CLI_TRANSPORT_REACH, so the operator's own " +
      "shell is answered in full by decision rather than by omission.",
  },
  {
    surface: "brain backlinks",
    kind: K.cliVerb,
    category: C.covered,
    reason:
      "src/cli/brain/verbs/backlinks.ts asks reachView about the target and every ref's source " +
      "artifact, the same root-C decision brain_backlinks makes over the same index, at " +
      "CLI_TRANSPORT_REACH - so the two mirrors cannot drift on what a ref discloses.",
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
    category: C.covered,
    reason:
      "src/cli/brain/verbs/clusters.ts reaches its input set through listVaultPages with " +
      "CLI_TRANSPORT_REACH (root B) and readdirSyncs Brain/clusters for the listing, which the " +
      "root-closure sweep registers as a direct vault read that discloses nothing beyond the " +
      "operator's own shell.",
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
    category: C.covered,
    reason:
      "src/cli/brain/verbs/deep-synthesis.ts calls deepSynthesis with CLI_TRANSPORT_REACH, which " +
      "threads into search() exactly as the MCP tool does - covered transitively by root A, with " +
      "the reach stated at the call site rather than defaulted.",
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
    category: C.covered,
    reason:
      "src/cli/brain/verbs/file-context.ts calls fileContextRecall with CLI_TRANSPORT_REACH, the " +
      "same root-A path brain_file_context takes, so the CLI mirror and the MCP tool cannot drift " +
      "on which pages a caller reaches.",
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
    category: C.covered,
    reason:
      "src/cli/brain/verbs/query.ts passes CLI_TRANSPORT_REACH into QueryByTopicOptions, so the " +
      "topic selection asks the same root-C rule brain_query asks. The verdict is admit-all " +
      "because the caller is the operator's own shell, which is a decision this verb makes rather " +
      "than a question it skips.",
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
    category: C.covered,
    reason:
      "root C, the key-addressed read: the whole file - frontmatter, owner line and body prose - " +
      "is what this reader hands back, so both rules are asked before the read rather than " +
      "filtered out of the bytes afterwards. A withheld preference is reported byte for byte as " +
      "an absent one, because preference ids are pref-<topic-slug> and therefore guessable.",
  },
  {
    surface: "osb://topic/{slug}",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "the same root-C view as osb://preference/{id}, with the reach reaching the SELECTION of the " +
      "topic's current rule for the reason the owner scope already reached it: a topic resolves " +
      "to one preference, so filtering afterwards would hide a readable rule whenever a reserved " +
      "one happened to sort ahead of it.",
  },
  {
    surface: "osb://log/{date}",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "withVisibleLogEvents filters rendered log sections by every live rule over the artifacts " +
      "each event names, reach included, through the shared artifact-ref view. A day with no rule " +
      "live is returned verbatim - the split-and-rejoin is skipped entirely - so a vault the " +
      "boundary admits in full stays byte-identical.",
  },
  {
    surface: "osb://backlinks/{id}",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "the same reference-shaped root-C decision brain_backlinks makes, over the same index: the " +
      "target and every ref's source artifact are both asked, and a withheld target answers with " +
      "the empty backlink document rather than a refusal that would prove it exists.",
  },

  // --- Excluded: the index's own storage --------------------------------------
  {
    surface: "search index chunks/chunk_fts tables",
    kind: K.indexStore,
    category: C.excluded,
    reason:
      "chunker.ts's packBlocks emits a page's frontmatter block as its own chunk verbatim " +
      "(chunk_index 0), and the body as the chunks after it. A reserved page's full text is still " +
      "stored in chunks and mirrored into chunk_fts, and this wave deliberately does not change " +
      "that: excluding reserved pages from the index would take an operator's own private notes " +
      "out of their own local search, which is a product regression dressed as a hardening. What " +
      "DID change is that the indexer records what it measured of each page's declaration in " +
      "documents.visibility, so the index is self-describing and search check can report the " +
      "population it cannot measure. The column is not the read boundary - that is the live " +
      "frontmatter check at the three roots, which reads the file rather than a snapshot of it - " +
      "so anyone with file access to brain.sqlite still reads what the read side withholds, the " +
      "same trust boundary the vault's own Markdown files have.",
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

// ─────────────────────────────────────────────────────────────────────────────
// Root closure: the files that read a vault path WITHOUT one of the roots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a direct vault read applies the boundary itself, or discloses
 * nothing that needs it.
 *
 * The three read roots - `search()`'s pipeline, `listVaultPages`, and the
 * key-addressed read primitives - are where the reserved-token rule is
 * enforced, and the guarantee is only as good as the claim that every
 * caller goes through one of them. A file that opens a vault path with
 * `node:fs` directly is outside all three, so it either asks the rule on
 * its own or has a written reason why the question does not arise.
 */
export const DIRECT_VAULT_READ_CATEGORY = Object.freeze({
  /** Consults the reach rule itself, at the site of the read. */
  guarded: "guarded",
  /** Hands back nothing a page's reservation would cover. */
  discloses_nothing: "discloses_nothing",
} as const);

export type DirectVaultReadCategory =
  (typeof DIRECT_VAULT_READ_CATEGORY)[keyof typeof DIRECT_VAULT_READ_CATEGORY];

export interface DirectVaultReadEntry {
  /** Repo-relative path, exactly as the census spells it. */
  readonly file: string;
  readonly category: DirectVaultReadCategory;
  /** What the category alone does not say - the source-verified argument. */
  readonly reason: string;
}

const D = DIRECT_VAULT_READ_CATEGORY;

/**
 * Every file under `src/mcp/`, `src/cli/` and `src/openclaw/` that reads a
 * vault path through `node:fs` rather than through one of the three roots,
 * hand-verified against source.
 *
 * `tests/core/architecture/visibility-surface-census.test.ts` sweeps for
 * the shape and fails in BOTH directions - an unregistered file, and a row
 * naming a file that no longer reads that way - so this list cannot go
 * quietly stale. What the sweep cannot see is stated in that file's
 * docblock rather than implied here.
 */
export const DIRECT_VAULT_READ_REGISTRY: ReadonlyArray<DirectVaultReadEntry> = Object.freeze([
  {
    file: "src/mcp/brain/knowledge-tools.ts",
    category: D.guarded,
    reason:
      "brain_clusters lists Brain/clusters/*.md with readdirSync and brain_bridges reads " +
      "Brain/proposals/bridges.md with readFileSync, both by path and neither through a read " +
      "root. Both now ask reachView(ctx.vault, contextReach(ctx)) about each path before its " +
      "title or body crosses the boundary, which is the same decision isPathReadableAtReach " +
      "makes for a ranked result.",
  },
  {
    file: "src/cli/onboarding.ts",
    category: D.discloses_nothing,
    reason:
      "countMarkdown readdirSyncs Brain/preferences and Brain/inbox and returns the LENGTH of " +
      "the filtered list - no path, title or body leaves the function, and the caller is the " +
      "operator's own shell, which the CLI already answers at local reach. A count of files in " +
      "the operator's own Brain directory is not a disclosure to anyone else.",
  },
  {
    file: "src/cli/brain/verbs/links.ts",
    category: D.discloses_nothing,
    reason:
      "the link-repair verb readFileSyncs each page it is about to REWRITE and writes it back " +
      "atomically. It is a maintenance lane in the operator's own shell, and one that must see " +
      "every page: a repair that stopped reading reserved pages would rewrite the links around " +
      "them and leave the graph pointing at nothing.",
  },
  {
    file: "src/cli/brain/verbs/clusters.ts",
    category: D.discloses_nothing,
    reason:
      "the CLI mirror of brain_clusters, readdirSyncing Brain/clusters for the staleness " +
      "fast-path and the listing. It runs in the operator's own shell, which the CLI answers at " +
      "local reach through CLI_TRANSPORT_REACH, so the reserved-token rule admits every page " +
      "here by construction rather than by omission.",
  },
]);
