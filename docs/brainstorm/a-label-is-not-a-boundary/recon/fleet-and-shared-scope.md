# Recon: fleet view (t_a160764a) and named shared observation scope (t_77efc212)

Read-only reconnaissance against `feat/a-label-is-not-a-boundary` at
`package.json` v1.48.0. Every claim below carries a `file:line` anchor that was
actually read.

---

## What exists

### 1. `src/core/brain/shared-namespace.ts` — the whole surface

104 lines, three exported functions, one config key.

**What turns it on.** `resolveSharedNamespace` reads the `shared_namespace` key
off the device config and returns the trimmed value or `null`
(`src/core/brain/shared-namespace.ts:31-35`). Absent or blank is off. The key is
device-level, alongside `vault:` itself
(`docs/brainstorm/agent-write-contract-suite/design.md:42`).

**What it mirrors, and when.** Exactly two record families, both mirrored AFTER
the primary write has already landed:

- feedback signals — `mirrorSignal` calls `writeSignal(sharedVault, …)`
  (`src/core/brain/shared-namespace.ts:42-55`); called from
  `src/mcp/brain/feedback-tools.ts:184-187` and
  `src/cli/brain/verbs/feedback.ts:98-101`.
- narrative notes — `mirrorNote` appends one `note` log event
  (`src/core/brain/shared-namespace.ts:64-84`); called from
  `src/core/brain/note.ts:75-83`.

Nothing else mirrors. `brain_apply_evidence` does not; preferences do not;
continuity records do not; graph pages do not. The MCP dedupe path deliberately
skips the mirror on a retry (`src/mcp/brain/feedback-tools.ts:166-180`).

**Attribution.** Carried twice as claimed: the pre-existing `agent` field plus
`origin_vault`, set to `basename(originVault)`
(`src/core/brain/shared-namespace.ts:50` and `:77`). On the signal path
`origin_vault` is persisted into the signal's frontmatter metadata
(`src/core/brain/signal.ts:403-404`), declared optional on the input type at
`src/core/brain/signal.ts:102`. On the note path it goes into the log event body
(`src/core/brain/shared-namespace.ts:74-78`).

**How failure is handled — "fail-soft", concretely.** Both mirror functions wrap
their write in `try { … } catch { return "failed"; }`
(`src/core/brain/shared-namespace.ts:49-54`, `:70-83`). The caught error object
is **discarded entirely** — no message, no cause, no stderr line, no continuity
record. The single bit `"failed"` is the whole diagnosis.

That bit is not swallowed at the boundary: it is surfaced. `MirrorOutcome`
(`src/core/brain/shared-namespace.ts:28`) reaches
`AppendBrainNoteResult.mirror` (`src/core/brain/note.ts:48`, emitted at `:89`),
the MCP feedback result (`src/mcp/brain/feedback-tools.ts:273`), and the CLI,
which both puts it in the JSON payload and prints `mirror: <outcome>`
(`src/cli/brain/verbs/feedback.ts:187`, `:199-200`). Unconfigured setups emit
nothing at all — the field is conditional on `mirror !== undefined`.

So the repository's "no silently swallowed error" rule is honoured at the
*envelope* level and violated at the *diagnosis* level: the caller is told that
something failed, and is given no way whatsoever to learn what. Contrast the
sibling append in the same call, which at least writes the message to stderr
(`src/mcp/brain/feedback-tools.ts:200-202`,
`src/cli/brain/verbs/feedback.ts:187-188` region).

**What a reader of the shared vault can see.** A mirrored signal is an ordinary
`sig-*.md` in the shared vault's inbox, indistinguishable from a locally written
one except for the extra `origin_vault` metadata key. A mirrored note is an
ordinary `note` log event. The module docblock states the intent explicitly:
"the shared vault's own dream pass treats mirrored records as ordinary
first-class signals" (`src/core/brain/shared-namespace.ts:15-16`). There is no
marker that says "this came from elsewhere" other than `origin_vault`, and see
§2 for who reads that.

