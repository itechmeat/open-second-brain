You are brainstorming architectural variants for a 6-feature release wave. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain (local-first personal knowledge vault, TypeScript/Bun, MCP server + CLI; kernel in src/core, MCP tools in src/mcp, CLI verbs in src/cli, architecture censuses in tests/core/architecture). One release ships six validator-confirmed features on the spine "write-time honesty and egress consent":

1. F1 privacy-markers (t_e095afac): informal frontmatter privacy markers (access: private, confidentiality: secret) currently get zero protection - pageVisibility (src/core/graph/visibility.ts:44-48) reads only meta["visibility"]. Plan: marker predicate, remote-deny enforcement at the three read roots (result-filters.ts isPathReadableAtReach/applyReachFilter, vault.ts listVaultPages, indexer visibility stamp), preview-first tighten-only restamp verb, doctor finding. Tighten-only: only ADD the reserved token.
2. F2 chunk skip-and-hold (t_f029b413): chunks over the embedding model input window are silently truncated by the serving stack (indexer.ts:1184 embed call; presets carry windows). Plan: hold decision in runEmbeddingPhase (no embed, no vecUpsert), persistent hold record excluded from the pending anti-join (chunks.ts PENDING_ANTI_JOIN), bounded held-items report in IndexStats/status wire, doctor check, census warning update, release-on-config-change.
3. F3 person-name variants (t_46296794): entity lookup is exact normalized equality only (entity-alias.ts:58-59; registry.ts resolveActive). Plan: pure person-variants leaf module (initials, reversed order, operator-extensible nickname data - no hardcoded English word lists), fold into query-side expansion with declared-vs-derived tracking, exact-declared-first ranking tier (declared keeps existing boost, derived gets strictly smaller capped lane), registry lookup decision (extend resolveActive with ambiguity-throws or ranking-only), doctor entity-alias-candidate on collisions.
4. F4 undated-quantity lint (t_fb442a24): page-lint.ts has four detectors; add a fifth warning detector flagging counts/amounts written without any date (currency, percent, number+unit, thousands-separated) with escape hatches (valid_from, ISO date in body, [Source: ..., YYYY-MM-DD] marker); register in diagnostics for next_command; receipt lint key stays advisory and absent-when-clean.
5. F5 content-class egress (t_5f545a9b): exports/bundles apply credential-shape redaction only; no content-class policy. Plan: new server-derived creation-time frontmatter key (e.g. content_class, reserved value prompt-derived, spelling outside origin-channel census CHANNEL_SPELLINGS) stamped at deterministic prompt-derived write paths (session import, MCP note writes, research/dream pipelines that bypass createNote), excluded by default at the egress guard seam with per-verb operator override, named omissions, no-backfill era boundary, knowledge-pack block reason, census extension.
6. F6 provider-decline consent (t_fa467133): explicit provider decline (search_semantic_enabled=false / embedding_provider=disabled) and never-configured collapse into the same disabled tier; nothing persists an explicit decline decision and no doctor check names provider env vars. Plan: provider-consent resolver distinguishing unset vs declined (fail-closed on unreadable config), doctor consent probe naming env vars NAME-ONLY, honor decline at provider construction (single makeProvider decision point) before any network call, consent-stamp primitive with env kill switch (no destination declared yet), census pin bumps if durable files appear.

# Project context

Conventions: version bump + CHANGELOG inside the PR (not this phase); censuses fail closed (a new doctor code must join doctor-exits.ts + applier-capability.ts; new durable files join state surfaces with pinned counts; new registry rows need >=80-char reasons; import-cycles ratchet - shared modules must be leaves); TDD red-first; tests run with `env HOME=$(mktemp -d) bun test <files>`; Bun 1.4.0 pin; Windows-safe tests (no chmod-deny, normalize paths); no secret-shaped identifiers before quoted values; English, no exclamation marks; ox formatter at ./node_modules/.bin/oxfmt.
Verified premise reports for all six features exist with per-feature task slices (3-6 tasks each, ~30 tasks total, 45-65 files).

# Required output format

Produce exactly 3 distinct architectural variants for STRUCTURING this wave (lane decomposition, dependency ordering, shared-substrate strategy, census/registry sequencing, integration risks). For each variant:

### Variant N: <short name>
- **Approach**: 3-5 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 3-4 sentences explaining why this variant over the others, considering parallel implementation by 4-6 coders on disjoint file sets, the census coupling (doctor codes, state surfaces, egress registry), and integration risk.

Output nothing outside of these sections.
