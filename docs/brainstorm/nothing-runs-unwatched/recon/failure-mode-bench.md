# Recon: the four-failure-mode conformance suite (t_72d6eb23)

Read-only reconnaissance against `feat/nothing-runs-unwatched` @ `6caf0b83`
(v1.47.0). Every anchor below was read; paths are repo-relative.

Headline: none of `know_to_ask_failure_rate`, `false_fire_rate`,
`source_isolation_violations` or `avg_injected_tokens` appears anywhere in the
tree (grep over `*.ts`, `*.md`, `*.json` returns nothing). Two of the four are
measurable today against seams that already exist. One is measurable only
against a surface that ships default-OFF. One is, as named, unmeasurable
without first deciding which of four meanings of "source" it refers to.

## 1. The bench substrate: two parallel harnesses, not one

They share no fixture format, no scorer, no report type and no emission path.
A new suite must pick a host or become a third.

### A. `runMemoryBench` — the staged phase harness

- Entry `src/core/bench/phases.ts:65`. Phases `ingest → index → retrieve →
  evaluate → report` (`src/core/bench/types.ts:14`), each checkpointed to
  `<runsDir>/<run-id>/checkpoint.json` (`src/core/bench/run-store.ts:84`).
  Resume validates the fixture hash before skipping work and refuses a changed
  fixture (`src/core/bench/run-store.ts:72-79`).
- A **fixture** is a repo-local JSON document: `notes[]` (vault-relative path +
  body), `continuity[]` (`session_turn` records only), `questions[]`. Parsed and
  validated fail-fast at `src/core/bench/fixture.ts:27`; note paths are checked
  against traversal and absolutes at `:112`; content-hashed at `:81`.
  `materializeBenchVault` (`:86`) writes the notes and appends the continuity
  records into a **disposable vault inside the run directory** — the operator's
  configured vault is never resolved.
- Six categories (`src/core/bench/types.ts:17-25`); four are retrieval
  (`:28-33`), plus `session_handoff` and `budget`. Retrieval drives `search()`,
  handoff drives `loadNormalizedContinuityRecords()`, budget drives
  `packContext()` — all three in `retrieveQuestion`
  (`src/core/bench/phases.ts:124-165`).
- **Scoring is deterministic containment**, in `evaluateQuestion`
  (`src/core/bench/phases.ts:175`): expected paths present in the ranked list
  and no `not_expected_above` path ranked higher (`:186-207`); turn count plus
  substring for handoff (`:210-229`); expected pack-item ids present for budget
  (`:232-241`). There is no hit@k, no MRR, no rank-sensitive number at all.
- Report `BenchReport` (`src/core/bench/types.ts:88`) keeps three families
  separate on purpose: `quality`, `latency_ms`, `context_cost`
  (`src/core/bench/phases.ts:274-292`).
- Emission: `report.json` in the run dir (`src/core/bench/phases.ts:117`) and
  stdout via `o2b brain bench memory` (`src/cli/brain/verbs/bench.ts:69-86`,
  exit 1 on any failing question). **No `appendMetric` call. No MCP tool.**
  Run dirs are gitignored (`.gitignore:29`).
- LoCoMo is an adapter, not a second harness: `loadLocomoFixture`
  (`src/core/bench/locomo.ts:189`) converts a LoCoMo dataset into a
  `BenchFixture` and hands it to the unchanged runner
  (`src/cli/brain/verbs/bench.ts:53`).

### B. `runRecallBenchmark` — the hit@k / MRR harness

- Entry `src/core/search/benchmark.ts:189`. Dataset is
  `{queries:[{id, query, expected[], k?, answer?}]}` (`:125`).
- Scores hit@k, MRR, answer-containment@k, source-utilization@k, citation
  depth, source warnings (`src/core/search/benchmark.ts:249-263`) against a
  **live vault** through `search()` — no disposable vault, no materializer.
- Four consumers: the CI gate test
  (`tests/core/search/recall-benchmark.test.ts`); `o2b brain benchmark run`
  (`src/cli/brain/verbs/benchmark.ts:24`), which appends a `recall_benchmark`
  metric (`:64-80`); MCP `brain_benchmark`
  (`src/mcp/brain/recall-tools.ts:79`, definition `:967`); and the rerank
  promotion gate `runRerankEvalGate` (`src/core/search/rerank-eval-gate.ts:66`),
  which runs the benchmark twice and compares.