**Self-mirror guard.** A `shared_namespace` pointing at the origin vault is
detected by realpath comparison and reported as `"failed"`
(`src/core/brain/shared-namespace.ts:92-103`), asserted at
`tests/core/brain/shared-namespace.test.ts:78-79`.

### 2. Readers of the shared vault — the decisive enumeration

**Readers of `origin_vault`: zero.** A repository-wide grep over `src/`, `docs/`
and `skills/` returns only the three write sites and their docblocks
(`src/core/brain/signal.ts:102`, `:403-404`;
`src/core/brain/shared-namespace.ts:10`, `:39`, `:50`, `:77`). No search filter,
no digest, no dream phase, no MCP tool, no CLI verb reads the field back. It is
write-only attribution.

**Readers of the shared vault as a vault: zero, by construction.** The one place
that enumerates which vaults participate in a read is
`listSearchOrigins` (`src/core/brain/portability/origins.ts:34-73`). It unions
three kinds — the active vault (`:39-46`), registered profiles (`:47-59`), and
read-only recall sources (`:60-71`) — and `shared_namespace` is **none of them**.
Its sole consumer is the cross-vault search fan-out
(`src/core/search/cross-vault.ts:106`).

The consequence, stated plainly: **the shared namespace is a write-only sink.**
Configuring it causes records to leave, and causes nothing to arrive. An
operator who wants to read a shared vault must separately register it under a
*different* registry (`recall-sources.json`,
`src/core/brain/portability/recall-sources.ts:37-39`) via
`addRecallSource` (`:101-135`), and nothing connects the two keys or warns that
one is set without the other.

This single fact governs both tasks and is the most important output of this
recon.

### 3. Agent discoverability — the three metrics, answered separately

**What identifies an agent.** `resolveAgentName` (`src/core/config.ts:373-380`):
`VAULT_AGENT_NAME` env var, then the `agent_name` / `agentName` config key, then
the literal fallback `"agent"`. An opaque string. There is no agent id, no
registration step, and the fallback means an unconfigured install writes under
the same name as every other unconfigured install.

**Is there a registry?** Yes — a *derived* one, and it already exists.
`listAgentSources(vault)` (`src/core/brain/agent-source/registry.ts:25-27`)
folds every contribution in a vault into a per-agent roster
(`summarizeAgentSources`, `:39-82`), where contributions are harvested from
signals, preferences/retired records, and Brain-log events
(`src/core/brain/agent-source/vault-provider.ts:25-49`). An agent exists
because it wrote something. `computeAgentSummary`
(`src/core/brain/digest-agent-summary.ts:37-122`) does the same over the log
alone, per window.

Both are exposed today: `brain_agent_query`
(`src/mcp/brain/query-tools.ts:598-637`) and `brain_agent_diff` (`:641+`) are
already read-only cross-agent surfaces. They are **within one vault**, over
agents that share it.

Now the three upstream metrics:

- **Memory count — COMPUTABLE, already computed.**
  `AgentSourceSummary.contribution_count`
  (`src/core/brain/agent-source/types.ts:27`) is exactly this, split by kind at
  `:28`. `computeAgentSummary` gives the finer per-event-type breakdown
  (`src/core/brain/digest-agent-summary.ts:20-26`).

- **Last activity — COMPUTABLE, not currently surfaced.** Every contribution
  carries a `timestamp` (`src/core/brain/agent-source/types.ts:8`) and the
  collection is sorted by it (`registry.ts:84-90`), so the max per agent is a
  fold away. `AgentSourceSummary` does not carry it today — that is a genuine
  small gap, not a missing data source.

