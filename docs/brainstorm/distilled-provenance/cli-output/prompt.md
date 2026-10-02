You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Two tracker cards ship together as one release ("honest provenance for distilled knowledge"). The card bodies are reproduced verbatim, except that the project abbreviation is spelled out.

## Card A: verify quotes on distilled brain pages verbatim against the source

**Source**: https://github.com/garrytan/gbrain/releases/tag/v0.47.8.0

### What
When Open Second Brain distills a source or session into a brain page, any text wrapped in quotation marks should be checked word-for-word against the underlying transcript, and passed through only if it matches. Non-matching passages are either dropped or rendered unquoted rather than presented as a verbatim quote. This closes the gap where a distillation model emits a paraphrase inside quote marks that reads as something the user actually said but did not.

### Why useful for Open Second Brain
Distilled pages are trusted as a faithful record; a paraphrase disguised as a direct quote silently corrupts that record and propagates into downstream recall, claims, and synthesis. Verbatim verification raises quote trustworthiness and gives agents a hard signal for which passages are quotable source-of-truth versus model-generated summary.

### Validator note (2026-09-12)
premise_confirmed. No quote-fidelity check exists; distillSource validates claims structurally only (non-empty text plus a well-formed block id, src/core/brain/distill/distill-source.ts:11-13, :60-61). Every claim carries a block-id wikilink `- <text> ([[<source>#^<block>]])` (:161), and the source is pinned by a content sha256 (:236). The kernel runs no model here, so the check must be deterministic and run at write time. Unowned sources commit into a quarantine lane, which is a precedent for a failed span. One policy decision: matching tolerance and the fallback for a failed span.

## Card B: capture_scope classification (full-local / bounded-local / url-only) plus a health warning when active knowledge rests on url-only sources

**Source**: https://github.com/eugeniughelbur/obsidian-second-brain/releases/tag/v0.16.0

### What
Upstream's raw-source schema gains a `capture_scope` field with three values: `full-local` (the content is in the note body), `bounded-local` (a marked excerpt) or `url-only` (just the locator). Ingest sets it from what was actually saved, not what was intended, and health gains a check that reports when active knowledge (concepts, synthesis) rests on sources whose evidence is no longer locally readable - only a URL that may rot - instead of telling the user everything is fine.

### Validator note (2026-09-29)
premise_partly_false. capture_scope itself is absent (0 hits), but "nothing records how much of the source was captured" is false: the source_paths/source_hashes contract records per source whether evidence existed locally at derivation (`missing` sentinel, src/core/brain/freshness.ts:31) and freshness reports orphaned pages. Scope to the three-way distinction and the url-only-backs-active-knowledge warning.

# Project context

Open Second Brain: TypeScript on Bun 1.4, an agent-owned second brain in an Obsidian-compatible Markdown vault, exposed over MCP and the `o2b` CLI. Version 1.66.0.

Recent commits:
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0) (#215)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0) (#214)
0afa0c5a chore(deps): bump the bun-minor-and-patch group with 5 updates (#201)
f6212cd2 fix: quiet one-line Stop reminder via Claude Code feedback channel (v1.58.2) (#202)
534befdb chore(deps): bump the github-actions group with 3 updates (#200)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1) (#199)
6f33c424 feat: payload registry and knowledge packs, boundary hardening, CJK chunking (v1.58.0) (#197)
a4d3ecf8 fix(codex): real plugin files and a truthful install check (v1.57.1) (#193)
d7e6094a feat: a second platform (v1.57.0) (#191)
54bb28d9 feat: what this install knows (v1.56.0) (#185)
5f415267 feat: who wrote what, and how to take it back (v1.55.0) (#184)
dc552590 feat: private is not a suggestion (v1.54.0) (#183)

Verified facts from reconnaissance on the live source (3ec2334a):
- `distillSource` (src/core/brain/distill/distill-source.ts:176-268): validate -> normalizeSourceIdentity -> classifySourceOrigin (source-trust.ts:351-381, returns {trust, contentHash?}, reads the file inside hashFile and throws the bytes away, 8 MiB ceiling, a URL or missing file gives untrusted with no bytes) -> render `## Claims` -> frontmatter -> idempotent byte-compare -> atomic write. Claims are caller-supplied `{text, block?}`; block is optional and most fixtures cite `^abc` against sources that contain no block ids.
- Nothing resolves a block id to its text anywhere in src/ (parse-wikilink.ts only extracts the `^id`). A block resolver is new code.
- entities/canonical.ts has `QUOTE_VARIANT_RE` (a fold over identity keys using Pi/Pf classes, pinned exhaustively by tests). It is not a span detector and misses U+0022, U+0027 (Po), U+201E and U+201A (Ps), CJK corner brackets (Ps/Pe), and `»…«` runs Pf to Pi. `\p{Quotation_Mark}` covers all of these without a language list. U+2019 is also the apostrophe inside words.
- The retrieval trust gate (quarantine lane) is OFF by default (`search_trust_gate_enabled`), so quarantining a page does not stop a default search from returning it.
- page-lint.ts refuses to normalise authored body bytes on write (receipts and byte-stability tests pin them); comparison-only normalisation is consistent with that.
- MCP `brain_distill_source` description is 280 of 300 characters; property descriptions cap at 160; MCP errors become `invalid_params` unless a code-carrying class is registered in src/mcp/tool-error-codes.ts.
- Pages that cite sources: ingest summaries (`kind: brain-source`), distillations (`brain-distillation`), research reports (`brain-report`, cite `[[https://...]]` URLs, no trust field), entities (quarantined when intake is untrusted; `restore` moves them to active and deletes the untrusted marker on purpose).
- The only real bounded excerpt producer, `extractPage` in research/extract.ts (network fetch, 4000/500 char caps), is not wired up.
- Hygiene detectors (`HYGIENE_DETECTOR_IDS`, findings with severity info|warning|action) reach `brain_status` through an existing count. Doctor codes need an exit-census row.
- Writers add nothing to frontmatter for the default lane, so clean pages stay byte-identical (pinned by tests).
- `brain_write_session` can also write caller-authored bytes into Brain/distillations without passing distillSource.

Conventions:
- Closed vocabularies ship as a four-piece (frozen object, member list, type, guard) and register in a census test.
- Advisory findings in a write receipt: absent key means clean; a failure of the check is a named `unavailable`, never an absent key.
- Errors surface by name; no silent fallbacks; no stubs.

Constraints:
- No hardcoded natural-language phrases in any language; other languages handled abstractly (Unicode properties, not word lists).
- No model call in the kernel; checks are deterministic.
- No network egress added to write paths in this release.
- Do not widen `QUOTE_VARIANT_RE`.
- Existing clean pages must stay byte-identical; no new external dependencies.
- The two cards should share one vocabulary where they overlap ("no local bytes").

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
