You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One Open Second Brain release wave, four related kanban cards (session-mining economy). The card bodies below are verbatim; each is followed by the validator/review comments that carry the settled scope decisions.

## Card t_05a0eaa4 (priority 4)
TITLE: [upstream:yantrikdb] Recall-time claim-chain eligibility gate (grounding status + shadow/enforce modes + extraction refusals)

BODY:
**Source**: https://github.com/yantrikos/yantrikdb/releases/tag/v0.22.0
**Repo**: yantrikos/yantrikdb (31★)
**Released**: v0.22.0 (2026-09-07T21:03:05Z)

## What
An enforcement layer on the recall lane: a versioned per-claim `grounding` status (0 never-validated / 1 cooperative / 2 extractor-bound-with-evidence-span), a durable `claim_chain_gate_mode` (off | shadow | enforce, shadow on every install) where under enforce every edge of a returned path must be eligible (grounded, valid as of query time, positive, asserted), plus an `extraction_refusals` table (ungrounded claims are reported, not silently stored). Value objects are admitted as claim objects where the relation admits values.

## Why useful for Open Second Brain
This is the quality/enforcement layer that sits on top of a multi-hop relational recall arm — it stops ungrounded or stale edges from participating in surfaced paths, and the shadow-first mode lets you measure what enforcement would refuse before turning it on. Open Second Brain has the recall traversal and context-item grounding as separate pieces but nothing that gates graph-claim edges at query time.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**:
  - Relational recall arm exists but has NO per-edge eligibility gate: `src/core/search/pipeline/relational-arm.ts:35`, `src/core/search/relational-fanout.ts:70` (bounded depth-2 fan-out into RRF fusion).
  - Grounding exists only for CONTEXT ITEMS, not graph claims: `src/core/brain/provenance/epistemic.ts` (five statuses observed/derived/hypothesis/plan/unknown from frontmatter). No `grounding` column on claims/edges, no shadow/enforce recall mode, no `extraction_refusals` equivalent found.
  - Integrity discipline that a gate would extend: `src/core/search/store/state.ts:212` (schema-mismatch refusal), `src/cli/search/verbs/check.ts:69`.

## Notes
Related to but not the same as existing triage tasks: builds a recall-time gate on top of the multi-hop chain recall (t_c37af4e9) using claim grounding provenance (t_3e87656b) and admission/junk discipline (t_11d51443), and consumes the temporal validity windows (t_edba0c15) for the "valid as of query time" edge check. None of those four describes the shadow/enforce eligibility gate itself, so this is net-new capability worth its own card; the orchestrator may want to link it as a dependent of that cluster.

COMMENTS:
- [osb-triage-validator]: osb-triage-validator @ 2026-09-12:
- sanity: Correct two anchors - src/core/search/store/state.ts:212 and src/cli/search/verbs/check.ts:69 are a docblock line and an import line respectively, so neither shows the refusal the card cites. Add the gate the card misses: src/core/brain/trust/retrieval-gate.ts:1-20 and :97 (trustGateAdjuster), mounted at src/core/search/pipeline/post-rank.ts:128-131, configured by recall.retrievalTrustGateEnabled (src/core/search/types.ts:1318-1332). relational-arm.ts:34-36, relational-fanout.ts:70 and provenance/epistemic.ts verified.
- cluster: recall-lanes; depends on t_c37af4e9 (multi-hop chains, p2), t_3e87656b (claim grounding, p2) and t_edba0c15 (validity windows, p3) as the card says
- priority: set to 2: The enforcement PATTERN already exists at recall time and can be reused, so this is an extension rather than net-new capability - but it is genuinely last in a four-card chain, and building it before the grounding status and validity windows it consumes would leave a gate with nothing to read. Anchors verified against live source this run.
- premise: premise_partly_false - "Nothing gates edges at query time" is right about EDGES and wrong about the mechanism being absent. A recall-time eligibility gate already ships for pages: the retrieval trust gate contributes an exclude-with-reason verdict so quarantined material ranks zero and reaches no pack, classifying deterministically from controlled-vocabulary frontmatter only - never prose - over three signals each owned by an existing module (src/core/brain/trust/retrieval-gate.ts:1-20, :97), mounted as a rank adjuster on both the semantic and pure-lexical paths (src/core/search/pipeline/post-rank.ts:128-131). It is config-gated, excluded items are counted WITH REASONS into a retrieval_decision_trace receipt, every pack carries a trust-assessment receipt, and with the flag off ranking and outcome shape stay byte-identical (src/core/search/types.ts:1318-1331). That off/on-with-receipts shape is most of what the card calls shadow/enforce - what is missing is the middle mode that measures refusals WITHOUT excluding, plus per-edge (rather than per-page) eligibility. Rescope to: a third mode on the existing gate, an edge-level adjuster inside the relational arm, and the extraction-refusals record - and sequence it behind its three dependencies.
- [osb-triage-review]: osb-triage-review @ 2026-10-15: priority 2 -> 4. All three prerequisites are now done (t_3e87656b claim grounding, t_c37af4e9 multi-hop chains, t_edba0c15 validity windows), so the card is unblocked; the rescoped work is concrete: a measure-only shadow mode on the shipped retrieval trust gate (src/core/brain/trust/retrieval-gate.ts:97 trustGateAdjuster), an edge-level adjuster in the relational arm (src/core/search/pipeline/relational-arm.ts) and an extraction-refusals record. Recall quality is the active product focus (v1.82.0-v1.84.0), and this closes the last open card of that chain.