- **Open tasks — NO SOURCE IN THIS PRODUCT.** This is the correct output and it
  is worth stating flatly. Greps for `open_tasks` / `openTasks` over `src/`
  return nothing. Every `kanban` hit in `src/` is a docblock reference to the
  *external* Hermes board that tracked the unit
  (`src/core/brain/freshness.ts:3`,
  `src/core/brain/hygiene/types.ts:3`, `src/core/brain/path-constants.ts:49`,
  and similar) — provenance comments, not a data structure. The two nearby
  candidates are not tasks: `src/core/brain/commitment.ts:1-16` is an epistemic
  *stance* ladder on a belief (`exploring → leaning → decided → locked`), and
  `src/core/brain/agenda.ts:1-11` is a pure function over calendar events the
  *runtime* passes in, with "no vault writes, no clock, no model". Nothing in
  this product persists a unit of work with an open/closed state.

  **Any fleet view here that reports an "open task count" would have to invent
  the number.** That is a stub with a plausible face, which this release
  forbids.

### 4. Agent scope and the `owner_scoping` equivalent

**The filter.** `src/core/graph/agent-scope.ts` defines the whole rule in three
functions: `ownerToken` / `pageOwner` resolve a page's `owner:` frontmatter
(`:69-85`), `normalizeAgentScope` normalizes a caller's request (`:91-95`), and
`isOwnerVisible` decides (`:104-108`). Semantics: no requested scope means no
filtering at all (`:105`); an ownerless page is shared and always reachable
(`:106`); an owned page reaches only its own owner (`:107`). A present-but-
unparseable `owner:` resolves to the unreachable sentinel `OWNER_UNRESOLVED`
(`:53`, produced at `:72` and `:74`), so an unreadable ownership claim fails
closed rather than publishing to everyone.

**What turns it on — this is the `owner_scoping` analogue.** The gate is the
`integrity.owner_scope_delivery` config key, read by `resolveOwnerScopeDelivery`
(`src/core/brain/preferences-collect.ts:171-185`). It ships `off`
(`:19`), under which it returns `{ enforcedScope: null }` unconditionally
(`:176-178`); only `GATE_MODE.fail` grants narrowing (`:182`). Its consumers are
the five delivery surfaces: `active.ts:266`, `digest.ts:724`,
`pre-compress-pack.ts:202`, plus context-pack and morning-brief
(`preferences-collect.ts:5-7`).

Crucially, the surrounding contract is stated at
`src/core/brain/preferences-collect.ts:111-113`: "A bare scope string is
deliberately NOT accepted: passing the gate's verdict is the only way to filter,
so no delivery surface can narrow a vault without the operator having asked for
it."

`brain_agent_query` takes `agent_scope` as a *plain argument* rather than
through the gate (`src/mcp/brain/query-tools.ts:632-637`,
`src/core/brain/agent-source/query.ts:22`), which is legal — it narrows on
request rather than by policy — but it means the two scoping paths in this repo
are not the same mechanism.

**What "REFUSED when owner_scoping is on" maps onto here.** It maps onto
`resolveOwnerScopeDelivery(vault, …).mode === GATE_MODE.fail`. But see
Corrections §B: the mapping is available and the *rationale* does not transfer.

### 5. The continuity read-model and its readers — exact numbers

- `src/core/brain/continuity/read-model.ts` applies three things and only three:
  schema-version dispatch (`:87-88`), the `private` drop (`:117`), and fail-soft
  normalization (`:66-72`). Its filter type carries `kind`, `sessionId`,
  `since`, `until`, `keepPrivate` (`:56-63`).
- `tests/core/brain/continuity/reader-census.test.ts` holds two exact
  inventories: `READ_MODEL_READERS` with **4** entries (`:65-74`) and
  `DIRECT_STORE_READERS` with **21** entries (`:82-116`). Counted mechanically:
  4 and 21. Total **25** readers.
- What it asserts today: both inventories match the tree exactly, via `toEqual`
  against a byte-classifier over `src/**/*.ts` (`:186-191`); the store door is
  the majority (`:197-199`); floors of `MIN_READ_MODEL_READERS = 4` and
  `MIN_DIRECT_STORE_READERS = 20` (`:133-134`, checked at `:200-201`); the
  classifier survives a NUL-carrying file (`:204-234`); the two excluded layer
  modules still exist (`:236-239`); and the census is demonstrably able to fail
  against injected rogue readers (`:241-265`).

