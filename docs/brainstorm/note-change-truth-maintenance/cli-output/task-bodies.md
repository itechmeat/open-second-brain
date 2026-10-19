===== t_c256d428 (priority 3) [upstream:iwe] Keep backlinks and link resolution current as notes change
**Source**: https://github.com/iwe-org/iwe/releases/tag/iwe-v0.27.0
**Repo**: iwe-org/iwe (1086 stars)
**Released**: iwe-v0.27.0 (2026-10-16T11:20:03Z)
## What
When a note is created, moved or deleted, every link and backlink that mentions it should keep resolving without anyone re-saving or re-indexing the linking note. Open Second Brain's brain_backlinks aggregator already recomputes live, but the derived search index that backs link resolution, dangling-wikilink listing and unlinked mentions goes stale after a brain_note_lifecycle write and stays stale until a manual reindex (the tool reports next_command instead of refreshing).
## Why useful for Open Second Brain
Agents rename and reorganize vault notes constantly through brain_note_lifecycle; a stale index makes recall and hygiene queries answer from pre-move addresses and reports links as dangling that are not. Resolution against the current document set removes a manual `o2b search index` step from every reorganization flow and removes the window where the agent reasons over outdated graph answers.
## Status in Open Second Brain
- **Verdict**: present_weaker
- **Evidence**: live side: src/core/brain/backlinks.ts:15-17 ("The index is recomputed on demand (no on-disk cache)") served by brain_backlinks at src/mcp/brain/query-tools.ts:518. Stale side: src/core/brain/notes/lifecycle.ts:31-33 ("the derived index still holds the old path until something re-indexes"); readIndexEvidence at src/core/brain/notes/lifecycle.ts:573-598 returns INDEX_EVIDENCE.stale with nextCommand: REINDEX_COMMAND, surfaced as index.state/next_command in src/mcp/brain/lifecycle-file-tools.ts:86-88; index-backed resolution is SQL over stored rows at src/core/search/store/links.ts:108 (resolveLinkTargets). The only freshness mechanism is the opt-in daemon `o2b search watch` (src/cli/search/verbs/watch.ts:1-7).
## Notes
Upstream change is internal to liwe (links resolved against current documents on every read) plus the workspace/inlayHint/refresh LSP notification; the transferable idea is auto-refreshing (or live-resolving) the derived index after note file changes. Slot-in: trigger the existing incremental indexVault pass at the end of an applied noteLifecycle, or resolve search-layer links live the way buildBacklinkIndex does.

===== t_5914c4c1 (priority 3) [upstream:iwe] Rewrite inbound wikilinks on rename with minimal, target-safe spellings
**Source**: https://github.com/iwe-org/iwe/releases/tag/iwe-v0.27.0
**Repo**: iwe-org/iwe (1086 stars)
**Released**: iwe-v0.27.0 (2026-10-16T11:20:03Z)
## What
A rename or move should leave links that still resolve untouched, rewrite the rest to the shortest spelling that resolves (not the full path), and repair third-party bare-name links that would silently start pointing at the renamed note. Open Second Brain's brain_note_lifecycle rewrites inbound links but preserves each link's spelling form (path links stay full-path), and it withholds ambiguous bare-basename rewrites entirely, leaving them unresolved, rather than repairing links whose target silently changes.
## Why useful for Open Second Brain
Rename and move are the note operations agents get wrong most often; tidier rewritten spellings keep vaults grep- and Obsidian-friendly after agent reorganizations, and repairing would-be-retargeted links keeps references pointing at what the author meant instead of stranding them as unresolvable basenames that every later tool must special-case.
## Status in Open Second Brain
- **Verdict**: present_weaker
- **Evidence**: retargetsFor at src/core/brain/notes/lifecycle.ts:1161-1174 rewrites path-form spellings to path-form (form-preserving, never shortest); decideBasename at src/core/brain/notes/lifecycle.ts:702-720 returns BASENAME_REWRITE.ambiguous and withholds the bare-basename rewrite when the destination basename is already carried elsewhere, per the rationale at lifecycle.ts:40-48 (an ambiguous basename resolves to nothing by the exact-one ladder). Tool surface: src/mcp/brain/lifecycle-file-tools.ts:351 ("Rewrites [[links]]"). not found - any shortest-resolving-name spelling policy: rg -i "shortest" over src matches only src/core/brain/wikilink.ts:86 (fence-run logic, unrelated); not found - any rewrite of third-party links to preserve targets across an ambiguous rename.
## Notes
Open Second Brain's withholding stance is a deliberate safety choice; upstream instead actively fixes the third-party link so it keeps its target. Both behaviors (shortest-form output, retarget repair) are small, well-scoped extensions of retargetsFor/decideBasename.