---

## Card t_93617709 (priority 4)
TITLE: [upstream:gbrain] Durable zero-yield ledger to stop re-mining sessions that never produce signals

BODY:
**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.48.5.0
**Repo**: garrytan/gbrain (18439★)
**Released**: v0.48.5.0 (2026-09-08T03:35:57Z)

## What
Add a durable tombstone ledger that records which sessions were mined for signals and yielded zero accepted signals, so those sessions are excluded from future extraction planning until the session is edited/re-imported. Mirrors upstream's migration v146 zero-atom tombstone table, but scoped to OSB's session signal mining (`planExtractSignals`) rather than transcript atom extraction.

## Why useful for OSB
OSB currently rebuilds the same mining plan and re-sends the same user turns to the caller's LLM every time a session is re-scanned, even when a prior mining run produced nothing — pure repeated model spend for zero yield. A zero-yield ledger shrinks the recurring extraction work pool and keeps it shrunk, so re-scans skip sessions already proven barren until their content changes.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: `src/core/brain/extract-signals.ts:340` (`planExtractSignals` — read-only plan, no cross-run yield memory), `extract-signals.ts:347-380` (existing refusals cover empty/non-user sessions but NOT legitimate zero-signal outcomes), `commitExtractedSignals` (accepted-signal writer — natural point to also record a zero-yield tombstone when an accepted-signal count of 0 comes back). Ledger consumer would gate at `planExtractSignals`. Related but non-overlapping: `src/core/brain/dream.ts:274` (`applySalienceGate` — same "don't re-spend on nothing" discipline, but scoped to preferences, not session-mining pools); `src/core/brain/sessions/import.ts` (import-session — edit/re-import is the natural invalidation trigger); `src/mcp/brain/extract-tools.ts` (`brain_extract_signals` plan/commit lanes). Not found: any durable zero-yield/tombstone table for session mining — codegraph MCP unavailable this session; confirmed by direct read + 119 triage titles checked, none cover it (nearest t_0358af42, t_05bf583f both concern distillation counts/salience, not a re-mining ledger).

## Notes
- Invalidation semantics matter: a tombstone must be cleared (or made eligible again) when the session's user turns change — mirror upstream's "editing the file makes it eligible again" via the import/recall path so newly-added content is not permanently ignored.
- OSB runs no model itself (the LLM step is delegated to the caller), so the benefit lands as fewer proposed mining turns handed back to the caller — i.e., the ledger must suppress the plan, since OSB cannot observe token cost directly.
- Distinguish "zero accepted after mining" (tombstone) from the existing hard refusals at extract-signals.ts:347-380 (which already short-circuit before any LLM work) — the new state covers sessions that legitimately reach mining but yield nothing.