### Baselines and CI gating

- **No baseline is committed as a file anywhere.** Both "baselines" are
  constants inside test files:
  `tests/core/search/recall-benchmark.test.ts:45-51`
  (`MIN_HIT_AT_5 = 0.9`, `MIN_MRR = 0.85`,
  `MIN_ANSWER_CONTAINMENT_AT_5 = 0.99`, with a re-measurement protocol in the
  header comment at `:1-20`), and `tests/cli/brain-bench.test.ts:44-45`
  (`quality.total === 6 && quality.passed === 6`).
- CI (`.github/workflows/ci.yml`) has **no bench step**. Its only relevant line
  is `bun test` (`.github/workflows/ci.yml:78`). Both harnesses therefore gate
  CI, but only as ordinary test files — there is no workflow invocation of
  `o2b brain bench memory`, no artifact upload, no threshold file, no trend.

### What this means for the shape of the work

`runMemoryBench` is the only harness with a disposable-vault materializer,
checkpointing, and a report that already separates metric families — all four
new metrics need a controlled vault, so it is the natural host. But its types
are closed unions keyed on `BenchCategory`. Adding a category touches
`src/core/bench/types.ts` (category list, question fields, result fields,
report fields), `src/core/bench/fixture.ts:138` (`parseQuestion`) and `:187`
(`validateQuestionShape`), and `src/core/bench/phases.ts` in three places
(`retrieveQuestion`, `evaluateQuestion`, `buildReport`) — plus a schema bump
past `o2b.bench.v1` (`src/core/bench/types.ts:12`) if any existing field
changes meaning.

## 2. Proactive injection: it exists, and its decision core is pure

The hook manifest is `hooks/hooks.json` (Claude Code auto-discovers it;
`.claude-plugin/plugin.json` declares no hooks). Registered injection surfaces:

| Surface | Event | Default | Decision core | Pure? |
| --- | --- | --- | --- | --- |
| `active-inject` | SessionStart, PostCompact | **ON** | `assembleActiveContext` `hooks/active-inject.ts:437` | yes |
| `recall-inject` | UserPromptSubmit | OFF (`src/core/config.ts:976`) | `decideRecallInject` `src/core/brain/recall-inject.ts:155` | yes, retriever injected |
| `nav-inject` | UserPromptSubmit | OFF (`src/core/config.ts:992`) | `decideNavInject` `src/core/brain/nav-inject.ts:33` | yes |
| `gap-agenda` | SessionStart | OFF (`src/core/config.ts:1034`) | `renderGapAgenda` `src/core/brain/gaps/gap-loop.ts:368` | yes |
| `pretool-orient` | PreToolUse | OFF (`src/core/config.ts:1019`) | `decideOrient` `src/core/brain/pretool-orient.ts:125` | yes (denies, does not inject) |

`active-inject` emits `hookSpecificOutput.additionalContext`
(`hooks/active-inject.ts:197-203`): standing rules first, read outside the
fail-open boundary (`:415`), then runtime notices + `Brain/active.md` +
`Brain/lessons.md` inside it (`:437`, `:463`, `:507`). Which preferences are
live is decided by `readActivePreferences(vault, agentScope)`
(`src/core/brain/active.ts:258`) → `renderActive` (`:138`). Only
`SessionStart` and `UserPromptSubmit` may carry `additionalContext`
(`hooks/lib/context-events.ts:23`).

**The decisive point for failure mode 1.** `active.md` is injected *wholesale*,
bounded only by a character budget (`budgetActiveBody`,
`src/core/brain/active-budget.ts:161`). There is no per-turn relevance
selection on the always-on path — it fires every session with everything.
Scoring `know_to_ask_failure_rate` or `false_fire_rate` against `active-inject`
is degenerate by construction.

The surface that *can* be silent is `recall-inject`:

```
decideRecallInject(prompt, retriever, options) -> "inject" | "abstain" | "error"
```

`src/core/brain/recall-inject.ts:155`, declared I/O-free and
retriever-agnostic in its own docblock (`:12-16`). Outcomes are exactly
`inject` (`:196`), `abstain{empty_prompt|no_matches|below_floor}`
(`:162`, `:187`, `:191`) and `error{timeout|retriever_failed}` (`:174`,
`:176`). Bounds: `RECALL_INJECT_CONFIDENCE_FLOOR = 0.35` (`:43`),
`RECALL_INJECT_MAX_NOTES = 4` (`:30`), `RECALL_INJECT_MAX_CHARS = 900`
(`:33`). **This is the seam that makes failure mode 1 measurable at all** —
the retriever is a parameter, so a fixture retriever runs the shipped decision
logic offline.

