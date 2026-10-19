# Note-change truth maintenance - derived knowledge follows note writes

**Status:** draft
**Author:** orchestrator (via feature-release-playbook, host-mode wave cycle-20261019)
**Audience:** implementation
**Kanban cards:** t_c256d428, t_5914c4c1, t_8c72a23e, t_681e498a

## Problem statement

When a note is created, renamed or deleted, everything derived from it quietly diverges: the derived search index keeps the old path until the next search happens to notice (freshen-on-read heals it within about a minute of a later read, and only then); inbound wikilinks are rewritten preserving their original spelling form, so links grow longer than they need to be and ambiguous bare names are withheld entirely; extracted facts anchor to entity pages only through literal normalized substrings, so "Ada Lovelace" in a fact never anchors a page reachable as "ada-lovelace", and a fact extracted from a page that links an entity never attaches to that entity unless the sentence names it.

## Scope

- F1 (t_5914c4c1): on rename/move, inbound wikilinks are rewritten to the minimal spelling that still resolves to the destination under the store's exact-one rule; third-party bare-name links whose resolution the rename provably changes are repaired to the unambiguous spelling of their pre-rename target. Ambiguous-basename withholding stays.
- F2 (t_c256d428, reshaped by premise verification): an applied note lifecycle write spawns one detached, claim-guarded incremental index refresh (the freshen-on-read pattern, force-claimed), so the staleness window starts closing at the write instead of at the next search. The index stays a reported fact: the honesty contract sentences are updated to describe the claim, not to declare an invariant.
- F3 (t_8c72a23e residue): separator-tolerant alias matching in the two anchoring kernels: anchor forms match runs of space, hyphen or underscore in the haystack, and slug-prefixed forms match at a path-segment boundary. Identity keys (normalizeEntityName) are untouched.
- F4 (t_681e498a): link-derived fact attachment: extraction callers resolve the source page's outbound links server-side and pass candidate entity ids into the extraction call; the kernel unions them into the text-derived anchors (first body-order entity link wins as primary; all matches anchor, matching today's multi-name behavior). A fifth maintenance lane task recomputes anchors for page-sourced signals additively (never removes), dry-run by default, local reach only.

## Out of scope

- Following superseded_by/merged_into chains in anchoring (refuted: write-side anchoring already filters ENTITY_STATUS_SCOPE.canonical; recall already follows successor chains at post-rank.ts:179-201).
- Any write-to-index hook on the synchronous write path (Variant 2 rejected: index write on the guarded-write critical path).
- Turning IndexEvidence into a maintained invariant; changing normalizeEntityName identity keys; any stored-key migration.
- Source-kind expansions, search-language changes, unlinked-mentions indexing (it is a live directory walk, not index-backed).

## Chosen approach

Variant 1 of the consultant's three ("Detached refresh claims, contract-preserving write side"), agreed by the orchestrator: the wave starts closing the staleness window at the write while preserving the module's honesty contract; the acyclic-import ratchet is honored through the deferred dynamic import readIndexEvidence already established (lifecycle.ts:569-576); the anchoring kernel stays pure text and gains match forms, not new identity semantics; link-derived attachment is threaded by callers into the existing persistence shape (`entities:` ids), so no new store.

## Design decisions

1. Freshness: reuse freshen claim/state/child argv verbatim (freshen.ts:166-214); add a force path bypassing the interval gate (MaybeFreshenOptions); the spawn happens inside noteLifecycle before finish via an injectable spawn seam (pattern: search.ts:444); `search_freshen_interval_s: 0` disables the post-write refresh as it disables freshen-on-read; the spawn is fire-and-forget and never fails the write.
2. Minimal spelling: a pure chooser `minimalSpellingFor(destinationRel, knownFiles)` hosted as a core/brain leaf beside link-graph/format-wikilink.ts. Predicate: the shortest of basename / suffix-less / full relPath whose exact-one resolution over the walked file population equals the destination, mirroring RESOLVED_LINK_TARGET_SQL's rungs (store/links.ts:62-70). Rung 2 lets a top-level basename win over a nested one; the chooser encodes that rule, and shared fixtures pin chooser and ladder agreement.
3. Third-party repair: the pre-rename counting probe (.files, lifecycle.ts:920-924) gives carrier counts; post-state is derivable (the rename moves exactly one carrier). When a bare spelling's carrier count goes 1 -> 2 (or more), links using it are retargeted to the minimal unambiguous spelling of the pre-rename target. Only provable changes are repaired; everything else stays.
4. Separator tolerance: new pure match-form generator in canonical.ts beside foldQuoteVariantsByClass, applied to BOTH the needle and the haystack at match time (folding only the needle matches nothing); forms Set-deduped; MIN_ANCHOR_FORM_LENGTH still gates; twins (merge-guard.ts:59-75, contamination.ts:53-57) updated in the same commit to stay in sync.
5. Link-derived attachment: callers (ingestSource, the page-sourced decompose path) read the source page's outbound wikilinks from bytes (extractWikilinks, order-preserving), map them to canonical entity ids server-side, and pass the ordered id list into the extraction call; the kernel unions link-derived ids after text matches. Primary entity = first body-order entity link (precedent: ingest summary ordering). Withheld entity pages are dropped before attachment (link-candidates precedent: drop before counting), and anchors stay subject to read-time visibility as today.
6. Relink: fifth LANE_TASK in the unattended maintenance lane (lane.ts:208-242), MAINTENANCE_LANE_REACH=local, additive-only anchor writes over page-sourced signals, dry-run report by default with an apply flag (doctor repair-lane precedent), never calls a model.

## File changes

- src/core/brain/notes/lifecycle.ts (freshness spawn seam, retargetsFor minimal spellings, repair arm, contract doc sentences)
- src/core/search/freshen.ts (force option, spawn-seam export)
- src/core/brain/link-graph/ (new minimal-spelling chooser leaf + fixtures)
- src/core/brain/page-dedup.ts (shared rewrite helpers if the repair arm needs them)
- src/cli/brain/verbs/note-lifecycle.ts, src/mcp/brain/lifecycle-file-tools.ts (report fields)
- src/core/brain/entities/canonical.ts (match-form generator), src/core/brain/atomic-facts.ts, src/core/brain/fact-extract.ts (kernels), src/core/brain/truth/merge-guard.ts, src/core/brain/truth/contamination.ts (twins)
- src/core/brain/ingest/ingest.ts, src/cli/brain/verbs/facts.ts, src/core/brain/intake/extract-intake.ts (caller threading)
- src/core/brain/maintenance/lane.ts + new relink task file
- tests/ mirroring each of the above; docs touched by osb-pr-prepare's docs lane.

## Risks and open questions

- The chooser duplicates resolution semantics in pure form; alignment is pinned by shared fixtures, and a drift test compares chooser output against a temp-vault index build.
- The post-write refresh narrows but does not close the staleness window (a read between write and refresh completion still answers stale); the report now names the pending claim.
- Separator folding widens anchor recall; precision coverage is explicit in the test plan (no test pins mid-word false positives today, "ada" already matches "canada" - folding must not make that worse).
- Lane 3's optional parameter on the extraction call lands after Lane 2's kernel commits (file overlap on fact-extract.ts).
