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
      "the caller passes no visibility argument at all. A zero-result answer below local " +
      "reach carries no coverage receipt and no index count: a not_found names the index time " +
      "only and an unknown states the fixed reason of its unknown_reason " +
      "(corpusVerdictAtReach in pipeline/outcome.ts, withoutCorpusCounts). Its root coverage " +
      "answers at the caller's reach: below local reach an authorized note root counts as " +
      "reached only through a page that caller may read (probeRetrievalCorpus threads the " +
      "reach into indexRootCoverage's admit predicate), so a root holding nothing else answers " +
      "like an empty one. Its ranking statistics are a stated residual: the bm25 corpus " +
      "statistics and the diversity rerank are computed over the shared index, which counts " +
      "pages the caller may not read (reserved pages, the Brain log), so two vaults that " +
      "return the same paths remotely can return different scores and rerank reasons - a weak " +
      "count signal across the whole index, not a page or its content.",
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
      "and Brain/retired via collectPreferencePages, and the MCP tool hands packContext a " +
      "reachView predicate that drops a reserved candidate before ranking and budgeting - so a " +
      "page tagged visibility: private contributes nothing to items, lanes, skipped, warnings, " +
      "deduped_from or the receipt at remote reach (t_sec_pack_reach). It stays " +
      "EXCLUDED because the slice also injects the bodies of pages that ARE readable, and a " +
      "readable hub page's body can name a reserved page in a wikilink - second-hand text no " +
      "per-page gate can rewrite, which is true of every content-returning surface and is why " +
      "`search check` still reports this surface to operators.",
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
    category: C.covered,
    reason:
      "findUnlinkedMentions (core/brain/link-graph/unlinked-mentions.ts) walks Brain/preferences " +
      "and Brain/retired itself, so the MCP handler passes reachView alongside the owner scope: " +
      "a reserved SOURCE is skipped before its body is read, and a reserved TARGET answers with " +
      "no mentions - the reply an absent target gets - because each mention's `term` is the " +
      "target's title or alias.",
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
    category: C.covered,
    reason:
      "discoverIdeas (core/brain/idea-discovery.ts) takes the handler's " +
      "readableAtContextReach(ctx) as its include option and leaves a page the caller may not " +
      "read at its reach out of the inbound-link walk and the candidates, before ranking and " +
      "the cap, so a withheld research page is answered as an absent one.",
  },
  {
    surface: "brain_dead_ends",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "list keeps only the entries and parse warnings whose page readableAtContextReach(ctx) " +
      "keeps, so a withheld dead end is absent from the answer; record writes the caller's own " +
      "dead end and, below local reach, leaves out the ids the overflow trim archived. The trim " +
      "still counts every active dead end against the cap but, handed the same predicate, " +
      "archives only the readable ones, so a withheld dead end is never moved; a same-day id " +
      "collision with a withheld dead end still takes a suffix (inherent create-collision " +
      "residual).",
  },
  {
    surface: "brain_claims",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "toolBrainClaims's own docblock (knowledge-tools.ts) states a claim row carries the " +
      "artifact's id, vault-relative path, topic and full principle text; every row-returning " +
      "operation and the rebuild count keep a row only when it passes gatedOwnerScopeView and, " +
      "at the caller's reach, reachView over its page, its id under the pref- and ret- " +
      "spellings, and the records that superseded or contest it.",
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
    category: C.covered,
    reason:
      "show and suggest ask reachView; assign and remove resolve the page through " +
      "resolveNotePath with readableAtContextReach(ctx), so a page the caller may not read is " +
      "refused with 'note does not exist' before its frontmatter is read or written.",
  },
  {
    surface: "brain_tiers",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "check keeps only the drift rows whose page passes the handler's " +
      "readableAtContextReach(ctx), and restore and accept refuse any other page with the 'not " +
      "indexed' error a page the index never saw gets, before the drift is read or anything is " +
      "written.",
  },
  {
    surface: "brain_doctor",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the read-only report keeps every issue stream through the owner view ANDed with " +
      "reachView, over the doctorIssueRefs each issue names (path, target, sources, message " +
      "wikilinks), takes ok and trust_verdict again over the kept issues, and below local reach " +
      "recounts the tier-drift warning over the rows readableAtContextReach(ctx) keeps. The " +
      "doctor pass is handed the same predicate, so the counts its checks take before any " +
      "issue is filtered answer at the caller's reach too: a withheld page spends no slot of " +
      "the removed-tool warning cap or of the per-code uncertain cap, is neither a state nor a " +
      "consumer in the stale-dependency audit, and adds no principle, topic or preference to " +
      "the semantic-health detectors behind the concept-gap and contradiction warnings, and a " +
      "withheld vault-root instruction file raises no ceiling warning. The " +
      "repair branch hands applyRepair the caller's reach, which bounds the findings before the " +
      "plan is derived, and the same predicate, so the checks behind the plan count and cap " +
      "over readable pages too: a withheld record is neither planned, counted nor written, and " +
      "the unfixable counts are those of a vault without it.",
  },
  {
    surface: "schema_inspect",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the lint and orphans views keep only the findings whose named pages (path, or the source " +
      "and target of a blocked link) pass reachView, and below local reach stats counts the same " +
      "kept findings; graph, explain_type, active_pack and packs read the schema pack and its " +
      "token usage counts, never a page path, title or body. Swept in through schema-admin.ts.",
  },
  {
    surface: "schema_apply_mutations",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept in for file-level completeness because schema-tools.ts also registers " +
      "schema_inspect: it writes Brain/_brain.yaml and returns the resulting pack, its diff and " +
      "the audit path, never a note path, title, or body.",
  },
  {
    surface: "brain_health",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "runs runDoctor's semantic-health pass handed readableAtContextReach(ctx), so the " +
      "detectors read only the preferences and signals the caller may read: concept_gaps (a " +
      "term and its frequency over principle text, which no reference view can judge) and the " +
      "suppressed counts are taken over those principles and topics, and a withheld preference " +
      "joins no contradiction, stale claim or batch. Each finding naming preferences by id is " +
      "then kept only when every member passes the gated owner view ANDed with reachView, and " +
      "the verdict is folded again over the kept families.",
  },
  {
    surface: "brain_status",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "its hygiene count asks the owner view ANDed with reachView and its cited pages answer " +
      "readableAtContextReach(ctx), but the doctor error and warning counts and the preference " +
      "counts are taken over the whole Brain layer, so they move with a reserved record " +
      "(a stated, deferred residual: no count is recomputed per reader yet); it returns counts " +
      "and problem labels, never a note path, title, or body.",
  },
  {
    surface: "brain_maintenance",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "below local reach run is refused with a fixed sentence (MAINTENANCE_RUN_LOCAL_ONLY) " +
      "before the lease or any write, because it runs the dream pass, the reindex, the bridges " +
      "and clusters lanes and custom tasks over the whole vault; status returns the lease and " +
      "journal only.",
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
    category: C.covered,
    reason:
      "diarize() is handed readableAtContextReach(ctx): a subject page the caller may not read " +
      "answers as an unknown entity, an ingested-source page the caller may not read is neither " +
      "evidence, counted nor named in document_set, and the link candidates are filtered by the " +
      "same predicate beside the owner scope.",
  },
  {
    surface: "brain_context",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "toolBrainContext (context-tools.ts) serves Brain/active.md's bytes only to a local " +
      "reader with no owner scope enforced; any other reader gets renderActiveForReader's " +
      "in-memory render without the preference and retired records readableAtContextReach(ctx) " +
      "withholds, counts included, so the choice never depends on what is withheld.",
  },
  {
    surface: "brain_agent_query",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "queryAgentSources (core/brain/agent-source/query.ts) takes the handler's " +
      "reachView(ctx.vault, contextReach(ctx)) as its view option and drops, before the roster " +
      "is folded, every contribution whose named page or event-body string the caller may not " +
      "read at its reach, so a note-write row for a withheld page is answered as one for an " +
      "absent page; agent_scope still gates ownership.",
  },
  {
    surface: "brain_writes",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "listNoteWrites / planNoteRevert (core/brain/notes/) project `note-write` events out of " +
      "the Brain log and never open the notes they name, so the MCP handler asks reachView over " +
      "every row's target before counting: at remote reach a write to a reserved page - or to " +
      "a file that can no longer be read, which fails closed - is dropped from both `list` and " +
      "`plan_revert`, and `total_matched` counts only what the caller may see.",
  },
  {
    surface: "brain_agent_diff",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "diffAgentSources folds queryAgentSources, and the handler passes the same " +
      "reachView(ctx.vault, contextReach(ctx)) view brain_agent_query does, so a contribution " +
      "naming a page the caller may not read at its reach is dropped before any count or topic " +
      "map is built; ownership is gated by the GATED server identity.",
  },
  {
    surface: "brain_anticipatory_context",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "below local reach the handler builds the bundle for the caller with the same reachView " +
      "candidate filter brain_context_pack hands packContext, asked before ranking and " +
      "budgeting; it neither reads nor writes the shared per-root cache entry, so a bundle " +
      "cached for the operator is never served to a remote caller and a filtered bundle never " +
      "replaces the operator's, and it answers cache_state miss. Session hits follow the " +
      "session tools' <private> region model, a stated residual. Local reach is byte-identical. " +
      "It stays EXCLUDED for the reason brain_context_pack does: the bundle carries the bodies " +
      "of readable pages, and a readable page's body can name a reserved page in a wikilink.",
  },
  {
    surface: "brain_context_receipts",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "show returns a stored receipt's payload - the same content a prior brain_context_pack " +
      "call recorded - with no visibility re-check at read time; only a receipt-level " +
      "private/redacted flag applies, which is a different axis. Below local reach a " +
      "SessionStart injection receipt (pack-tools.ts receiptAtReach) drops the standing-rules " +
      "and scoped-rules items and source references and every figure that counts or measures " +
      "them (item_count, final_text_hash, final_text_chars, total_bytes, total_tokens, " +
      "scoped_rules_chars, budgeted_source_count), drops the budget block when no budgeted body " +
      "is left, and summary folds without the rule items, so a degraded injection that kept " +
      "only the rules counts as an empty receipt. A measured injection receipt whose every item " +
      "was a rule block (isRuleOnlyInjection) is withheld whole: list and summary exclude it " +
      "before their limit and fold bound, and show answers it as an unknown id.",
  },
  {
    surface: "brain_event_trace",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "resolveLogEventTraces (core/brain/event-trace.ts) takes the handler's " +
      "reachView(ctx.vault, contextReach(ctx)) as its view option and drops, before the limit " +
      "and the totals, every event whose artifacts or body strings name a page the caller may " +
      "not read at its reach, and every attached trace whose handoff reference it hides; a " +
      "dream shared with a withheld record is kept with its readable transitions only " +
      "(log-events-at-reach.ts), its body and artifacts read from that form, so the count " +
      "does not fall when a reserved preference shares a dream; each record id is judged " +
      "under its pref- and ret- spellings.",
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
    surface: "brain_brief",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "view=digest (brief-tools.ts) is rendered for the caller below local reach - renderDigest " +
      "is handed readableAtContextReach(ctx), so a reserved preference or retired record is " +
      "absent from its rows and counts (a dream shared with one is counted with its readable " +
      "transitions only), and no report snapshot is taken or delta shown; " +
      "view=morning is handed the same predicate and leaves such a preference out, and shows " +
      "no pending trigger or trigger-queue failure and marks nothing delivered; view=daily " +
      "and view=weekly answer at the caller's reach for the ids they name - a status " +
      "transition, retirement or contradiction naming a record the caller cannot read (under " +
      "its pref- or ret- spelling) is dropped through readerRefView, source_pointers are " +
      "recollected from the evidence events the caller may see, events_by_kind and vault_delta " +
      "are recomputed from that same event selection (evidence on a withheld record, a dream " +
      "whose every transition is withheld and any other event scoped to a withheld record are " +
      "not counted), and no report snapshot is taken or delta shown; view=today renders its " +
      "recent activity through the shared log-event rule (log-events-at-reach.ts via " +
      "reach-events.ts) before the limit and the totals, so an event naming a withheld record " +
      "is absent and a shared dream shows only its readable transitions, and lists an obligation " +
      "or an open loop only when readableAtContextReach(ctx) passes its page, tested before the " +
      "note is read, so neither its text, its path nor the totals move; view=monthly counts the " +
      "month's events through the same log-event rule before the transition, retirement, " +
      "contradiction and neglected-area counts; view=operator takes its doctor counts over the " +
      "findings the owner view ANDed with reachView keeps (the doctor pass itself handed " +
      "readableAtContextReach(ctx), so the removed-tool and uncertain caps, the " +
      "stale-dependency states and consumers and the semantic-health detectors count only " +
      "readable pages), its digest counts over the preference, retired and inbox pages the " +
      "caller may read, its instruction-file warnings over the vault-root files the caller may " +
      "read, its top actions by target before the top-N slice, its verification entries and " +
      "their counts by the record and page each names, and the trust verdict again over those " +
      "kept streams. " +
      "Residual: the operator view's dream_summary counts (dream warnings, uncertain and " +
      "quarantined entries of the dry-run dream), and the dream warnings the trust verdict " +
      "folds in, are still taken over the whole Brain layer and name no id.",
  },
  {
    surface: "brain_analytics",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "view=timeline, view=belief_evolution and view=concept_synthesis answer at the caller's " +
      "reach (analytics-tools.ts via reach-events.ts): a timeline event naming a record the " +
      "caller cannot read under its pref- or ret- spelling is dropped before the limit and the " +
      "total, a shared dream is kept while one transition is readable; a belief-evolution row " +
      "is asked over every record it names and a refused pref_id target answers as an absent " +
      "one; a concept-synthesis linker or mention from an unreadable page is dropped and a " +
      "refused target answers as an empty cluster. Residual: view=attention_flows and " +
      "view=dedup are filtered by the gated owner view only, never by reach.",
  },
  {
    surface: "brain_pre_compress_pack",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "buildPreCompressPack (core/brain/pre-compress-pack.ts) is handed " +
      "readableAtContextReach(ctx): the top-K walk skips a preference the caller cannot read, " +
      "and below local reach the active head is always the reader render of Brain/active.md.",
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
      "returns no note content; included for completeness of the file-level sweep only. Its " +
      "corpus statement below local reach carries no coverage receipt and no index count, for " +
      "every state (corpusVerdictAtReach, withoutCorpusCounts), and its root coverage answers " +
      "at the caller's reach the same way brain_search's does (probeRetrievalCorpus with " +
      "contextReach).",
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
      "the freshness detector's population comes from listVaultPages(MAINTENANCE_LANE_REACH), " +
      "so reserved pages are walked IN on purpose - a scan that stopped seeing them would " +
      "diagnose a smaller vault than the one it is diagnosing - and every finding puts its " +
      "page's vault-relative path in `targets` with a title stating a fact about it. The rule " +
      "is asked on the seam the owner rule already sits on, over what the caller is told, so a " +
      "detector registered after this one inherits it; `counts` is recomputed from the visible " +
      "findings and a withheld id lands in `unknown_ids` exactly as one nobody issued does. " +
      "refresh plans only the derived pages readableAtContextReach(ctx) keeps, so a withheld " +
      "stale or orphaned page is neither named, re-derived nor archived.",
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
    category: C.covered,
    reason:
      "the handler filters list through readableAtContextReach(ctx) and recounts its total, " +
      "reports reconcile counts over readable pages only, and refuses mark_used and " +
      "mark_outcome on a withheld entry with the unknown-id error, before writing, so a " +
      "procedure page the caller may not read at its reach is answered as an absent one.",
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
      "surface, but its Brain block is computeBrainStatus over the whole Brain layer, so the " +
      "preference counts and the last apply-evidence time move with a reserved record (a " +
      "stated, deferred residual); included " +
      "for the file-level sweep (tools.ts imports listVaultPages for second_brain_query, defined " +
      "in the same file).",
  },
  {
    surface: "vault_health",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "runs vault/config/plugin-manifest health checks and state-surface inventory - no note " +
      "content crosses this surface; included for completeness of the file-level sweep only.",
  },
  {
    surface: "brain_obligation",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "every operation asks readableAtContextReach(ctx) about Brain/obligations/<slug>.md " +
      "before the page is read or written: list keeps only the obligations the caller may read, " +
      "show answers a withheld slug as an absent one ({present: false}), and done and remove " +
      "refuse it with the 'no obligation' error an absent slug gets, so the page is neither " +
      "completed nor archived. Below local reach remove leaves the archive name, which steps " +
      "past withheld archived pages, out of the answer. Residual: add over a taken slug is " +
      "refused whoever may read the page, because creating it would replace the withheld page.",
  },
  {
    surface: "brain_agenda",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept in for file-level completeness because calendar-tools.ts also registers " +
      "brain_obligation: synthesizeAgenda folds the caller-supplied calendar events into " +
      "conflicts and focus blocks and never reads a vault page, so no note path, title or body " +
      "crosses this surface.",
  },
  {
    surface: "brain_trigger",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "scan runs scanTriggers handed readableAtContextReach(ctx), so its semantic-health and " +
      "retention sources read only the records the caller may read: the candidates total counts " +
      "none it may not, and a scan from a remote caller writes no trigger about a withheld " +
      "record. Every trigger row - created, skipped, list, history - is kept only when each " +
      "artifact it names (source_artifacts, the wikilinks in its reason, the cooldown key " +
      "segments) passes the gated owner view ANDed with reachView, and a transition on a trigger " +
      "the caller may not see is refused with the 'unknown trigger' error an absent id gets.",
  },
  {
    surface: "brain_intention",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "list and show return intention chains - Brain-authored scope records with their text, " +
      "history and path; the handler asks readableAtContextReach(ctx) about each chain's page, " +
      "so below local reach a withheld chain is listed by no row, shown as absent and refused " +
      "by move with the error an absent scope gets. set over a withheld chain is refused rather " +
      "than read and rewritten (the one answer that cannot match an absent chain's), and move " +
      "leaves the archive name, which steps past withheld history files, out of the answer.",
  },
  {
    surface: "brain_stale_scan",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "findStaleEntries walks the preference and signal records and names each stale one by id, " +
      "topic and vault-relative path; the handler keeps a row only when its path and id pass the " +
      "gated owner view ANDed with reachView, so below local reach a withheld record is listed " +
      "by no row. stale_log_files names Brain/log shards by date, which are shared by " +
      "construction and carry no page content.",
  },
  {
    surface: "brain_review_candidates",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the dry-run dream preview runs with previewReadable bound to readableAtContextReach(ctx), " +
      "so below local reach it clusters, counts and routes only the signals, preferences and " +
      "retired records the caller may read: clusters_below_threshold and intent_reviews fold no " +
      "withheld signal. would_create, would_promote, would_retire, would_supersede and " +
      "gated_retires keep a row only when both the pref- and the ret- spelling of its id pass " +
      "the gated owner view ANDed with reachView, and signal_novelty asks the same of each " +
      "signal's path and id. retire_siblings pairs two preference ids, and a pair is kept and " +
      "counted only when both ids pass the same view, so a withheld retiring or sibling " +
      "preference moves neither a row nor a count.",
  },
  {
    surface: "brain_retention",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "buildRetentionReview names retired preferences and processed signals by id and " +
      "vault-relative path; the handler keeps a recommendation only when its path and id pass " +
      "the gated owner view ANDed with reachView, and counts the summary again over the kept " +
      "rows, so a withheld record moves neither a row nor a count.",
  },
  {
    surface: "brain_tension",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "detect hands detectTensionsInVault readableAtContextReach(ctx), so a note the caller " +
      "may not read is skipped before it is opened: it is not counted in scanned_files, takes " +
      "part in no pair and names no tension. A persisted tension page carries the stricter " +
      "visibility of its two source notes (strictestVisibility), and list, verify, show and the " +
      "confirm, dismiss and resolve transitions ask the same predicate about the tension page's " +
      "vault-relative path, answering a withheld one as absent ('no tension') before any write.",
  },
  {
    surface: "brain_lifecycle",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "tombstone, supersede and temporal-replace resolve each page argument through " +
      "resolveNotePath with readableAtContextReach(ctx): a page the caller may not read is " +
      "refused with the 'note does not exist' error a missing page gets, before anything is " +
      "written. curator keeps a slice row only when its key (a page path or a memory id) passes " +
      "the gated owner view ANDed with reachView. tip builds its chain lookup over the Brain " +
      "pages readableAtContextReach(ctx) keeps (buildChainLookup), so a withheld id reads as " +
      "unknown and a walk stops at it.",
  },
  {
    surface: "brain_derive_fact",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "deriveFact is handed readableAtContextReach(ctx): a premise preference the caller may " +
      "not read is refused with the missing-premise error before anything is written. A slug " +
      "colliding with a withheld preference still refuses as existing, the inherent " +
      "create-collision residual.",
  },
  {
    surface: "brain_decision",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "every action asks readableAtContextReach(ctx) about Brain/decisions/decision-<slug>.md: " +
      "list, compare, similar and recall skip a page the caller may not read; show, outcome and " +
      "rate refuse it with 'no decision: <slug>' before any write; history drops receipts whose " +
      "subject the gated owner view ANDed with reachView hides, before the total and paging. " +
      "record over an occupied withheld slug refuses 'decision already exists', the inherent " +
      "create-collision residual; the review obligation record opens names the decision's title " +
      "at default visibility unless the operator reserves it too.",
  },
  {
    surface: "brain_scaffold_stub",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "list drops sources the caller may not read (the owner scope ANDed with " +
      "readableAtContextReach(ctx)) and a target left with no readable source; write refuses an " +
      "unreadable source as unknown_source; the target_resolves and target_ambiguous refusals " +
      "name no unreadable path. An occupied withheld target still refuses, the inherent " +
      "create-collision residual.",
  },
  {
    surface: "brain_note_lifecycle",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "swept in for file-level completeness because lifecycle-file-tools.ts also registers " +
      "brain_scaffold_stub: rename, move, archive and delete resolve the note through the reach " +
      "predicate and refuse a page the caller may not read with the error a missing note gets, " +
      "before anything is read or written. A move or rename onto an occupied withheld " +
      "destination still refuses as occupied, the inherent create-collision residual, and an " +
      "applied move still rewrites links inside withheld pages without naming them.",
  },
  {
    surface: "brain_create_note",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the write receipt carries the page lint (core/brain/page-lint.ts lintWrittenPages, through " +
      "notes-tools.ts noteWriteResult), whose near-duplicate hint names sibling pages by path and " +
      "counts the siblings it skipped or could not read; noteWriteResult binds the lint to " +
      "readableAtContextReach(ctx), so a sibling the caller may not read is dropped at the " +
      "directory listing, before it is scored and before candidates_skipped or " +
      "candidates_unreadable count it; the wikilink and merged-link checks ask the same " +
      "predicate, so a link to a withheld Brain page reads as broken and a merge chain ends at " +
      "its first withheld hop, and the receipt answers as if the page were absent. " +
      "A create onto an occupied withheld path still refuses as occupied, the inherent " +
      "create-collision residual.",
  },
  {
    surface: "brain_update_note",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the write receipt carries the page lint (core/brain/page-lint.ts lintWrittenPages, through " +
      "notes-tools.ts noteWriteResult), whose near-duplicate hint names sibling pages by path and " +
      "counts the siblings it skipped or could not read; noteWriteResult binds the lint to " +
      "readableAtContextReach(ctx), so a sibling the caller may not read is dropped at the " +
      "directory listing, before it is scored and before candidates_skipped or " +
      "candidates_unreadable count it; the wikilink and merged-link checks ask the same " +
      "predicate, so a link to a withheld Brain page reads as broken and a merge chain ends at " +
      "its first withheld hop, and the receipt answers as if the page were absent. " +
      "The target itself resolves through the same predicate and a withheld one is refused " +
      "with the error a missing note gets.",
  },
  {
    surface: "brain_append_note",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the write receipt carries the page lint (core/brain/page-lint.ts lintWrittenPages, through " +
      "notes-tools.ts noteWriteResult), whose near-duplicate hint names sibling pages by path and " +
      "counts the siblings it skipped or could not read; noteWriteResult binds the lint to " +
      "readableAtContextReach(ctx), so a sibling the caller may not read is dropped at the " +
      "directory listing, before it is scored and before candidates_skipped or " +
      "candidates_unreadable count it; the wikilink and merged-link checks ask the same " +
      "predicate, so a link to a withheld Brain page reads as broken and a merge chain ends at " +
      "its first withheld hop, and the receipt answers as if the page were absent. " +
      "The target itself resolves through the same predicate and a withheld one is refused " +
      "with the error a missing note gets.",
  },
  {
    surface: "brain_write_batch",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "the write receipt carries the page lint (core/brain/page-lint.ts lintWrittenPages, through " +
      "notes-tools.ts noteWriteResult), whose near-duplicate hint names sibling pages by path and " +
      "counts the siblings it skipped or could not read; noteWriteResult binds the lint to " +
      "readableAtContextReach(ctx), so a sibling the caller may not read is dropped at the " +
      "directory listing, before it is scored and before candidates_skipped or " +
      "candidates_unreadable count it; the wikilink and merged-link checks ask the same " +
      "predicate, so a link to a withheld Brain page reads as broken and a merge chain ends at " +
      "its first withheld hop, and the receipt answers as if the page were absent. " +
      "Every page the batch committed is linted under the one predicate, and the update and " +
      "append operations refuse a withheld target with the error a missing note gets.",
  },
  {
    surface: "brain_expire",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "setExpiration is handed readableAtContextReach(ctx) and passes over a candidate file the " +
      "caller may not read as if it were not there, so a withheld signal or preference is " +
      "refused with the unknown-id error (ExpirationTargetNotFoundError, the same searched " +
      "list) and nothing is written to it.",
  },
  {
    surface: "brain_feedback",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "it writes the caller's own inbox signal (and, with force_confirmed, its preference) from " +
      "the caller's arguments; the conflict advisory and the routing hint " +
      "(adviseIncomingFeedback, adviseUnroutableCapture) score and count only the preferences " +
      "and signals readableAtContextReach(ctx) keeps. force_confirmed over an occupied withheld " +
      "slug still refuses with 'preference already exists', the inherent create-collision " +
      "residual: only overwriting the page would hide it.",
  },
  {
    surface: "brain_note",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept in for file-level completeness because feedback-tools.ts also registers " +
      "brain_expire: appendBrainNote appends the caller's own line to today's log and answers " +
      "with the log path and agent; it reads no vault page.",
  },
  {
    surface: "brain_observed_use",
    kind: K.mcpTool,
    category: C.excluded,
    reason:
      "swept in for file-level completeness because feedback-tools.ts also registers " +
      "brain_expire: emitObservedUse stores the caller-supplied verdicts as one continuity " +
      "record and answers with its id, the entry count and the timestamp; it reads no vault page.",
  },
  {
    surface: "brain_apply_evidence",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "appendApplyEvidence is handed readableAtContextReach(ctx): a preference the caller may " +
      "not read is refused with the missing-preference error (BrainPreferenceNotFoundError) " +
      "before any write, exactly as an absent id, and the apply_evidence operation of " +
      "brain_write_batch asks the same predicate.",
  },
  {
    surface: "brain_dream",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "Below local reach only a dry run is served, planned over the records the caller may read " +
      "as if the others were absent (previewReadable, the readableAtContextReach(ctx) " +
      "predicate); a real pass, a single step and the staged lifecycle are refused with one " +
      "fixed answer before anything is read or written. A preference the pass drafts carries " +
      "the strictest visibility of the signals it is drafted from and of the record it " +
      "supersedes or rebuts (strictestVisibilityOf), so reserved signal text never becomes a " +
      "default-visibility preference; a refresh keeps the page's own visibility line.",
  },
  {
    surface: "brain_intent_review",
    kind: K.mcpTool,
    category: C.covered,
    reason:
      "buildIntentReview folds inbox signal clusters into a topic, a decision, a signal count " +
      "and a risk band; the handler hands it readableAtContextReach(ctx), so below local reach " +
      "it folds only the signals and rejected retired records the caller may read, and a " +
      "withheld one moves no topic, count or decision.",
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

  // --- MCP resources ---------------------------------------------------------
  {
    surface: "osb://preferences/active",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "readActive (resources.ts) passes the request view (owner view ANDed with reachView) and " +
      "whether the request is below local reach to readActiveForReader, which serves the shared " +
      "file only to a local reader with no owner scope and otherwise renders the digest without " +
      "the preference and retired records the reader cannot see, stamped with the file's " +
      "generated_at.",
  },
  {
    surface: "osb://lessons",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "readLessons (resources.ts) serves Brain/lessons.md's bytes only to a local reader with no " +
      "owner scope; any other reader gets renderLessonsForReader, handed the request view " +
      "(owner view ANDed with reachView): a preference or dead-end it cannot read, and every " +
      "apply-evidence event naming a page it cannot read, is absent, scored at the generation " +
      "on disk.",
  },
  {
    surface: "osb://digest/latest",
    kind: K.mcpResource,
    category: C.covered,
    reason:
      "readDigestLatest (resources.ts) hands renderDigest the request view below local reach: a " +
      "preference or retired record the caller cannot read is absent from every row and count, " +
      "with the log events, backlink sources and action targets naming one, and the agent " +
      "summary counts only the events the caller may read; the token-footprint action " +
      "measures the whole vault.",
  },
  {
    surface: "osb://status",
    kind: K.mcpResource,
    category: C.excluded,
    reason:
      "computeBrainStatus() output, same unfiltered whole-vault-reader class; no visibility " +
      "check, so its preference and retired counts move with a reserved record (a stated, " +
      "deferred residual).",
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