COMMENTS:
- [osb-triage-validator]: osb-triage-validator @ 2026-09-12:
- sanity: Correct the refusal range to src/core/brain/extract-signals.ts:345-376 (the card says :347-380); planExtractSignals at :340 and applySalienceGate at src/core/brain/dream.ts:274 verified. Add the commit-side shape the ledger would key on: CommitExtractedSignalsResult at :229-241 (written / staged / deduped / durabilityRejected / rejected).
- cluster: overlaps t_0358af42 (undistilled-session count, p2) - both want a per-session mining ledger; sequence together, no new link
- priority: set to 2: The gap is real and the seam is exact - suppress the plan, record on commit - but the invalidation rule is a genuine design decision and a tombstone that never clears would permanently blind the miner to a session the operator later adds to. Solid feature on an existing subsystem. Anchors verified against live source this run.
- premise: premise_confirmed - planExtractSignals is a pure read with no cross-run memory: it re-walks the session's turns and rebuilds the mining envelope every call (src/core/brain/extract-signals.ts:340-385), and its three refusals cover a non-capture boundary decision, zero imported turns, and zero user-authored turns (:345-376) - none of which is "mined and yielded nothing". Three notes for scope. The tombstone needs a richer trigger than "zero written": the commit result distinguishes written, staged under write approval, deduped, and durability-rejected (:229-241), and only the last two mean "this session had nothing worth keeping" - a session whose items all DEDUPED yielded nothing new but its content is already known, which is a different state from barren, and staging is not a yield failure at all. Second, the card is right that the benefit is fewer turns handed back, since the kernel never calls the model itself - so the ledger must gate the PLAN, not the commit. Third, the invalidation key should be the content hash the session-discovery ledger already uses rather than mtime (src/core/brain/sessions/discover.ts:14-24 explains why: rsync, Syncthing and git checkout all move the clock without changing a byte).
- [osb-triage-review]: osb-triage-review @ 2026-10-15: priority 2 -> 4. Real, still-absent spend saver on main (no zero-yield record anywhere in src/core/brain/extract-signals.ts), and the 2026-09-12 validator already answered the design questions: gate the plan not the commit, tombstone only on durability-rejected outcomes (CommitExtractedSignalsResult now at :244), invalidate on the content hash used by sessions/discover.ts. Anchors drifted (planExtractSignals moved from :340 to :443); pairs with t_0358af42.
Status: stale_anchors

---

## Card t_15ebcfc1 (priority 3)
TITLE: [upstream:supermemory] Local memory console with live counts and interactive memory graph

BODY:
**Source**: https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.7
**Repo**: supermemoryai/supermemory (25432★)
**Released**: server-v0.0.7 (2026-08-15T06:47:56Z)

## What
The self-hosted server's local console welcome page gains a Memory tab: live counts of documents and memories, recent items, container tags, and an interactive memory graph — a zero-setup local UI over the memory store for a self-hosted instance.

## Why useful for OSB
OSB's operator surface today is textual: `buildTodayDashboard` renders obligations, open loops, and activity as a markdown envelope, and brain state is otherwise only visible through CLI verbs. An interactive local view over the link graph — nodes for notes, live counts, recent captures — would give operators a fast visual sense of brain growth and structure without opening Obsidian or running queries, and would complement the existing read-only dashboard rather than replace it.

## Status in OSB
- **Verdict**: unverified
- **Codegraph hints**: src/core/brain/today-dashboard.ts:20 `buildTodayDashboard(vault, opts)` — read-only envelope over four sections (obligations, open loops, activity timeline, totals), frozen and text-rendered; no interactive/graphical surface exists. Link-graph data is available via src/core/brain/link-graph/ (format-wikilink.ts et al.) and search store links (src/core/search/store/links.ts). not found — no interactive UI or graph visualization surface anywhere in src/. Related but distinct: t_a160764a (fleet view over sibling agents) covers cross-agent counts, not the local memory graph.

## Notes
Verdict is `unverified`: the Claude analysis CLI was unavailable at capture time (OAuth session expired); body drafted from codegraph hints. Scope caution from OSB's own history: OSB deliberately treats visualization node limits as an external-partner concern (graphify viz), and thin passthroughs to absent binaries are forbidden — an OSB-side console should render from OSB's own link-graph store, not shell out.

**Also observed**:
- plur-ai/plur (154★) — v0.18.0 — sharpens the "live counts" half of this task with concrete surfaces: a written-per-day chart, a most-recalled list, per-engram recall counts with row-expand to the full engram; read-only by construction (browsing never fires lazy writes such as decay); loopback-only 127.0.0.1 bind by default with a warning on --host widening. OSB's shipped explorer (src/core/brain/explorer.ts buildLiveServer) already realizes the interactive-graph half over the rule graph; the recall-telemetry data (src/core/brain/recall-telemetry.ts, report-snapshot.ts Brain/metrics/ contract) exists but is not joined to any viewer — fold these views into the explorer (or a sibling surface) reusing its loopback + read-only invariants.