A second, earlier decision exists: `evaluateSurfacingGate(input)`
(`src/core/search/surfacing-gate.ts:70`) — a pure string function of
`(prompt, previousPrompt, explicit)` behind MCP `brain_recall_gate`
(`src/mcp/search-tools.ts:1130`). It suppresses only empty prompts
(`:74`), verbatim repeats (`:77-79`), slash commands (`:80`), and single
shell commands against a hardcoded name set (`:30-42`, `:82`) — and
**otherwise fails open** (`:85`). Scored alone, it produces `retrieve: true`
for essentially every natural-language prompt.

Also proactive: the anticipatory cache. `refreshAnticipatoryCache`
(`src/core/brain/anticipatory-cache.ts:298`) and `readAnticipatoryContext`
(`:371`) are synchronous and pure, composing `packContext` and
`searchSessionRecall` (plain lowercase substring matching,
`src/core/brain/session-recall.ts:194`); it is warmed unprompted off
`UserPromptSubmit`/`PostToolUse` lifecycle events
(`src/core/brain/session-lifecycle.ts:355-363`).

The most aggressive proactive consumer is not a Claude hook — it is Hermes:
`plugins/hermes/provider.py:481` calls `brain_recall_gate` (`:489`) and, when
it says retrieve, pulls `brain_context_pack` (`:491`) before every API call,
capped by `_PREFETCH_MAX_TOKENS = 1024` (`:105`).

The **only** live-model dependency on any injection path is the embedding call
at `src/core/search/semantic-phase.ts:162`, reached through
`defaultRecallRetriever` (`src/core/brain/recall-inject.ts:361`). Because the
retriever is a parameter, an offline bench never touches it.

## 3. Token accounting: nothing in this repo counts tokens exactly

There is no BPE tokenizer and no tokenizer dependency. There are **five**
estimators, and they disagree on the same input:

| Site | Formula | Unit |
| --- | --- | --- |
| `src/core/brain/text/tokenizer.ts:34-38` | `ceil(utf8_bytes / 4)` | UTF-8 bytes |
| `src/core/search/embeddings/signature.ts:84-91` | `ceil(str.length / 4)` | UTF-16 code units |
| `src/core/search/chunker.ts:57` | whitespace-run count | words |
| `src/core/bench/phases.ts:291` | `Math.ceil(avgChars / 4)`, inline | code points |
| `src/core/brain/token-impact.ts:206` | `baseline - packed` over caller-supplied ints | whatever the caller meant |

`estimateTokens` (`src/core/brain/text/tokenizer.ts:34`) is the closest thing
to canonical, and documents itself as a non-BPE heuristic at `:1-30`. Its
callers are the whole of Brain-side token accounting:
`src/core/brain/context-pack.ts:378`, `:509`, `:552`;
`src/core/brain/context-transforms.ts:65`;
`src/core/brain/token-footprint.ts:64`, `:130`;
`src/core/brain/generation-reports.ts:102`; `hooks/active-inject.ts:320`,
`:341`. The bench's own `context_cost.est_tokens`
(`src/core/bench/phases.ts:291`) does **not** import it — it re-implements a
different formula inline.

`brain_token_impact` (handler `src/mcp/brain/recall-tools.ts:417`, core
`src/core/brain/token-impact.ts:195`) performs **zero counting**: it is a
ledger over integers the harness posts. Its `method: "exact" | "fallback"`
field (`src/core/brain/token-impact.ts:61`, defaulted to `"fallback"` at
`src/mcp/brain/recall-tools.ts:435`) is an unverified caller claim; no adapter
in this repo posts `"exact"`. Default off
(`token_impact_ledger_enabled`, `src/core/config.ts:940`).

