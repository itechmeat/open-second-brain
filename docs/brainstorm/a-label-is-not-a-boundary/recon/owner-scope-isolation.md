# Recon: owner-scope isolation and the `NON_CONTENT` bucket

Task under verification: kanban `t_b18551b1`, "Decide whether a document path
counts as content for owner-scope isolation." Branch
`feat/a-label-is-not-a-boundary`, repo at `package.json` version `1.48.0`.

Every claim below carries a `file:line` anchor that was opened and read.
Behavioural claims marked EMPIRICAL were reproduced against throwaway vaults
under `/tmp/.../scratchpad` with two owners (`agent-a`, `agent-b`) and
`integrity.owner_scope_delivery: fail`.

---

## What exists

### 1. The ownership rule, end to end

The rule is a single pure module, `src/core/graph/agent-scope.ts`:

- `pageOwner(meta)` (`agent-scope.ts:83`) reads one frontmatter field,
  `meta["owner"]`, through `ownerToken` (`agent-scope.ts:69`).
- `normalizeAgentScope(value)` (`agent-scope.ts:91`) NFC-trims-lowercases a
  requested scope; blank becomes `null` meaning "no filtering".
- `isOwnerVisible(owner, scope)` (`agent-scope.ts:104`) is the whole
  decision: `scope === null` → visible; `owner === null` → visible; else
  `owner === scope`.
- `OWNER_UNRESOLVED` (`agent-scope.ts:53`) is the fail-closed token for an
  ownership claim the parser cannot reduce to one string.

There is no owner column anywhere in the search database. `documents` is
declared at `src/core/search/schema.ts:103-113` with `id, path, title,
content_hash, mtime, size, created_at, updated_at, indexed_at` and nothing
else; `links` at `schema.ts:165-174` likewise. Ownership is therefore a
**filesystem-frontmatter** read at result time, never a SQL predicate.

The one place the rule meets the filesystem is
`isPathOwnerVisible(vault, path, scope, frontmatterCache)` at
`src/core/search/result-filters.ts:309-318`. It fails closed on an unreadable
file (`result-filters.ts:316`), which the comment at `result-filters.ts:302-307`
contrasts deliberately with visibility scoping's fail-open default.
`applyAgentScope` (`result-filters.ts:320-327`) is the ranked-search wrapper.

The parallel Brain-side walk is
`collectPreferencePages` at `src/core/brain/preferences-collect.ts:264-289`,
whose gate at `preferences-collect.ts:274-285` applies the same
`!unreadable && isOwnerVisible(pageOwner(meta), gate.scope)` test and counts
`hiddenByOwnerScope`.

Production consumers of `isOwnerVisible` are exactly four:
`src/core/brain/agent-source/query.ts:60`,
`src/core/brain/owner-scoped-facts.ts:42`,
`src/core/brain/preferences-collect.ts:280`,
`src/core/search/result-filters.ts:317`, plus the inline listing filter at
`src/mcp/tools.ts:263`.

### 2. The config key and its two regimes

`integrity.owner_scope_delivery` (`off | warn | fail`, default `off`) is
declared at `src/core/brain/policy/blocks/integrity.ts:28,67,113` and read by
`resolveOwnerScopeDelivery` at `src/core/brain/preferences-collect.ts:171-185`.
Only `fail` populates `enforcedScope`; `warn` populates `requestedScope` only.

The gate covers the **preference/delivery** surfaces
(`active.ts:266`, `context-pack.ts:427`, `pre-compress-pack.ts:202`,
`digest.ts:724`, `morning-brief.ts:81`, `anticipatory-cache.ts:197`,
`mcp/brain/context-tools.ts:397`). The **search-backed** surfaces are ungated
and honour only an explicit per-call `agent_scope` argument — the reasoning is
written into the matrix test at
`tests/mcp/agent-scope-matrix.test.ts:54-63`.

How a tool learns the scope: `coerceAgentScope(ctx, args,
fallbackToServerIdentity)` at `src/mcp/coerce.ts:115-123`. Gated surfaces pass
`true` and fall back to `ServerContext.agentName`; ungated ones pass `false`.
`ServerContext.agentName` is a **getter** resolved per access at
`src/mcp/server.ts:167-169`.