### 6. The typed-refusal idiom — the enforced shape

`tests/core/architecture/verdict-vocabulary-census.test.ts` enforces a
**four-piece** shape, all four in one module
(`:38-47`):

1. `const NAME = Object.freeze({ … })` with every entry a string literal;
2. a union `(typeof NAME)[keyof typeof NAME]`;
3. a membership list from `Object.values(NAME)` or an array of `NAME.member`;
4. a guard taking a parameter typed `unknown` (not `string` — `:80-82`) that
   reads the list or the object.

`auditVocabulary` (`:374-405`) runs seven checks: values frozen; no duplicate
value in the object; no duplicate in the list; every declared value is a member;
the guard accepts every declared value; no member is "a member of nothing"; and
the guard rejects each of the seven near-miss `NON_MEMBERS` — `""`, `" "`,
`"unknown-vocabulary-member"`, `null`, `undefined`, `42`, `{}` (`:361-370`).

The population is **scanned, not remembered**: `scanVocabularies` walks `src/`
for the four-piece shape and `CENSUS` must account for every hit (`:27-36`).
There is **no exemption list, by policy** (`:59-61`). 57 vocabularies are
registered today (`:417-999`), including `GATE_MODE`
(`:422`), which is the gate mode used by `owner_scope_delivery`.

**Any new refusal must register here or the census fails it by name.**

### 7. Truncation and unknown-vs-zero — both have precedent

**Truncation declaration:**
- `AgentSourceQueryResult` carries `total_matched` next to `returned`
  (`src/core/brain/agent-source/query.ts:39-40`) — the exact idiom a capped
  fleet scan needs, on the exact surface a fleet view would extend.
- `context-receipts.ts:414` sets `truncated: matched.length > folded.length`,
  with the reason spelled out at `:192-196`: report the fact "rather than
  silently returning a prefix as if it were" the whole answer.
- `redactor.ts:583-593` — "`truncated` is a fact about" the scan, with a marker
  appended at `:618-619`.
- `pinned.ts:74` refuses with `budget_exceeded` "instead of being silently
  truncated to look like a" success.

**Unknown-vs-zero / unknown-vs-absent:**
- `NEGATIVE_RECALL_STATE` separates `not_found` (searched, nothing there) from
  `unknown` (no claim possible), with a companion
  `NEGATIVE_RECALL_UNKNOWN_REASON` naming *why*
  (`src/core/brain/negative-recall.ts:114-124`, `:149-161`). Both are in the
  vocabulary census (`verdict-vocabulary-census.test.ts:449`, `:455`).
- `doctor-readiness.ts:21-24` is the canonical statement: a probe that could not
  run "has found out nothing at all, which is what `unknown` " means, and
  `:174` — "an unmeasured surface is not a broken one".
- `CollectedPage.unreadable` (`src/core/brain/preferences-collect.ts:196-203`)
  keeps "could not read the file" apart from "the file declares no owner", so a
  caller can fail closed instead of leaking.
- `RecallSourceStatus.broken` (`src/core/brain/portability/recall-sources.ts:27-30`),
  documented at `:149-153` as "reported, never dropped — the operator decides".
- `AgentSourceQueryResult.unknown_agents`
  (`src/core/brain/agent-source/query.ts:38`) — a requested agent that does not
  exist is *named*, not returned with a count of zero. This is the single
  closest precedent to the upstream boundary in task (A).

---

## What does not exist

- No fleet / sibling / multi-agent *operator* surface. The validator hint is
  correct on this point.
- No reader of `origin_vault` anywhere (§2).
- No path by which a `shared_namespace` vault is read back (§2). It is
  write-only.
- No env-flag gate anywhere near this area. Gating in this repo is by config
  key — `shared_namespace` (`shared-namespace.ts:33`),
  `integrity.owner_scope_delivery` (`preferences-collect.ts:175`),
  `mcp_route_metrics_enabled` (`src/mcp/server.ts:130`). An env-flag-gated
  surface would be a new idiom here; only `VAULT_AGENT_NAME`
  (`src/core/config.ts:374`) uses the environment at all.