The **only token-denominated enforcement** is `packContext`'s `maxTokens`
(admission test `src/core/brain/context-pack.ts:510`, final sum `:627`).
Everything else that actually enforces is characters or code points:
`applyCharBudget` (`src/core/brain/recall-budget.ts:127`), `budgetActiveBody`
(`src/core/brain/active-budget.ts:161`),
`INJECT_BUDGET_CHARS_DEFAULT = 8000`
(`src/core/brain/policy/blocks/active.ts:58`),
`RECALL_INJECT_MAX_CHARS = 900`, `clipPayloadToBudget`
(`src/core/brain/continuity/store.ts:210`, budget measured as
`JSON.stringify(payload).length` at `:216`), `applySectionBudget`
(`src/core/brain/text/text-budget.ts:142`).

### What "per-harness" means here

| Harness | Injection code | Budget |
| --- | --- | --- |
| Claude Code | `hooks/hooks.json:27-33` → `hooks/active-inject.ts:493`, `:514` | chars (`resolveInjectionLimits` `hooks/active-inject.ts:391-401`) |
| Codex | `.codex-plugin/plugin.json:6` → `plugins/codex/hooks/active-inject.ts` (byte-identical copy) | same |
| OpenCode | `plugins/opencode/open-second-brain.ts:193`, injected at `:265` | none — pass-through |
| OpenClaw | `src/openclaw/index.ts:48-60` (`before_prompt_build`) | none; injects only an identity reminder |
| Hermes | `plugins/hermes/provider.py:476`, `:480` | tokens, hard-coded `1024` at `:105` |
| MCP | `src/mcp/brain/recall-tools.ts` (`brain_context_pack`) | caller-supplied, no server default |
| CLI | `src/cli/brain/verbs/context-pack.ts:31-39` | `--max-tokens` required, no default |

So a per-harness `avg_injected_tokens` is computable — but only by applying
`estimateTokens` to the string each adapter emits. No adapter reports a token
count, and four of seven do not enforce a token budget at all.

## 4. Source isolation: "source" is four unrelated concepts

Before the metric can be named, the noun has to be disambiguated:

1. **Ingested source** — a document imported into the vault; record is a
   Markdown summary page under `Brain/sources/` with `kind: brain-source`.
   Type `src/core/brain/ingest/sources-registry.ts:27`; frontmatter built at
   `src/core/brain/ingest/ingest.ts:154-167` (`source_path`, `source_hash`,
   `provenance`). Note `source_hash` is an identity hash of the path string
   (`ingest.ts:142-148`), not of content.
2. **Source trace** — every page derived from one source file.
   `searchBySourceFile` `src/core/brain/source-cleanup.ts:455`, match kinds at
   `:71`. Behind `brain_search_by_source` / `brain_delete_by_source`
   (`src/mcp/brain/ingest-tools.ts:133`, `:158`).
3. **Signal `source_type`** — the closed enum `live | inline | session`
   (`src/core/brain/signal.ts:271-273`), which is what `brain_sources` reports,
   grouped by `(agent, source_type)` (`src/core/brain/portability/sources.ts:71`).
4. **Cross-vault origin** — `local`, `profile/<name>`, `source/<alias>`
   (`src/core/brain/portability/origins.ts:42-73`).

### The isolation notion that actually exists is OWNER scope

One rule: `isOwnerVisible(owner, scope)`
(`src/core/graph/agent-scope.ts:104`) — no requested scope means no filtering
(`:16-19`); an ownerless page is shared; an unparseable `owner:` fails closed
as somebody else's (`:52`). Gated by config `integrity.owner_scope_delivery`
(`off | warn | fail`), **default `off`**
(`src/core/brain/policy/blocks/integrity.ts:67`). Consumers include
`src/core/search/result-filters.ts:317`,
`src/core/brain/preferences-collect.ts:280`,
`src/core/brain/owner-scoped-facts.ts:42`.

Agent identity is *recorded* but does not *partition*: `resolveAgentName`
(`src/core/config.ts:369`) stamps `agent` on signals/log lines
(`src/core/brain/log.ts:57`) and `source_agent` on entities
(`src/core/brain/entities/types.ts:57`, stamped
`src/core/brain/entities/registry.ts:504`), but nothing copies it into
`owner`, and ingested source pages carry no `owner` at all
(`src/core/brain/ingest/ingest.ts:154-167`).

### A ready-made violation counter — with a naming trap

