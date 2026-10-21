You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Two kanban cards ship together in one release wave, "Dated commitments, capture to surface":

Card t_da8673aa (validator-rescoped 2026-09-12): automatic open-loop / commitment detection with due dates and evidence quotes. Rescoped scope: a due-date and evidence-quote vocabulary on a one-off commitment page family; an agent-supplied extraction intake mirroring the existing brain_agenda and brain_intake_entities tool contracts (the kernel never calls a model); projection into facts and entity edges. Gmail/Calendar/Contacts ingestion is out of scope (vault-notes model). Today, open loops are manual `@osb loop` markers with no due date and no store, and the only due-dated pages are cadence-driven recurring obligations, so a one-off promise in prose is invisible.

Card t_43b0a379 (validator-rescoped): opt-in counterparty brief injecting dated known-person facts at session start and on reply or meeting intent. Rescoped scope: a push-side Before-you-start hook block with at most three dated, shareable items for a confidently matched person or company (off by default, at most once per session, degrades to a pull-style context pack call on harnesses without hooks), plus a pull-side `entity_facts` section of context packs (recent facts per packed entity, no dependency on the dated-item supply). Privacy posture: only shareable items may be briefed; private pages excluded. The dated-item supply depends on card t_da8673aa landing first.

# Project context

Open Second Brain: a memory layer for AI agents living in an Obsidian vault; TypeScript on Bun; Markdown pages under `Brain/` are the source of truth; MCP tools, lifecycle hooks and an `o2b` CLI are the surfaces. Deterministic kernel: the kernel never calls a model.

Recent commits:
f203591e feat: measured autonomy - a rule-promoting dream pass, model-aware context budgets and honest benchmarks (#269)
9e579820 feat: note-change truth maintenance for links, index freshness and entity anchoring (#268)
f7c1c88c feat: entity merge repair, write destinations, cross-agent catch-up and OKF v0.2 (v1.88.0) (#267)
f6d9f95f feat: guarded host writes, walkable list results, a converse decision route and a snoozable trigger queue (v1.87.0) (#266)

Related files (all anchors verified against the live tree this session):
- src/core/brain/open-loops.ts - `@osb loop` markers: OpenLoop is { id, text, path, line } only; open set re-derived per call, no store; strictly deterministic and frozen.
- src/core/brain/obligations.ts - recurring obligations, the due-dated page-family precedent: pages at Brain/obligations/<slug>.md, pure UTC cadence math, add/done/list/show/remove, list due-sorted with overdue flag and days-until-due, remove archives the page.
- src/core/brain/preference.ts:213-218 and src/core/brain/commitment.ts - NAMING COLLISION: `commitment` is an existing user-editable frontmatter tier (exploring | leaning | decided | locked) on preferences, theses and decisions, with its own validator and tolerant reader. A new page family about promised work needs a distinct family name and frontmatter keys that never reuse the bare `commitment:` key.
- src/mcp/brain/calendar-tools.ts - brain_obligation (one tool, operation enum add/done/list/show/remove) and brain_agenda (stateless analysis over caller-supplied events; pure, no vault writes).
- src/core/brain/intake/extract-intake.ts and src/mcp/brain/ner-tools.ts - the agent-executed extraction-intake precedent: the agent owns the model and posts a typed payload; the kernel validates the whole payload and refuses BEFORE writing anything; commits idempotently through duplicate-refusing upserts; stamps provenance; trust is derived from cited sources, never an argument.
- src/core/graph/relation-vocab.ts - DEFAULT_RELATION_TYPES (related, extends, depends_on, refines, contradicts, superseded_by); data-driven: adding a relation type is a one-line change, and a frontmatter field whose name is a known relation becomes a typed edge automatically (src/core/graph/frontmatter-relations.ts, ingested by the search indexer and the link-graph).
- src/core/brain/atomic-facts.ts:157 - anchorEntityForms: the deterministic, quality-gated anchoring kernel matching entity name and alias forms against prose (minimum form length, clean leading edge, separator-tolerant variants); canonical scope filtering via entityStatusInScope.
- src/core/graph/visibility.ts - the one reserved visibility token `private` dominates any co-tag; strictestVisibilityOf computes the intersection for items derived from several source pages.
- src/core/brain/context-pack.ts - the tier-then-recency context pack; conditional-option precedent: `densityRanking?: boolean` option (config key density_ranking_context_pack, default off, resolved at the tool seam), a conditional report member, and a conditional output projection, so default packs stay byte-identical; a synthesized attention block shows how a non-page item joins the pack; four callers share packContext (MCP tool, anticipatory cache, retrieval plan, bench).
- hooks/hooks.json, hooks/gap-agenda.ts, hooks/recall-inject.ts - SessionStart runs five hooks, UserPromptSubmit runs four; a new hook is one hooks/<name>.ts plus a hooks.json row; opt-in flags are machine-local config booleans with env overrides (resolveConfigFlag), checked FIRST so flag-off is a byte-identical no-op; the injection ledger gives once-per-session suppression; only SessionStart and UserPromptSubmit may emit additionalContext; hooks run under a hard process ceiling.
- src/core/config.ts:852 - resolveDensityRankingContextPack, the config-key-at-tool-seam precedent.

Conventions:
- The kernel never calls a model; the calling agent supplies extractions, the kernel validates typed payloads.
- No hardcoded natural-language word lists anywhere: operator-declared vocabularies or structural markers only; all strings are English and other-language cases are handled abstractly.
- Errors surface explicitly by name; no silent fallbacks, no stubs; repeated values hoisted into named constants; withheld or unreadable pages answer as absent (identical-to-absent), never counted.
- New MCP tools are deliberate surface changes: frozen tool-name parity test, a visibility-surface-registry row plus a two-directional census, reach predicates on every read, and vault-path-safe responses. A new hook must register in hooks.json plus three test-enforced mirrors (codex mirror, grok parity, shape test).
- Each new page family follows the obligations pattern: path constants, path helpers, a core module with a typed error, write-time validators, a soft reader for hand-edited frontmatter, deterministic render/parse, injected clock.

Constraints:
- One PR, roughly 50-70 changed files including tests and docs; max features = the two cards.
- The extraction contract is caller-executed: nothing may re-derive commitments by walking notes with a model, and nothing may require a model at write time.
- Alias and intent matching must stay deterministic and re-derived server-side.
- Intent (reply/meeting) detection must not be a hardcoded natural-language word list: an operator-declared vocabulary in config or an explicit structural marker are the discipline-compatible options.
- The push side must not start before the dated-item supply exists (t_da8673aa unblocks t_43b0a379).
- The pull side is dependency-free and should be implementable as an option on brain_context_pack rather than a new tool (avoiding a four-census tool registration).

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