**Also observed**:
- Ar9av/obsidian-wiki (977★) — v2026.09.1 — read-only operations console at /ui (PR #210): service/runtime ops state for the human operator on the loopback web server; complements the memory-content views — an ops route on OSB's existing buildLiveServer (src/core/brain/explorer.ts:355) rendering the brain_status snapshot would cover it with no new infrastructure.

**Also observed**:
- yantrikos/yantrikdb (31★) — v0.23.0 — Memory Atlas exporter (serves export dir on 127.0.0.1; child-process isolation so no second SQLite handle opens the store; encrypted stores refused; mkstemp+os.replace artifact writes) plus read-only yantrikdb-tui terminal explorer (SQLite online-backup snapshot into a private temp dir, engine built on the copy, embedder identity verified by digest before search is enabled)

COMMENTS:
- [claude-dev-agent]: claude-dev-agent @ 2026-08-16: triage re-prioritisation pass (operator-directed, full-column review of all 62 triage tasks against v1.49.0 source)
- priority: kept at 0, meaning re-stated.
- PROCESSED and PARKED - the value 0 is unchanged but its meaning is not: it was 0 because the analysis CLI was down at capture, and it is now 0 because it has been read and judged. Same verdict as the other four UI items: a live console with an interactive memory graph needs a rendering surface that does not exist here, and the body's own caution already notes this project treats visualization as an external-partner concern. The non-UI half is already served: `buildTodayDashboard` renders counts and recent activity as text.
- rubric applied board-wide this pass: 4 = verified in-repo defect, acceptance criteria runnable today | 3 = internal, target identified, no open design question | 2 = internal, needs a design decision first | 1 = real but gated on an external product or decision, or a marginal increment | 0 = PARKED: processed and judged, verdict is the deliverable (NOT 'unprocessed').
- [claude-dev-agent]: claude-dev-agent @ 2026-08-16: CORRECTION to the re-prioritisation pass posted earlier today. The numbers move; the ranking argument on this card is unchanged and still applies.
- priority: 0 -> 1.
- What I got wrong: 0. On this board 0 means the priority has not been set yet, and 5 is an operator-only blocker pin above the working range - so the working range is 1..4 and every rank I assigned sat one step too low. Worse, my earlier comment redefined 0 as 'parked', which would have made 20 deliberately-judged cards read as untriaged and invited the next validator to re-triage them.
- The former top two tiers merge at 4 because the working range has four slots, not five: t_9b209fbe (the one verified in-repo defect with runnable acceptance criteria) now shares 4 with the five target-identified cards and stays first among them.
- corrected scale, in force board-wide: 4 = actionable now (internal, target identified, no open design question) | 3 = internal, needs a design decision first | 2 = real but gated on an external product or decision, or a marginal increment | 1 = PARKED (processed and judged; the verdict is the deliverable) | 0 = priority not yet set - no triage card should hold this after this pass | 5 = blocker, operator-set only, never self-assigned.
- [product-tech-lead]: Also surfaced upstream in plur-ai/plur v0.18.0 (https://github.com/plur-ai/plur/releases/tag/v0.18.0). The interactive-graph half of this task is already realized by src/core/brain/explorer.ts (buildLiveServer, rule-graph view); the plur release sharpens the live-counts half: written-per-day chart, most-recalled list, per-engram recall counts, strict read-only browse. The telemetry data exists (recall-telemetry.ts, report-snapshot.ts) but no viewer surfaces it — folding these views into the explorer would close this task's gap.
- [osb-triage-validator]: osb-triage-validator @ 2026-08-23T08:38Z:
- sanity: clean
- priority: set to 3: overriding the 2026-08-16 parked verdict (was 1) - its premise is now stale. The claim 'no rendering surface exists' was falsified by plur v0.18.0 evidence on 2026-08-21: src/core/brain/explorer.ts buildLiveServer (:354, loopback-only, read-only, re-reads vault per GET) is exactly the local console surface, verified live this run; it already serves a rule-graph view, and recall-telemetry.ts + report-snapshot.ts hold the counts data with no viewer. Work = fold live-counts views into the explorer. Internal, one bounded extension, no architectural unknowns.
- [product-tech-lead]: Also surfaced upstream in Ar9av/obsidian-wiki v2026.09.1 (https://github.com/Ar9av/obsidian-wiki/pull/210). They added a read-only operations console at /ui served by the wiki server — service/runtime state for the human operator, not just memory content. Takeaway: the console family should cover BOTH facets (memory counts/graph AND running-service ops snapshot); OSB already has the data via brain_status/second_brain_status MCP tools (src/mcp/registry-guard.ts:377) and the loopback server to host it (src/core/brain/explorer.ts:355 buildLiveServer) — an ops route there needs no new infrastructure.
- [product-tech-lead]: Also surfaced upstream in yantrikos/yantrikdb v0.23.0 (https://github.com/yantrikos/yantrikdb/releases/tag/v0.23.0): packaged Memory Atlas exporter (serves one store's export on 127.0.0.1, child-process isolation, encrypted stores refused, mkstemp+os.replace artifacts) plus a read-only terminal explorer (yantrikdb-tui) that snapshots the store via SQLite online-backup and never opens the source with the engine. Reinforces the same capability: an operator-facing read-only explorer over the brain store.

---

## Card t_0358af42 (priority 3)
TITLE: [upstream:iwe] Session-start count of undistilled sessions with cross-session-deduped, batched distill proposals

BODY:
**Source**: https://github.com/iwe-org/iwe/releases/tag/iwe-v0.21.0
**Repo**: iwe-org/iwe (1086★)
**Released**: iwe-v0.21.0 (2026-08-29T21:50:13Z)

## What
At session start, report how many past sessions remain undistilled and, at most once per configured interval, offer to read them. The distill flow asks about every candidate before writing (Keep all / Skip all / Let me pick), uses one candidate at a time for a few or a batched numbered multi-select for many, and reads the backlog with one reader per session so a fact several sessions raised is asked about only once.

## Why useful for OSB
OSB distills individual sources and mines single-session signals, but has no backlog-level "N sessions undistilled" nudge and no cross-session dedup, so a recurring fact gets re-proposed per session and the user is asked the same thing repeatedly.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/brain/distill/distill-source.ts (distills a single SOURCE into atomic claims, not session-backlog-aware); src/core/brain/extract-signals.ts (mines one session's turns into Brain/inbox/, no cross-session dedup); hooks/hooks.json (SessionStart injects budgeted active.md, no undistilled-session count)

## Notes
Two separable pieces: the session-start count/reminder gate (throttled to once per interval) and the cross-session-deduped batched proposal UI. The dedup step ("one reader per session, ask once") is the higher-value, harder part and depends on a per-session ledger of which sessions have been distilled.


**Also observed**:
- plastic-labs/honcho (4753★) — PR #1115 — deriver backlog exported as metrics from an API endpoint: machine-readable backlog visibility complementing the session-start nudge surface.

COMMENTS:
- [product-tech-lead]: Also surfaced upstream in plastic-labs/honcho PR #1115 (https://github.com/plastic-labs/honcho/pull/1115). feat(api): export deriver backlog as metrics from an API endpoint — same OSB-side intent (visibility into the un-distilled/un-derived backlog) via a machine-readable metrics surface rather than a session-start nudge; if OSB grows an operational metrics endpoint, the undistilled count belongs there too.
- [osb-triage-validator]: osb-triage-validator @ 2026-09-12:
- sanity: The card has no path:line anchors and the hooks path is given as a bare file. Record: src/core/brain/sessions/discover.ts:1-25 (the outstanding-sessions sweep the card treats as absent), cross-session dedup at src/core/brain/dedup-hash.ts:55-70, SessionStart block at hooks/hooks.json:27. Strike "no cross-session dedup, so a recurring fact gets re-proposed per session".
- cluster: overlaps t_93617709 (durable zero-yield ledger) - both want a per-session mining ledger; sequence them together, no new link
- priority: set to 2: With the two refutations applied, the residue is a distillation-keyed view over an existing sweep plus a throttled SessionStart surface - bounded work on existing subsystems, but the proposal UI (ask-once batching) is still undesigned and the kernel cannot run the distill step itself. Anchors verified against live source this run.
- premise: premise_partly_false - Two claims are refuted. (1) Cross-session dedup already exists: buildDedupIndex scans the whole inbox and processed dirs by dedup_hash, vault-wide and not per session (src/core/brain/dedup-hash.ts:55-70), and commitExtractedSignals runs each item through it before the durability gate, naming what it rejected rather than dropping it silently (src/core/brain/extract-signals.ts:433-455). So a recurring fact is already suppressed at write time across sessions; what is missing is suppressing the ASK, i.e. dedup before the proposal is put to the operator. (2) The backlog census is not absent either: src/core/brain/sessions/discover.ts:1-25 already sweeps every session log on the machine and reports which are still outstanding, backed by a content-hash ledger explicitly built so a second run is cheap. It is keyed on IMPORT, not on distillation, and nothing surfaces it at session start (hooks/hooks.json:27 wires SessionStart to the active.md injection only). Rescope to: a distilled/undistilled key on that existing ledger, a throttled count on the SessionStart hook, and the ask-once batching layer above the dedup that already runs.
- [osb-triage-review]: osb-triage-review @ 2026-10-15: priority 2 -> 3. Internal and unchanged on main (no undistilled key or SessionStart count); the validator rescoped it to a distilled key on the sessions/discover.ts ledger, a throttled SessionStart count and ask-once batching above the existing dedup. Build it together with t_93617709, which shares the per-session mining record; the batching UI is the one open design point.

---

# Project context

Open Second Brain: a local-first memory/knowledge layer for AI agent runtimes, TypeScript on Bun, MCP server + CLI. Recent commits:
948a0403 feat: storage lifecycle for long-lived vaults (v1.85.0) (#257)
ef974e0d fix: comma-separated and legacy scopes no longer abort the dream pass, plus three test-isolation fixes (v1.84.1) (#254)
14a99584 feat: recall lane concurrency, overlapped_ms accounting, a caller-selectable packing policy and standing-instruction facets (v1.84.0) (#252)
e239d323 feat: shipped-seam wiring - a per-session recall pool cap, usage-ordered skill offers, seeded bench sampling and OpenCode V2 configs (v1.83.0) (#251)
44a8ccaf feat: recall quality - an iterative recall loop, coverage-first session recall and a measured surfacing key (v1.82.0) (#250)
259e4b70 fix(snapshot): decode readdir buffer entries as UTF-8 so exclusions match (v1.81.1) (#243)
28ea378b chore(deps): bump the github-actions group with 2 updates (#245)
745c4a95 chore(deps): bump the bun-minor-and-patch group with 4 updates (#246)
323fb9e4 feat: answer trust - verified quotes, claim provenance and durable source evidence (v1.81.0) (#249)
a00fa3f5 feat: recall quality - mined sessions, honest admission and a store that filters in SQL (v1.80.0) (#248)
3f029241 feat: write-side trust - identity, permission and review for every agent write (v1.79.0) (#247)
66f9d847 feat: credential custody under a passphrase and a verifiable trust surface (v1.78.0) (#244)
3afb94a5 feat: a truth layer you can correct and time-travel (v1.77.0) (#242)
e907c692 ci: balance windows test shards by measured duration (#241)
f3d7185e fix: keep generated cluster digests out of community detection (#240)
646a49df feat: freshen the search index on read, rewriting only changed chunks (v1.76.0) (#239)
78f924b9 feat: deliver context to subagent turns, hygiene digest at turn end and tiered context shrink (v1.75.0) (#238)
542d214b fix(opencode): support both plugin APIs (v1.74.1) (#190)
0cbb60b8 feat: near-duplicate defense across the fact lifecycle (v1.74.0) (#237)
23090696 chore(deps-dev): bump the bun-minor-and-patch group with 2 updates (#231)
Related files (from validator recon): src/core/brain/sessions/discover.ts, src/core/brain/extract-signals.ts, src/core/brain/dedup-hash.ts, src/core/brain/trust/retrieval-gate.ts, src/core/search/pipeline/post-rank.ts, src/core/search/pipeline/relational-arm.ts, src/core/search/types.ts, src/core/brain/explorer.ts, src/core/brain/recall-telemetry.ts, src/core/brain/report-snapshot.ts, hooks/hooks.json.

Conventions:
- Kernel stays LLM-free; extraction contracts name their LLM steps explicitly (needs-llm-step events).
- No silent fallbacks; errors surface by name. No stubs. No hardcoded natural-language phrases in any language.
- Strict TDD; one conventional commit per atomic unit; formatter and linter green before every commit.
- Test runs use a throwaway HOME (env HOME=$(mktemp -d) bun test <paths>).
- Config surfaces live in src/core/search/types.ts and friends; every new knob needs a default and a doctor story where relevant.

Constraints:
- The wave ships ONE PR, feature -> minor bump, about 40-60 files.
- The claim-chain eligibility gate must ship measure-only (shadow) by default.
- The zero-yield tombstone must key on session content hash so changed sessions re-mine.
- Reuse the shipped retrieval trust gate (trustGateAdjuster) rather than building a parallel mechanism.

# Required output format

Produce exactly 3 distinct architectural variants for the WHOLE four-card wave (one coherent design, not per-card). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