`packContext` already counts cross-owner items:
`collectCandidates` returns `hiddenByOwnerScope`
(`src/core/brain/context-pack.ts:311`, accumulated `:329`, returned `:387`).
Under `warn`, `formatOwnerScopeWarning`
(`src/core/brain/preferences-collect.ts:307-318`) renders it as
`"N memory item(s) owned by another agent **were delivered**"` — i.e. under
`warn` the counter is a *delivered-leak* count, exactly a
`source_isolation_violations` numerator. Under `fail` the function returns
`null` at `:311` and nothing is reported. The variable name says "hidden"; the
message says "delivered"; they are the same number in different modes.

### Cross-vault

The union happens in exactly one place: `searchAcrossVaults`
(`src/core/search/cross-vault.ts:94`, merge `:150-215`). Origin labels are
attached to every result twice — as `origin` and as an `origin:<label>` entry
in `reasons[]` (`:44-50`), mirrored onto cards at `:53-59`. Non-active origins
are read-only (`selfHeal: false`, cache off, `:157-167`). There is no
vault-level ACL: any registered profile or source vault is fully readable.

### Existing leakage invariants

- `tests/core/brain/source-cleanup.test.ts:152-155` — the only genuine
  "content derived from source A must not appear in a result scoped to source
  B" assertion, with a deliberately-planted second source (`:79-88`). Delete
  side at `:213`, `:236`.
- `tests/mcp/agent-scope-matrix.test.ts:362-379` — for five gated surfaces:
  `expect(out).not.toContain("owned-by-a")` under gate `fail`, plus own-memory
  retention. Per-surface leakage assertions at `:460-473`
  (`brain_search_expand` rejects a foreign chunk), `:475-487`
  (`second_brain_query` paths **and** `total_pages`), `:510-530`
  (`brain_search_by_source` entries **and** total), `:596-615`.
- `:391-404` asserts the converse invariant: scoping must not narrow the shared
  `Brain/active.md` (byte equality at `:403`).

### Verification of t_b18551b1

**Partly refuted.** The exactly-once partition test is real —
`tests/mcp/agent-scope-matrix.test.ts:299-311`
(`expect(new Set(classified).size).toBe(classified.length)` then a
bidirectional `toEqual(actual)`), with a count pin at `:313-315`
(`expect(TOOLS.length).toBe(110)`). But it is **not** the only assertion: the
`SCOPED_SURFACES` bucket carries the behavioural leakage assertions listed
above, plus a schema check that every argument-scoped surface declares
`agent_scope` (`:317-329`).

Where the claim **holds**: `UNSCOPED_CONTENT` (`:88-114`) and `NON_CONTENT`
(`:117-206`) are prose-justified lists with no test that a `NON_CONTENT` tool
actually returns nothing owner-taggable; and within `SCOPED_SURFACES`
(`:66-81`), `brain_query` (`:73`) and `brain_search` (`:74`) get only the
schema-declares-`agent_scope` check, while `brain_retrieval_plan` gets only a
coarse `item_count` comparison (`:447-456`). Net: classification correctness is
asserted for roughly 12 of 14 scoped tools and for **zero** of the other 96.

One further gap: `tests/core/search/cross-vault.test.ts:64-74` asserts the
*set* of origin labels and that each result carries some `origin:` reason — it
never asserts that a result labelled `local` came from the active vault. The
origin-mislabelling failure is untested.

## 5. Write-back: the extractor seam is already the only mode

**Extraction is agent-side. The server never calls a model.**
`grep -riE 'api\.anthropic|api\.openai|/v1/chat/completions|/v1/messages|generativelanguage' src/`
returns zero hits; the only `fetch` calls under `src/core/brain/` are
`research/external-fetch.ts:231`, `explorer.ts:324` and
`capture/telegram-capture.ts:418,433` — none on the write path.