Exactly 13 of 110 tools declare `agent_scope` in their input schema
(EMPIRICAL, enumerated from `buildToolTable("full")`): `second_brain_query`,
`brain_context_pack`, `brain_pre_compress_pack`, `brain_anticipatory_context`,
`brain_query`, `brain_agent_query`, `brain_brief`, `brain_deep_synthesis`,
`brain_retrieval_plan`, `brain_search_by_source`, `brain_search`,
`brain_search_expand`, `brain_file_context`. `brain_context` is the 14th
scoped surface and takes no arguments at all.

### 3. The codebase's own stated doctrine on existence leaks

`src/core/brain/preferences-collect.ts:298-303` states it plainly: under
`fail` the surface says nothing at all, because
"a count would tell one agent that another agent's private memories exist -
the existence leak the search side avoids by making a hidden chunk
indistinguishable from an absent one."

The matrix test enforces the same doctrine for `brain_agent_query`'s roster at
`tests/mcp/agent-scope-matrix.test.ts:556-594`, and `second_brain_query`'s
`total_pages` at `agent-scope-matrix.test.ts:485-486` ("a count that still
included the hidden pages would leak their number").

**This settles question (1) on the codebase's own terms.** A bare count is
already ruled a leak here. A document path, or a Brain artifact id, is
strictly more information than a count. "A path is metadata" is not a position
this repository actually holds anywhere else; it is only a position the
`NON_CONTENT` label implies by omission.

### 4. The matrix test's exact structure

`tests/mcp/agent-scope-matrix.test.ts`, three buckets:

- `SCOPED_SURFACES` (`:66-81`), 14 entries, each `{name, source, gated}`.
- `UNSCOPED_CONTENT` (`:88-114`), 8 entries, each `{name, reason}`.
- `NON_CONTENT` (`:117-206`), 88 bare strings, header comment
  "Everything else: metadata, analytics, maintenance, writers, catalog."

Assertions, and only these:

```
test("the matrix classifies every tool exactly once", () => {
  const classified = [
    ...SCOPED_SURFACES.map((s) => s.name),
    ...UNSCOPED_CONTENT.map((s) => s.name),
    ...NON_CONTENT,
  ];
  expect(new Set(classified).size).toBe(classified.length);
  const actual = TOOLS.map((t) => t.name).toSorted();
  expect(classified.toSorted()).toEqual(actual);
});                                          // :299-311
```

```
test("the tool count is unchanged: an argument was added, never a tool", () => {
  expect(TOOLS.length).toBe(110);
});                                          // :313-315
```

```
test("every argument-scoped surface declares agent_scope in its input schema", () => {
  for (const surface of SCOPED_SURFACES) { ... }
});                                          // :317-329
```

`grep -n` over the file confirms the bucket identifiers appear at exactly
these lines: `SCOPED_SURFACES` at `:66, :301, :318`; `UNSCOPED_CONTENT` at
`:88, :302`; `NON_CONTENT` at `:117, :303`.

So:

- `SCOPED_SURFACES` carries a schema assertion (`:317-329`) plus fifteen
  behavioural tests (`:362-379` gated loop, `:447-615` ungated cases).
- `UNSCOPED_CONTENT` carries **only** the partition, plus a prose `reason`
  string that nothing reads.
- `NON_CONTENT` carries **only** the partition. Nothing checks the claim.

**What the test would catch:** a tool added to `buildToolTable` and not
classified; a tool removed and not de-classified; a name listed twice; a
change in tool count; an argument-scoped surface that stops declaring
`agent_scope`.

**What it would not catch:** any `NON_CONTENT` or `UNSCOPED_CONTENT` tool
returning owner-private data. The classification is an assertion about the
world made by a human in a string literal, and nothing in the file executes
it. The premise's characterisation of the enforcement gap is exactly right.

### 5. `listDangling` — signature, callers, reachability

`src/core/search/store/links.ts:170-192`:

```ts
export function listDangling(db: Database, limit: number): ReadonlyArray<DanglingLinkTarget>
```

`DanglingLinkTarget` (`links.ts:148-153`) is `{ target: string; sources:
ReadonlyArray<string> }` where `sources` are **vault-relative document
paths**. The query at `links.ts:173-176` is
`SELECT DISTINCT l.target_path AS target, d.path AS source FROM links l JOIN
documents d ON d.id = l.source_document_id WHERE l.target_path IS NOT NULL AND
<ladder> IS NULL ORDER BY target, source` — the premise's description is
accurate, and there is no owner predicate.

Caller chain, complete:

1. `Store.listDangling(limit)` — `src/core/search/store.ts:541-543`
2. `listDanglingTargets(vault, opts)` — `src/core/brain/notes/scaffold-stub.ts:142-192`,
   calls it at `:183`
3. Two production callers of that:
   - `src/cli/brain/verbs/scaffold-stub.ts:105`
   - `src/mcp/brain/lifecycle-file-tools.ts:265` (tool `brain_scaffold_stub`,
     `action: "list"`; response shape at `lifecycle-file-tools.ts:266-272`)
4. One test caller: `tests/core/search/dangling-links.test.ts:49`

An owner predicate is threadable through `ListDanglingOptions`
(`scaffold-stub.ts:128-131`) as an optional field without touching either
existing caller's call site. It cannot be SQL — `documents` has no owner
column — so the shape is a post-query filter over
`isPathOwnerVisible` (`result-filters.ts:309`) applied to `t.sources`, with
the target dropped when every source is filtered away (otherwise the surviving
`target` string is itself an existence oracle for the hidden note's outbound
links).

### 6. `buildBacklinkIndex` — signature, callers, reachability

`src/core/brain/backlinks.ts:98`:

```ts
export function buildBacklinkIndex(vault: string): BacklinkIndex
```

Nine production callers:

- `src/core/brain/digest.ts:517`
- `src/core/brain/explorer.ts:88`
- `src/core/brain/link-graph/concept-cluster.ts:68`
- `src/core/brain/link-graph/moc-audit.ts:106`
- `src/core/brain/doctor/link-checks.ts:77`
- `src/core/brain/stale-dependency.ts:476`
- `src/cli/brain/verbs/backlinks.ts:15`
- `src/mcp/resources.ts:369`
- `src/mcp/brain/query-tools.ts:314` (tool `brain_backlinks`)

An optional second parameter (`ownerScope?: string | null`) leaves all nine
call sites compiling unchanged; only the ones that must enforce would pass it.

---

## What does not exist

### A. Nothing writes `owner:`

This is the finding that decides whether a predicate is enforceable or a
fiction, and it goes against the task's implicit assumption.

`owner` reaches disk through exactly one path:
`writePreference` copies `input.owner?.trim()` at
`src/core/brain/preference.ts:446` and emits the frontmatter key at
`src/core/brain/preference.ts:553` — **only when the caller supplies it**.
`parsePreference` / `parseRetired` read it back at
`preference.ts:829` and `preference.ts:1018`.

Every non-test caller of `writePreference` was checked:

- `src/mcp/brain/feedback-tools.ts:231-251` (`brain_feedback`, force-confirmed
  path) passes `slug, topic, principle, created_at, unconfirmed_until, status,
  evidenced_by, confirmed_at, confidence_value, scope` — **no `owner`**.
- `src/cli/brain/verbs/feedback.ts:139` — same shape, no `owner`.
- `src/core/brain/derived-fact.ts:135`, `src/core/brain/merge.ts:211`,
  `src/core/brain/preference-txn.ts:237` — no `owner`.

`src/core/brain/signal.ts` contains no occurrence of `owner` at all; a signal
records `agent:`, which is provenance ("who reported this"), not ownership
("who may read this"). Nothing maps `agent` → `owner`.

A grep of `src/` for owner assignment yields nine hits, all of them reads or
type declarations (`src/core/scope-key.ts:57,74`;
`src/core/brain/preference.ts:446,829,1018`;
`src/core/brain/agent-source/vault-provider.ts:104,153`;
two argument descriptions in `src/mcp/brain/query-tools.ts:633` and
`src/mcp/brain/ingest-tools.ts:384`).

**Consequence.** On a vault written entirely through the shipped MCP and CLI
surfaces by two agents, every page is ownerless, `pageOwner` returns `null`
everywhere, `isOwnerVisible` returns `true` for every (page, scope) pair, and
the isolation boundary filters nothing. The boundary is operator-authored
today: it exists only if a human hand-writes `owner:` into frontmatter, or an
external tool calls `writePreference` with an `owner` field. Files that
predate the field, and files that carry none, are shared — by design
(`agent-scope.ts:9-11`), and that design is currently the only case that ever
occurs in practice.

### B. No test asserts anything about a `NON_CONTENT` tool's payload

Established in §4 above. There is no per-surface assertion behind the label.

### C. No enumeration of the `vault_path` redaction contract

`vaultPathField(ctx)` at `src/mcp/tools.ts:109-119` is the declared way to
emit `vault_path`, rendering `vault://<hex>` unless `expose_host_paths` is
set, "since MCP responses land in model context" (`tools.ts:94-99`). It has
**three** call sites: `tools.ts:208`, `tools.ts:277`, `tools.ts:319`.

`grep -rn "vault_path: ctx.vault" src/mcp/` returns **41** sites across ten
files (`landscape-tools.ts`, `pack-tools.ts`, `recall-tools.ts`,
`generation-tools.ts`, `context-tools.ts`, `analytics-tools.ts`,
`query-tools.ts`, `review-tools.ts`, `brief-tools.ts`, `knowledge-tools.ts`).
Each emits the raw absolute host path. Confirmed EMPIRICAL: the
`brain_unlinked_mentions` response begins
`{"vault_path":"/tmp/sweep2-vault-cZQz8h",...}` and `brain_moc_audit` and
`brain_stale_scan` do the same.

No test enumerates the surfaces that must use the helper —
`tests/core/config.test.ts:519-533` and
`tests/core/config.installation-secret.test.ts:97-110` test the helper in
isolation only. This is the identical failure shape the matrix test was
written to fix (`agent-scope-matrix.test.ts:5-15`: "nothing enumerated the
surfaces, so each new one silently opted out"), reproduced in a second
dimension and currently at 41 opt-outs against 3 compliances.

---

## Corrections to the premise

### C1. `buildBacklinkIndex` is not "a full scan of `Brain/`", and `refs[].source` is not a document path

`buildBacklinkIndex` walks five specific directories —
`dirs.preferences`, `dirs.retired`, `dirs.inbox`, `dirs.processed`,
`dirs.log` (`backlinks.ts:143-147`) — not `Brain/` at large. `notes/`, the
whole user-note lane, is invisible to it.

`BacklinkRef.source` (`backlinks.ts:46-47`) is documented as "Source id
(basename without `.md`, e.g. `pref-foo`, `ret-bar`,
`sig-2026-05-14-baz`)" and is produced by `name.slice(0, -".md".length)` at
`backlinks.ts:177` and `:246`. `brain_backlinks` returns exactly that field
(`src/mcp/brain/query-tools.ts:320`).

The correction sharpens rather than weakens the concern: preferences and
retired artifacts are *precisely* the objects that can carry `owner:`
(`preference.ts:553`, `preference.ts:1018`), so a Brain artifact id is a
tighter binding to an owner than an arbitrary vault path is.

EMPIRICAL: with `pref-secret-of-a` (owner `agent-a`) and `ret-secret-b`
(owner `agent-a`) both referencing the shared `pref-shared-pref`,
`brain_backlinks {id: "pref-shared-pref"}` called as `agent-b` returned:

```
{"id":"pref-shared-pref","count":3,"refs":[
  {"source":"pref-secret-of-a","source_kind":"preference","field":"supersedes"},
  {"source":"ret-secret-b","source_kind":"retired","field":"body"},
  {"source":"sig-2026-05-01-secret-sig","source_kind":"signal","field":"source"}]}
```

### C2. `brain_hygiene` does not reach `listDangling`, and its leak is a different one

`brain_hygiene`'s `link_integrity` block comes from `measureFromIndex`
(`src/mcp/brain/hygiene-tools.ts:111-144`, importing from
`src/core/search/link-ratchet.ts`), which returns **counts only**
(`dangling`, `links`, `documents`). EMPIRICAL: `{"link_integrity":
{"definition":"ladder:links-unresolved-after-read-resolution@2","measured":true,
"dangling":4,"links":5,"documents":4}}`. No paths.

The real `brain_hygiene` leak is `findings[].targets`, rendered by
`findingView` at `hygiene-tools.ts:79-91`. EMPIRICAL, as `agent-b`:

```
"findings":[{"id":"usefulness:3256a37e2407","detector":"usefulness",
 "title":"Preference pref-secret-of-a has no recall or applied evidence since creation",
 "targets":["pref-secret-of-a"], ...}]
```

That is an artifact id plus a prose title naming it, not a path from
`listDangling`.

### C3. `brain_unlinked_mentions` returns bodies, not just identity — it belongs in the content bucket, not a new identity bucket

`MentionRef.contextSnippet` (`src/core/brain/link-graph/unlinked-mentions.ts:35-36`)
is "Line content with the match in situ (single line, untrimmed)", pushed
verbatim at `unlinked-mentions.ts:194`, and surfaced as `context` by the tool
at `src/mcp/brain/query-tools.ts:425`.

EMPIRICAL, as `agent-b`:

```
"mentions":[
 {"source":"pref-secret-of-a","line":1,"term":"Shared Pref",
  "context":"See [[pref-shared-pref]]. Also Shared Pref secretmarkerzz here."},
 {"source":"ret-secret-b","line":1,"term":"Shared Pref",
  "context":"See [[pref-shared-pref]] and Shared Pref secretmarkerzz."}]
```

`secretmarkerzz` appears only inside `agent-a`-owned artifacts. This is body
prose crossing the boundary. Any three-way split that files this tool under
"returns document identity but no bodies" would file it wrong.

### C4. `brain_moc_audit`'s leak is an existence oracle, not an enumeration

`auditMoc` (`src/core/brain/link-graph/moc-audit.ts:106-157`) only inspects
targets the caller-named hub already links to (`moc-audit.ts:80-84`), so it
cannot enumerate anything the hub's body does not already name. What it adds
is a verdict on each: `locateArtifact` succeeding puts the id in
`wellCovered`/`fragile` with a `bodyChars` measurement
(`moc-audit.ts:113-128`); failing puts it in `candidateMissing`
(`moc-audit.ts:115`).

EMPIRICAL, hub `pref-hub` linking to two `agent-a`-owned members, three
ownerless members and one absent target, called as `agent-b`:

```
"fragile":[{"id":"pref-secret-a1","backlinkCount":0,"bodyChars":38},
           {"id":"pref-secret-a2","backlinkCount":0,"bodyChars":38}, ...]
"candidate_missing":[{"id":"pref-missing-secretmarkerzz","referenceCount":1}]
```

Exists-vs-absent is decided, and `bodyChars` sizes the private body. That is
the same class of leak the codebase already refuses at
`preferences-collect.ts:298-303` and `agent-scope-matrix.test.ts:556-594`.

### C5. `brain_scaffold_stub` is the only one of the five that leaks a real vault document path — and the premise's fix location for it is wrong

EMPIRICAL, as `agent-b`, against a forced full index:

```
{"action":"list","state":"measured","targets":[
 {"target":"Secretmarkerzz Page","sources":["notes/shared.md"]},
 {"target":"missing-target-of-a","sources":["notes/secret-a.md"]},
 {"target":"missing-target-shared","sources":["notes/shared.md"]},
 {"target":"pref-missing-x","sources":["Brain/preferences/pref-shared-pref.md"]}]}
```

`notes/secret-a.md` carries `owner: agent-a`. Its path crosses. Note also that
`target: "Secretmarkerzz Page"` leaks the private page's **title** through a
link written from a shared note — a second channel a `sources` filter alone
would not close.

The premise says the predicate "belongs in both `listDangling` and
`buildBacklinkIndex` in the same change". `listDangling` is a SQL function
over a schema with no owner column (`schema.ts:103-113`); a predicate cannot
go there. It belongs one layer up, in `listDanglingTargets`
(`scaffold-stub.ts:142`), where the vault root is in hand and
`isPathOwnerVisible` can be called.

Precondition worth noting: `brain_scaffold_stub action=list` refuses unless
the index records a completed full pass (`scaffold-stub.ts:172-180`). On an
incrementally-indexed vault it returns `state: "partial_resolution"` and no
targets at all — EMPIRICAL, reproduced before adding `{ force: true }`.

### C6. The bucket contains **nine** identity-leaking tools, not five — and four of the nine leak with a bare no-argument call

A sweep invoked every `NON_CONTENT` tool with `{}` as `agent-b` against a
two-owner vault under `owner_scope_delivery: fail`, then re-ran the
argument-requiring ones with plausible arguments. Markers were strings present
only inside `agent-a`-owned artifacts.

Leaks confirmed EMPIRICAL, with what crosses:

| Tool | Call | What crosses |
|---|---|---|
| `brain_backlinks` | `{id: <shared id>}` | `refs[].source` — private artifact ids |
| `brain_unlinked_mentions` | `{id: <shared id>}` | `mentions[].source` **and** `mentions[].context` (body prose) |
| `brain_moc_audit` | `{id: <shared hub>}` | `fragile[].id`, `bodyChars`, exists-vs-missing verdict |
| `brain_hygiene` | `{mode: "scan"}` | `findings[].targets` ids + titles naming them |
| `brain_scaffold_stub` | `{action: "list"}` | `targets[].sources` vault paths + private page titles |
| `brain_doctor` | `{}` | `errors[].path` — `Brain/preferences/pref-secret-of-a.md`, `Brain/retired/ret-secret-b.md`, `Brain/inbox/sig-…-secret-sig.md` |
| `brain_claims` | `{}` | `claims[].path`, `.topic`, **and `.principle` — the full rule text** |
| `brain_idea_discovery` | `{}` | `source_artifacts[]` paths plus a `reason` sentence naming the path |
| `brain_stale_scan` | `{}` | `stale_preferences[].{prefId,topic,path}`, `stale_signals[].path` |
| `brain_event_trace` | `{}` | `events[].body.path` from log payloads |

That is **ten** surfaces (the five named plus `brain_doctor`, `brain_claims`,
`brain_idea_discovery`, `brain_stale_scan`, `brain_event_trace`). Two of the
ten — `brain_unlinked_mentions` and `brain_claims` — return bodies, so the
"identity but no bodies" framing does not partition this set either.

`brain_claims {}` is the sharpest counter-example to the whole "metadata"
label:

```
"claims":[{"id":"pref-secret-of-a","path":"Brain/preferences/pref-secret-of-a.md",
  "topic":"secret-of-a","principle":"secretmarkerzz principle", ...}]
```

Verified clean under the same sweep (no marker in the payload):
`second_brain_status`, `brain_dream`, `brain_intent_review`, `brain_retention`,
`brain_review_candidates`, `brain_pinned_context`, `brain_agent_diff`,
`brain_sources`, `brain_health`, `brain_status`, `brain_codegraph_report`,
`brain_foresight`, `brain_knowledge_gaps`, `brain_mcp_landscape`,
`vault_health`, `brain_watchdog`, `list_skills`, `tool_hydrate`,
`brain_audit`, `brain_analytics` (`timeline`, `attention_flows`, `dedup`),
`brain_bridges`, `brain_clusters`, `brain_truth`, `brain_dead_ends`,
`brain_tiers`, `brain_entity`, `schema_inspect view=graph`,
`brain_context_receipts`, `brain_decision`, `brain_tension`,
`brain_generation_reports`, `brain_procedural_memory`, `brain_skill_proposals`,
`brain_recurrence`, `brain_intention`, `brain_obligation`, `brain_trigger`.

"Clean" here means "clean on this fixture". `brain_stale_scan` read clean in
the first sweep and leaked in the second — the only difference was adding
`tags: []` so the preference parsed. Several of the clean results are clean
because the fixture produced no rows, not because the surface is structurally
safe. A per-surface assertion is the only thing that can distinguish the two,
which is the same point question (2) makes.

### C7. The premise's framing of question (1) is the wrong question first

"Does 'a path is metadata' survive a vault with more than one writing agent?"
presumes such a vault can exist. §A establishes it cannot arise through the
shipped writers: no write path sets `owner:`, so a two-agent vault is a vault
of ownerless, shared pages and every tool above is correctly labelled today.

The honest statement is: the label is not wrong, it is **unconditioned**. It
is true on the only vaults the product produces and false on the vaults the
`owner:` field was designed for. Both halves need saying, and a fix that
filters paths without also making ownership assignable ships a boundary that
still nothing ever crosses.

---

## Where a fix belongs

Smallest native placements, in dependency order. Nothing here is a new
subsystem; each is an existing seam.

1. **`isPathOwnerVisible` / `isOwnerVisible` stay the only rule.**
   `src/core/search/result-filters.ts:309` and
   `src/core/graph/agent-scope.ts:104`. Any new filter calls one of these. A
   second ownership comparison written inline would be the parallel idiom the
   repo forbids.

2. **Ownership must become assignable before it can be enforced.**
   The native seam is `WritePreferenceInput.owner`
   (`src/core/brain/preference.ts:142`), already plumbed to disk at
   `preference.ts:553`. What is missing is a caller. `brain_feedback`
   (`src/mcp/brain/feedback-tools.ts:231`) already resolves an agent identity
   for the signal's `agent:` field; whether `owner` should default from it, be
   an explicit argument, or be operator-gated is a design decision this recon
   does not make — but it is one decision in one file, and without it items 3
   and 4 are unreachable code.

3. **Path-returning surfaces: filter at the aggregator, not in SQL.**
   - `listDanglingTargets` (`src/core/brain/notes/scaffold-stub.ts:142`) —
     add an optional owner scope to `ListDanglingOptions`
     (`scaffold-stub.ts:128`), filter `t.sources` through
     `isPathOwnerVisible`, and **drop the whole target** when no source
     survives, so `target` cannot act as an oracle for a hidden note's links.
     `listDangling` itself (`links.ts:170`) stays untouched.
   - `buildBacklinkIndex` (`src/core/brain/backlinks.ts:98`) — optional second
     parameter; resolve each collected `source` id back to its file (the
     collectors already hold `full` at `backlinks.ts:176` and `:244`) and test
     `pageOwner` there. All nine call sites keep compiling.

4. **The enforcement mechanism, which is the actual deliverable.**
   `tests/mcp/agent-scope-matrix.test.ts` currently has one mechanism (the
   exactly-once partition) and it protects nothing in two of three buckets.
   The native fix is not a fourth bucket label — that repeats the defect the
   file's own header describes — but a **generic per-surface probe**: build
   one two-owner fixture vault, call every tool in the non-scoped buckets, and
   assert the payload contains no marker unique to the other owner's
   artifacts. The sweep script that produced §C6 is a working prototype of
   exactly that; each entry then needs a call recipe (arguments) rather than a
   bare name, which turns `NON_CONTENT: string[]` into
   `NON_CONTENT: {name, args, reason}[]` and makes an unclassifiable tool fail
   loudly.

   A bucket without a probe behind it is a label, and the task title is right
   about what that is worth.

5. **Errors stay explicit.** `listDanglingTargets` already models this well:
   `refusal(state, detail)` at `scaffold-stub.ts:119-126` returns a named
   state and a `nextCommand` rather than an empty list. A filtered-away result
   must not become an indistinguishable empty list where the surface already
   has a channel to say why — but note the counter-pressure from
   `preferences-collect.ts:298-303`: under `fail`, saying *how many* were
   withheld is itself the leak. The resolution the codebase already uses is
   "identical to absent", and a new filter should match it rather than invent
   a third convention.

---

## Defects noticed

**D1. 41 MCP responses emit the raw absolute host path as `vault_path`,
against a contract stated in the codebase.**
Contract at `src/mcp/tools.ts:94-119`; honoured at `tools.ts:208, 277, 319`;
violated at 41 sites across `src/mcp/brain/{landscape,pack,recall,generation,
context,analytics,query,review,brief,knowledge}-tools.ts`. Confirmed EMPIRICAL
in `brain_unlinked_mentions` (`query-tools.ts:419`), `brain_moc_audit`
(`knowledge-tools.ts:324`) and `brain_stale_scan`. No test enumerates the
surfaces. This is in scope for a release that fixes what it finds, and it is
mechanically the same defect as the one this task is about: a rule with no
enumeration behind it.

**D2. `brain_scaffold_stub action=list` leaks a private page's *title*, not
only its path.** `targets[].target` carries the link spelling verbatim
(`links.ts:150`, `scaffold-stub.ts` response at
`lifecycle-file-tools.ts:269`). A shared note writing `[[Secretmarkerzz Page]]`
against an owner-private target publishes that target's title to every caller.
Filtering `sources` alone does not close it.

**D3. `brain_moc_audit` counts backlinks from artifacts the caller may not
see.** `inboundFromOthers` at `moc-audit.ts:123` folds every ref in the
unfiltered index. Even with member ids filtered, the count would remain a
population estimate of the private set — the exact failure the
`brain_agent_query` roster test at `agent-scope-matrix.test.ts:556-594` was
written to prevent, in a surface that has no such test.

**D4. `buildBacklinkIndex` silently drops any preference whose frontmatter
uses the un-prefixed Group C shape.** `normalizeDerivedKeys`
(`preference.ts:725-741`) throws on a bare `status:`, and the collector's
`catch { continue; }` at `backlinks.ts:193-195` swallows it. Reproduced
accidentally during this recon: a fixture with `status: confirmed` produced an
index missing every preference-sourced ref, with no diagnostic. The module
header at `backlinks.ts:24-25` declares this deliberate ("`brain_doctor` is the
surface that flags malformed artifacts"), so it is defensible — but the
consequence is that `brain_backlinks` returns a confidently wrong `count: 0`
on a legacy vault, and the caller has no way to tell that from a genuine zero.
The same shape `listDanglingTargets` refuses to ship
(`scaffold-stub.ts:119-126`) is shipped here.

**D5. `brain_labels {operation: "show", id: ...}` rejects `id` with
"path must be a vault-relative string".** EMPIRICAL. Either the argument name
in the error is wrong or the schema advertises an argument the handler does
not accept; worth one look at `src/mcp/brain/admin-tools.ts:402`.

**D6. `schema_inspect view=lint|orphans` raises a hard parse error carrying an
absolute host path.** EMPIRICAL: `preference missing field: retired_at
(/tmp/sweep2-vault-cZQz8h/Brain/retired/ret-secret-b.md)`. A *lint* view that
cannot report on a malformed artifact without dying on it inverts its own
purpose, and the message leaks the host path D1 is about.

---

## Reproduction

Scripts under
`/tmp/claude-1001/-srv-projects-open-second-brain/f6f02ff9-6785-4ac9-8e4c-95f95be29cb5/scratchpad/`:
`probe.ts` (five named tools), `probe2.ts` (backlinks / mentions / hygiene at
the core-function level), `sweep.ts` (all `NON_CONTENT` tools, no arguments),
`sweep2.ts` (argument-requiring tools), `moc.ts` (MOC threshold fixture). Run
with `env HOME=<empty-dir> bun <script>` per the clean-HOME convention. The
index must be built with `indexVault(config, { force: true })` or
`brain_scaffold_stub` refuses (`scaffold-stub.ts:174-180`).