===== t_8c72a23e (priority 3) [upstream:gbrain] Entity resolution that skips retired pages, follows successors and normalizes alias spellings
**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.60.283.0
**Repo**: garrytan/gbrain (18439 stars)
**Released**: v0.60.283.0 (2026-10-17T09:47:19Z)
## What
When extraction writes facts about a person or company, upstream never lets a fuzzy or name-word guess land on a retired or superseded page, resolves a direct reference to a retired page through its superseded_by or merged_into chain to the live page, and matches aliases whether the name words are joined by spaces, hyphens, underscores or a slug directory prefix.
## Why useful for Open Second Brain
Open Second Brain anchors extracted facts to entity ids at write time, so an anchoring or recall path that could pick a retired alias page would silently pool facts on a dead record. Separator-tolerant alias matching matters because vault prose writes one name as "Ada Lovelace", "ada-lovelace" and "ada_lovelace", and today those are three distinct identities.
## Status in Open Second Brain
- **Verdict**: present_weaker
- **Evidence**: Retired-page exclusion already holds: src/core/brain/entities/status-scope.ts:14-15 restricts identity-holding to active records and the same canonical scope gates every name and alias resolution; src/core/brain/atomic-facts.ts:129-133 skips entities outside canonical scope before matching; src/core/brain/link-graph/alias-index.ts:90 reserves retired canonical names. Gaps: src/core/brain/entities/canonical.ts:5-8 normalizes only NFC, case, whitespace and quote variants, so separator-joined spellings stay distinct; src/core/brain/lifecycle/tombstone.ts:104 and :229-235 store the superseded_by pointer but no resolution path follows it automatically - it is reachable only through the claim-graph projection (src/core/brain/claim-graph.ts:277, exposed as the replaced operation at src/mcp/brain/knowledge-tools.ts:862).
## Notes
The collected release body is truncated mid-sentence in the itemized alias-matching section (cut at "a folded hi"), so the exact fold list beyond space, hyphen and underscore was not judgeable. Adjacent board card t_fd842db0 covers excluding non-content files from ambiguous link resolution, a different half of resolution hygiene.

===== t_681e498a (priority 3) [upstream:gbrain] Conversation facts anchored to the entity pages they reference, with relink
**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.60.284.0
**Repo**: garrytan/gbrain (18439 stars)
**Released**: v0.60.284.0 (2026-10-17T10:14:19Z)
## What
Facts extracted from meeting and conversation pages upstream now attach to the person or company the page links even when the fact sentence itself does not name them, and a local relink pass attaches historically stored facts the same way at no model cost.
## Why useful for Open Second Brain
Open Second Brain anchors extracted assertions only when a normalized name or alias form literally appears in the anchor text, so a meeting note that refers to a person as "she" or "the founder" leaves the fact unanchored, and there is no bulk way to re-anchor stored facts after aliases improve.
## Status in Open Second Brain
- **Verdict**: present_weaker
- **Evidence**: src/core/brain/atomic-facts.ts:124-134 anchorEntities matches only normalized name and alias forms against the assertion text and only for entities in canonical scope. not found - no link-derived or page-level fact attachment and no bulk relink of stored facts to entities (rg -i 'relink' over src and tests: only note-move inode relinking at src/core/brain/destructive-sites.ts:423 and src/core/brain/notes/lifecycle.ts:807).
## Notes
Adjacent board card t_13ca52c4 covers meeting attendance determination (attendee versus merely mentioned), a different precision problem from fact-to-entity attachment. A link-derived attachment pass must re-derive links server-side from note bytes, per the kernel invariant that server-derived facts outrank caller-supplied claims.