The contract is stated repeatedly in the code:
`src/core/brain/fact-extract.ts:5-7` ("without an LLM call"),
`src/core/brain/session-checkpoint.ts:31`,
`src/core/brain/distill/distill-source.ts:10-12` ("the calling agent supplies
the atomic claims… this core runs NO model"),
`src/core/brain/diarization.ts:16`, and
`src/mcp/brain/context-tools.ts:579` ("The calling agent generates; the Brain
never does"). Where prose *is* required, core returns a `needs-llm-step`
envelope for the caller to fulfil
(`src/core/brain/write-session/types.ts:23-35`,
`src/core/brain/write-session/engine.ts:98`).

**Consequence for the task framing:** "an injectable-extractor seam that runs
the shipped segmentation/insertion/dedup code with ZERO LLM calls in CI" is not
a seam to build — it is the default and only mode. What a fidelity bench must
supply is the *caller's* structured intake, which is exactly the shape
`brain_feedback` and `brain_session_checkpoint` already accept.

### Entry points and their input shape

| Entry | Anchor | Input |
| --- | --- | --- |
| `brain_feedback` | `src/mcp/brain/feedback-tools.ts:700` (schema), write `:157` | structured (`topic`/`signal`/`principle`/`scope`/`source[]`/`raw`) |
| `brain_session_checkpoint` | `src/mcp/brain/synthesis-tools.ts:150`, core input `src/core/brain/session-checkpoint.ts:59-88` | structured array of signals + decisions/learnings |
| `brain_write_batch` | `src/mcp/brain/write-batch-tools.ts:190`, mapper `:64-138` | structured note ops |
| `brain_pre_compact_extract` | `src/mcp/brain/pack-tools.ts:600` (handler), `:986` (schema) | **raw bounded text** |
| `o2b brain import-session` | `src/cli/brain/verbs/import-session.ts:40` | **raw transcript JSONL** |
| aider wrapper | `src/cli/aider.ts:107-112` | raw transcript tail → `extractPreCompactRecords` |

Raw prose enters at exactly two doors: `import-session` and
`brain_pre_compact_extract`.

### Server-side recognizers (all regex, all deterministic)

1. Structural facts — url / email / quantity only:
   `src/core/brain/fact-extract.ts:90-94`, applied at `:144`. Deliberately
   language-agnostic; the docblock at `:8-13` explains that English trigger
   phrases were removed as a defect.
2. Labeled lines — `src/core/brain/pre-compact-extract.ts:60-66`
   (`decision:`, `commitment:`, `outcome:`, `rule:`, `open question:`), applied
   `:142-158`. Input truncated at `DEFAULT_MAX_CHARS = 40_000` (`:68`, `:77`),
   recorded as `truncated_input` (`:120`).
3. Inline `@osb` markers — `src/core/brain/inline.ts:850`, consumed at
   `src/core/brain/sessions/import.ts:387`.

Validation of caller-supplied structure: `validateBrainFeedbackInput`
(`src/core/brain/sessions/validate-feedback.ts:57`, shared by live MCP and
session replay), then `src/core/brain/signal.ts:257-275`.

### Segmentation, insertion, dedup

- **Segmentation** operates on already-normalized turn records, never free
  text: `DEFAULT_GROUP_SIZE = 8` (`src/core/brain/session-recall.ts:148`),
  two-level grouping at `:366-412`, and the "summary" is concatenated truncated
  lines (`summarizeGroup` `:560-572`).
- **Insertion**: `writeSignal` (`src/core/brain/signal.ts:235`, atomic name
  allocation `:311-335`, frontmatter render `:360-426`) → `Brain/inbox/sig-*.md`,
  or `Brain/pending/` under write-approval
  (`src/core/brain/fact-extract.ts:341-349`). Continuity rows via
  `appendContinuityRecord` (`src/core/brain/continuity/store.ts:100`, append
  under lock `:284-301`).
- **Dedup, four independent layers**: content hash over
  (topic, sign, principle, scope) `src/core/brain/dedup-hash.ts:86` with a
  read-side index at `:55-84`; fact hash `src/core/brain/fact-extract.ts:185`
  (chain order documented at `:353`); idempotency ledger
  `src/core/brain/signal.ts:282-298` (same key + different payload throws);
  continuity `dedupe_key` `src/core/brain/pre-compact-extract.ts:91-102`.

### Provenance fields available to grade

Authoritative list is `renderSignalDocument`
(`src/core/brain/signal.ts:360-426`): `id` `:367`, `created_at` `:368`,
`agent` `:372`, `scope` `:378`, `source[]` wikilinks `:381`, `source_type`
`:387-393`, `schema_type` `:395`, `dedup_hash` `:398`, `session_ref` `:401`,
`origin_vault` `:404`, `valid_from` `:410`, `recorded_at` `:413`,
`authored_at` `:418`, `expiration_date` `:424`. Event-time policy:
`resolveEventInstant` (`src/core/brain/sessions/import.ts:124-135`) — outside
the `epoch < ts <= now` window it falls back to wall clock and emits **no**
bi-temporal keys, which is itself a gradeable fidelity outcome.
**No confidence score is written onto a signal.**

Continuity provenance: `schema`, content-hash `id`, `kind`, canonical-UTC
`createdAt`, `sourceRefs[]`, `payload`, `private`, `redacted`
(`src/core/brain/continuity/store.ts:256-282`), with
`session_id`/`turn_start`/`turn_end`/`content_hash`/`dedupe_key` on the
pre-compact payload (`src/core/brain/pre-compact-extract.ts:108-121`).

### Existing "fixed conversation in, assert the files out" tests

Four, all pass/fail rather than scored:
`tests/core/brain.sessions.import.test.ts:113-136` (asserts `session_ref` and
the `[[basename#turn]]` wikilink, and that the absolute path is absent);
`tests/e2e/brain-capture-and-fields.test.ts:37`;
`tests/core/brain/pre-compact-extract.test.ts:20-51` (exact ordered
`extract_type` list plus source refs); and
`tests/core/brain/fact-extract.anchoring.test.ts:75-92`. Host fixtures exist
for five runtimes at `tests/fixtures/sessions/{claude,codex,grok,hermes,opencode}-minimal.jsonl`.

## 6. Determinism and CI cost

- CI is one job. The only test step is `bun test`
  (`.github/workflows/ci.yml:78`); the local wrapper is
  `scripts/test` → `exec bun test`.
- A **deterministic offline embedder ships**: `LocalProvider`
  (`src/core/search/embeddings/local-provider.ts:67-78`) — FNV-1a feature
  hashing over token unigrams and character trigrams, unit-normalised,
  dependency-free, no key, no download. The recall-benchmark CI gate already
  runs on it: `tests/core/search/recall-benchmark.test.ts:60-64`
  (`semantic: { enabled: true, provider: "local", dimension: 256 }`), and pins
  determinism explicitly at `:155-160` (two runs must be `toEqual`).
- **Measured wall clock** on this machine:
  `bun test tests/core/search/recall-benchmark.test.ts` → 1.57 s for 10 tests
  including a full `indexVault` with embeddings;
  `bun test tests/core/bench/ tests/cli/brain-bench.test.ts` → 2.03 s for 20
  tests across 5 files. A fourth-metric suite of comparable size is low
  single-digit seconds — CI cost is not a constraint.
- **Determinism is environmental, not enforced.** `runMemoryBench` calls
  `resolveSearchConfig({ vault })` with no config path
  (`src/core/bench/phases.ts:82`, `:89`), and that function still reads
  `process.env` (`src/core/search/index.ts:401`). `search_semantic_enabled`
  defaults to `false` (`src/core/search/index.ts:455-459`) — but
  `OPEN_SECOND_BRAIN_SEARCH_SEMANTIC`, `OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER`
  and the API-key variables are **not** in the test-helper scrub list
  (`tests/helpers/run-cli.ts:36-46`, which scrubs nine unrelated names). The
  "deterministic and network-free" claim at `src/core/bench/phases.ts:12-13` is
  therefore a property of the default shell, not an invariant the harness
  holds. A developer with semantic search configured runs a different bench
  than CI does.

## Divergences

Where the task framing does not survive contact with the source.

1. **"The existing bench" is two benches.** `runMemoryBench` and
   `runRecallBenchmark` share nothing. The task's own hint list names both
   without distinguishing them. Any plan must say which one it extends; the
   answer is almost certainly `runMemoryBench` (§1), and the cost is a closed
   union widened in four files plus a report-schema decision.

2. **The extractor seam is not new — it is the only mode.** The server never
   calls a model on any write path (§5). "Injectable extractor seam with zero
   LLM calls" describes the shipped architecture. The real design question is
   the inverse of the one asked: not *how to inject a fake extractor*, but
   *what structured intake a fixture supplies* to stand in for a real agent's
   distillation, and whether grading that is measuring memory or measuring the
   fixture author.

3. **`know_to_ask` is only scoreable on a default-OFF surface.** The
   always-on injection path (`active-inject`) has no know-to-ask decision — it
   injects `active.md` wholesale every session. The only code that can choose
   silence on a real prompt is `decideRecallInject`
   (`src/core/brain/recall-inject.ts:155`), behind `recall_inject_enabled`,
   default off (`src/core/config.ts:976`). A metric that gates CI would be
   gating a feature most installs do not run.

4. **`false_fire_rate` against `brain_recall_gate` is degenerate.**
   `evaluateSurfacingGate` fails open by design
   (`src/core/search/surfacing-gate.ts:66-68`, `:85`): every prompt that is not
   empty, a verbatim repeat, a slash command or a bare shell command retrieves.
   Its false-fire rate is ~1 by construction. The anti-gaming pressure the task
   wants must be applied to the confidence floor and ranking inside
   `decideRecallInject`, not to the gate.

5. **`avg_injected_tokens` has no token count to average.** Five estimators
   disagree (§3); the bench already uses a sixth formula inline
   (`src/core/bench/phases.ts:291`); `brain_token_impact` counts nothing
   (`src/core/brain/token-impact.ts:206`). Four of seven harnesses enforce no
   token budget at all. The metric is buildable, but only as
   "`estimateTokens` applied to the emitted string" — and stating that
   explicitly is the difference between an honest number and one that implies
   a precision the repo does not have.

6. **`source_isolation_violations` names four different things** (§4), and the
   isolation notion that actually exists is *owner* scope, not source scope,
   and it is **default `off`**
   (`src/core/brain/policy/blocks/integrity.ts:67`). Gating at zero under the
   shipped default is vacuous: with no requested scope there is no filtering
   (`src/core/graph/agent-scope.ts:16-19`), so nothing can be violated. The
   metric only has content if the fixture forces
   `integrity.owner_scope_delivery: fail`.

7. **The counter that exists reports in the wrong mode.**
   `hiddenByOwnerScope` is surfaced only under `warn`, where it counts items
   that **were delivered** (`src/core/brain/preferences-collect.ts:313-316`);
   under `fail` it is deliberately unreported (`:311`). A zero-gated invariant
   must therefore assert on pack *contents* — as
   `tests/mcp/agent-scope-matrix.test.ts:368-372` already does — not read a
   counter.

8. **t_b18551b1's claim is partly wrong** and should be re-scoped before it is
   acted on (§4). The matrix does assert behavioural non-leakage for its gated
   surfaces; what it does not assert is anything about the 96 tools in
   `UNSCOPED_CONTENT` and `NON_CONTENT`.

9. **The only prose recognizer in the write path is English-only.**
   `src/core/brain/pre-compact-extract.ts:60-66` hardcodes `decision`,
   `commitment`, `outcome`, `rule`, `open question`. This contradicts the rule
   the sibling extractor states in its own docblock
   (`src/core/brain/fact-extract.ts:8-13`: a per-language phrase list is a
   defect). A write-back fidelity fixture written in any other language scores
   0 through that door for a reason that is not a memory failure.

10. **The bench emits no metric, so a new family has no dashboard path.**
    `runMemoryBench` writes only `report.json`; `docs/metrics.md:56-70` lists
    no `o2b.bench.*` surface. Anything meant to be trended must go through
    `appendMetric` (`src/core/brain/metrics.ts`).

11. **The metrics contract has already drifted.** `docs/metrics.md:62`
    documents `recall_benchmark` with six payload fields; the CLI writes eleven
    (`src/cli/brain/verbs/benchmark.ts:66-79`) and the MCP tool writes six
    (`src/mcp/brain/recall-tools.ts:107-118`) — two writers on one surface with
    different fields, neither matching the doc.

12. **Determinism is a property of the environment, not the harness** (§6).

## What a design must not assume

- That there is one bench to extend. There are two, and neither generalises to
  the other's fixture format.
- That a new extractor seam is needed. It is not; the seam that matters is the
  *retriever* parameter in `decideRecallInject`, which already exists.
- That the default-on injection path makes a relevance decision. It does not.
- That `brain_recall_gate` is the know-to-ask decision. It is a cheap
  suppressor that fails open.
- That any token number in this repo is exact, or that two token numbers from
  different modules are comparable.
- That "source" is one concept, or that source isolation is enforced by
  default. Owner scope is the only isolation primitive, and it ships `off`.
- That a violation counter can be read out of a `fail`-mode pack. It cannot.
- That the harness's network-freedom is enforced. It is inherited from an unset
  environment and not scrubbed by the CLI test helper.
- That a fixture written in one natural language exercises the same code paths
  as one written in another — `pre-compact-extract` recognises English labels
  only.
- That CI cost is a constraint. It is not: the comparable existing suites run
  in 1.6–2.0 s with the offline `LocalProvider`.