- No open/closed unit of work in the product (§3). No task store, no todo, no
  issue, no assignment.
- No `last_activity` field on `AgentSourceSummary`
  (`src/core/brain/agent-source/types.ts:24-30`) — computable, not present.
- No declared-scope field on the continuity read-model. `ContinuityReadModelFilter`
  (`src/core/brain/continuity/read-model.ts:56-63`) has no `scope` member; the
  v1.43.0 verdict's account of the removal is accurate against the code.
- No link between the `shared_namespace` key and the `recall-sources.json`
  registry, and no warning when one is configured without the other.

---

## Corrections to each premise

### (A) t_a160764a — fleet view

**A1. "open task count" has no referent in this product.** The single largest
correction. §3 establishes there is no persisted unit of work. Two of the three
upstream metrics port; the third cannot be computed from anything, and shipping
it would mean inventing a number. The task as written cannot be done honestly.

**A2. "sibling agents" is ambiguous in this codebase, and the two readings are
not the same feature.** Upstream (a database with namespaces) has one meaning.
Here there are two:
  - *agents sharing one vault*, distinguished by the `agent` field on their
    writes. This is already discoverable
    (`src/core/brain/agent-source/registry.ts:25-27`) and already has a
    read-only surface (`brain_agent_query`,
    `src/mcp/brain/query-tools.ts:598-637`). A fleet view over these is a fold
    away and reaches no other vault.
  - *other vaults*, i.e. profiles, recall sources, and the shared namespace.
    Reaching these means filesystem access to another vault root, which is
    where "unreachable" and "truncation" actually bite.

  The task body does not say which, and the two produce different units. The
  second is the one that makes the upstream boundaries meaningful.

**A3. "never crosses workspaces" has no analogue and should be dropped.** There
is no workspace concept in this codebase — the nearest boundary is the vault
root, enforced by `ensureInsideVault`
(`src/core/brain/payload-registry.ts:96-101`,
`src/core/brain/ingest/sources-registry.ts:69-79`). Cross-vault reads are not
forbidden here; they are a shipped feature with its own registry
(`recall-sources.ts:101-135`) and its own refusals — self-link (`:114-116`),
duplicate path (`:122-126`), direct circular link (`:127-132`). The upstream
boundary would be re-stating something the recall-source registry already
enforces better.

**A4. "REFUSED when owner_scoping is on" maps mechanically but not in
substance.** The mapping exists (§4: `owner_scope_delivery === fail`). The
*reason* does not: upstream refuses because "namespaces are people, not agents".
Here, `owner:` tokens are explicitly "an agent name" —
`src/core/graph/agent-scope.ts:23-24` says so directly. Owner scoping in this
repo is agent isolation, so a fleet view under it should **narrow**, not refuse
— and `queryAgentSources` already demonstrates exactly that correct behaviour,
folding the roster from what survived the filter precisely so the withheld
contributions are not counted or named
(`src/core/brain/agent-source/query.ts:50-56`,
`src/core/brain/agent-source/registry.ts:29-38`). Importing the upstream refusal
would be a regression against a leak this repo has already closed.

**A5. The premise is right that no operator surface exists, and wrong that
nothing exists.** The validator hint stops at `agent-scope.ts` and misses
`src/core/brain/agent-source/` entirely — six modules, a provider abstraction
(`types.ts:32-36`), a per-agent roster, two shipped MCP tools, and the
`unknown_agents` / `total_matched` idioms the upstream boundaries call for. Any
work here should extend that, not start beside it.

### (B) t_77efc212 — named shared observation scope

**B1. The v1.43.0 verdict is accurate and still binding.** Verified against the
code, not taken on trust: `ContinuityReadModelFilter` carries no scope member
(`read-model.ts:56-63`), and `private` is computed from the record rather than
declared by a caller (`read-model.ts:94`, `private: record["private"] === true`).
The verdict's demand stands.

**B2. The verdict's demand is now ANSWERABLE, and the answer is no.** It asked:
name the reader that would request a shared scope. §2 settles it — the shared
namespace has *zero* readers of any kind. A `shared` vocabulary member would be
declared by writers and consumed by nobody, and by the read-model's own drop
semantics a declared scope no reader names makes a record less visible, not more.
The 21 direct store readers (`reader-census.test.ts:82-116`) would not see it
either, since they bypass the read-model wholesale.

  **The premise of (B) does not hold, for the second time, for a reason that is
  now provable rather than argued.** The right move is not a third attempt at
  the field. It is to build the reader first — and the fleet view in (A) is a
  candidate reader, which is why these two tasks are correctly filed together.

**B3. The counts in the task body are stale by one.** The verdict says "four of
twenty-four readers". The census today lists 4 read-model readers and **21**
direct store readers — 25 total, not 24. See Defects §D1.

**B4. "a `shared` keyword added to an observation-scope taxonomy" would not be a
free-standing vocabulary here.** Any such member must satisfy the four-piece
shape and register in `verdict-vocabulary-census.test.ts` (§6), which has no
exemption list (`:59-61`). A one-member vocabulary also cannot satisfy the
duplicate/non-member checks meaningfully — the census's own reasoning about
`unknown` being "the member the trio was missing" (seed entry comment
at `:415-419`) shows the shape expects a real alternative, not a lone value.
This is the mechanical restatement of why the previous attempt's single member
was wrong.

---

## Smallest native unit per task

### (A) — the smallest unit that is true against this codebase

Not a fleet view. **Give `listSearchOrigins` an honest reachability verdict, and
give the shared namespace a place in it.**

Concretely, one unit:

1. A four-piece `ORIGIN_REACH` vocabulary (`reachable` / `unreachable` /
   `unknown` with an `ORIGIN_UNREACHABLE_REASON` companion), registered in
   `tests/core/architecture/verdict-vocabulary-census.test.ts` per §6, modelled
   on `NEGATIVE_RECALL_STATE` + `NEGATIVE_RECALL_UNKNOWN_REASON`
   (`src/core/brain/negative-recall.ts:114-124`, `:149-161`).
2. `listSearchOrigins` stops dropping broken sources silently
   (`src/core/brain/portability/origins.ts:63`) and instead returns every
   registered origin carrying its verdict, so `cross-vault.ts` can put an
   unreachable origin in the `warnings` array it already maintains
   (`src/core/search/cross-vault.ts:110`) rather than being handed a
   pre-filtered list it cannot describe.
3. `shared_namespace` becomes an enumerable origin, so the write-only sink
   becomes readable and the mirror stops being a one-way write into nothing.

This is native (it fixes a live defect, D2 below, in exactly the class this
release attacks), it is small, it invents no data, and it produces the reader
that (B) has now failed twice for lack of.

If a per-agent roster is genuinely wanted, the honest version is a **second,
smaller unit**: add `last_activity` (max contribution timestamp) to
`AgentSourceSummary` (`src/core/brain/agent-source/types.ts:24-30`) and surface
the existing `contribution_count` / `unknown_agents` / `total_matched` through a
roster mode. Two metrics, both real. **Do not ship an open-task count.**

### (B) — plain statement that the premise does not hold

The premise does not hold. A caller-declared `shared` scope requires a reader
that requests it; §2 proves there is not one, and §5 proves that even if there
were, 21 of 25 continuity readers would ignore it. The v1.43.0 verdict's
precondition is not merely unmet — it is now *measurably* unmet, and this recon
is the measurement. (B) should be blocked on (A)'s unit landing a reader, or
closed as premise-invalid. It should not be attempted a third time as written.

---

## Defects noticed

**D1. Reader-census prose has drifted from the census's own assertion, and the
floor hides it.** `DIRECT_STORE_READERS` holds 21 entries
(`tests/core/brain/continuity/reader-census.test.ts:82-116`), but three places
still say twenty: the census docblock (`:9-11`, "twenty call
`listContinuityRecords` straight off the store"), the read-model docblock
(`src/core/brain/continuity/read-model.ts:20`, "twenty call
`listContinuityRecords` directly"), and the shipped documentation
(`docs/observability.md:85`, "Twenty other modules call `listContinuityRecords`
on the store directly"). No test fails, because `MIN_DIRECT_STORE_READERS = 20`
(`reader-census.test.ts:134`) is a floor, not an equality. The census was built
to stop exactly this drift and does not cover its own prose.

**D2. `listSearchOrigins` silently drops unreachable origins — the exact defect
class this release attacks.** `src/core/brain/portability/origins.ts:63`:
`if (seen.has(vault) || source.broken) continue;`. A registered recall source
whose directory has gone away is removed from the fan-out *before*
`cross-vault.ts` ever sees it, so a cross-vault search over N origins where one
is unreachable returns as though that origin honestly contributed zero hits.
`cross-vault.ts` maintains a `warnings` array (`:110`) and cannot populate it,
because the information was destroyed upstream. The module docblock
(`origins.ts:12-14`) is candid that broken sources "never reach the search
fan-out" — it treats this as a design note rather than as the unknown-vs-zero
confusion it is. `recall-sources.ts:149-153` gets it right one layer down
("reported, never dropped"); `origins.ts` undoes that.

**D3. `mirrorSignal` / `mirrorNote` destroy the error object.**
`src/core/brain/shared-namespace.ts:52-54` and `:81-83` are bare
`catch { return "failed"; }`. A permissions problem, a missing shared vault, a
full disk and a schema violation are all one indistinguishable bit. The outcome
does reach the caller (`note.ts:89`, `feedback-tools.ts:273`,
`feedback.ts:199-200`), so this is not a swallowed *failure* — but it is a
swallowed *diagnosis*, and the mirror is precisely the path an operator cannot
observe by other means, since nothing reads the shared vault back (§2). The
sibling log append in the same functions at least writes the message to stderr
(`src/mcp/brain/feedback-tools.ts:200-202`). Minimum fix: carry a reason, using
the `*_UNKNOWN_REASON` idiom already in the census.

**D4. `MirrorOutcome` overloads `"failed"` across two unrelated conditions.** A
self-mirror is an *operator misconfiguration* detected before any I/O
(`src/core/brain/shared-namespace.ts:48`, `:69`, and the guard at `:92-94`), and
its own docblock calls it "always an operator misconfiguration" (`:88-89`) — yet
it returns the same token as a genuine write failure. The test asserts both as
`"failed"` (`tests/core/brain/shared-namespace.test.ts:73-74` vs `:78-79`),
which locks the conflation in. A vault where `shared_namespace` points at itself
reports identically to one where the shared disk is unmounted, and the fix for
each is completely different. `MirrorOutcome` is a three-member closed
vocabulary that does not follow the four-piece idiom (`:28` is a bare type alias
— no frozen object, no member list, no guard), so the census never audited it.

**D5. `MirrorOutcome` is not in the vocabulary census.** Following from D4:
`src/core/brain/shared-namespace.ts:28` is `export type MirrorOutcome = "ok" |
"failed" | "off";`. It is persisted-adjacent (it is emitted in MCP tool results
and CLI JSON at `feedback-tools.ts:273` and `feedback.ts:187`), which is the
condition the census exists for, but two-piece constructs are outside the scanned
population by design (`verdict-vocabulary-census.test.ts:73-76`). This is a
named blind spot being used, not a bug in the census — but it is the cheapest
way out of the population, and this vocabulary took it.

**D6. `resolveAgentName` falls back to the literal `"agent"`.**
`src/core/config.ts:379`. Every unconfigured install writes under one shared
identity, so a per-agent roster (§3) silently merges all of them into a single
row that looks like one very busy agent. Any fleet view must either distinguish
the default from a chosen name or refuse to report on it — reporting it as one
agent is a misleading non-empty, which is the same defect class as a misleading
empty.
