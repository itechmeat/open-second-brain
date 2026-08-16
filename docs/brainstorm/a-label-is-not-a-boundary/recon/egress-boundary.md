# Egress boundary recon — what actually leaves this machine today

Branch `feat/a-label-is-not-a-boundary`. Read-only reconnaissance against
`main`-descended source at `280469d2`. Every claim below carries a
`file:line` anchor that was read, or a command that was run against a
scratch vault under the session scratchpad.

Scope: verify two kanban task bodies (`t_08f6ffca` "sanitize a personal
brain into a shareable team brain", `t_09a3752a` "portable repo-visibility
verification before sensitive data leaves the machine") against this
codebase, and establish what egress actually exists.

---

## 1. What exists — the boundary is already built, and it is named

Both task bodies were written as if this repository had no egress
boundary. It has one, and it is a mature one.

- `src/core/egress/guard.ts:147` — `redactForEgress(site, payload)`. The
  one call every export path makes before its bytes leave the vault.
- `src/core/egress/guard.ts:72-83` — a three-value verdict:
  `released`, `refused_scan_truncated`, `refused_secret_identifier`.
  Both refusals are fail-closed: the export "either scanned its payload
  or it did not go" (`guard.ts:26`).
- `src/core/egress/registry.ts:85-167` — Registry R2, seven declared
  egress sites, each with a `reason` string that is required to be
  non-empty.
- `tests/core/architecture/egress-census.test.ts` — derives the
  POPULATION of egress modules structurally from source and asserts the
  registry accounts for all of it, then checks each declaration against
  the module's own text (`:204-215`, `:241-260`).

The registry answers task (B) directly and explicitly:

> "The vault has no git transport and deliberately never will, so there
> is no commit or push boundary to gate."
> — `src/core/egress/registry.ts:6-8`

Verified independently: every `git` invocation in `src/` is read-only.
`src/core/brain/git/reader.ts:104` runs `git -C <repo> <args>` where the
args are log/show reads; `:394` runs `remote get-url origin`.
`src/core/discipline/activity-git.ts:25-37` runs `git log --numstat`.
There is no `push`, `commit`, `clone`, `add`, or `remote add` anywhere
under `src/`, `scripts/`, or `hooks/`.

### The redaction policy, precisely

`src/core/egress/guard.ts:125-128` sets exactly two flags:

```
redactTokens: true
redactUrlCredentials: true
```

`redactInfra` is OFF, deliberately and with a stated reason
(`guard.ts:43-49`): a `host:port` or a public IP in an authored note is a
reference a portable bundle has to keep.

What the shared redactor catches (`src/core/redactor.ts`):
key=value / `key: value` / JSON / `Authorization: Bearer` assignment
shapes (`:1-17`); vendor-prefixed tokens `sk-`, `ghp_`, `xox?-`, `AKIA`,
`AIza`, `glpat-` (`:317-329`); bare mixed-class runs of ≥24 characters
(`:337-338`); base64 credentials 32-64 chars (`:385-394`);
`<private>…</private>` region stripping (`:492`, applied from `:621`).

---

## 2. Egress inventory — complete, and wider than the registry

The registry covers **file destinations only**. Four further categories
cross a trust boundary and are not in it. This is the honest inventory.

### A. Declared file exports — guarded (7 sites)

| Site | Verb | Module | Status |
|---|---|---|---|
| `brain-bank-export` | `o2b brain bank-export` | `src/cli/brain/verbs/bank-export.ts:28` | guarded |
| `brain-graph-export` | `o2b brain graph-export` | `src/cli/brain/verbs/graph-export.ts` | guarded |
| `brain-okf-export` | `o2b brain okf-export` | `src/cli/brain/verbs/okf-export.ts:48` | guarded |
| `brain-preference-export` | `o2b brain export` | `src/cli/brain/verbs/export.ts` | guarded |
| `config-export` | `o2b export-config` | `src/cli/main.ts` | guarded |
| `brain-continuity-export` | `o2b brain continuity export` | `src/cli/brain/verbs/continuity.ts` | guarded |
| `install-adapter-out` | `o2b install --out` | `src/cli/install/install.ts` | `no_vault_content` |

### B. UNDECLARED file export — unguarded (defect D1, below)

`o2b brain explorer --export <path>` —
`src/cli/brain/verbs/explorer.ts:15,28`. Writes a self-contained HTML
file carrying the full preference graph as embedded JSON. Zero calls to
`redactForEgress` in either `src/cli/brain/verbs/explorer.ts` or
`src/core/brain/explorer.ts`; not present in `EGRESS_SITES`. The census
cannot see it because its flag is named `export`, which is in neither
`DESTINATION_FLAGS` nor `AMBIGUOUS_DESTINATION_NAMES`
(`tests/core/architecture/egress-census.test.ts:96-118`).

### C. Network egress — real, continuous, and outside the registry entirely

1. **Embedding provider** — `src/core/search/embeddings/openai-compat.ts:440-451`
   POSTs `{model, input: texts}` to the configured endpoint with a bearer
   key. `texts` is `batch.map((p) => p.content)`
   (`src/core/search/indexer.ts:966-967`) — raw vault chunk bodies. No
   `redactForEgress`, no `stripPrivateRegions`; grep for `private|redact`
   over `src/core/search/chunker.ts` and `src/core/search/indexer.ts`
   returns nothing. **This is the largest and most continuous egress in
   the product and nothing scans it.** Same shape at
   `src/core/search/embeddings/zeroentropy.ts:200` and
   `src/core/search/rerank/cross-encoder.ts:85`.
   Also reached from `src/core/brain/hygiene/detectors/dedup.ts:145`
   (preference principles) and `src/core/brain/entities/semantic-dedup.ts:331`
   (entity names).
2. **Telegram capture** — `src/core/brain/capture/telegram-capture.ts:433`
   POSTs `/catchup` reply text to the Bot API. Transport is built only by
   the CLI runner verb (`:411-413`).
3. **External research fetch** — `src/core/brain/research/external-fetch.ts:231`.
   Agent-composed search queries to Brave/Tavily. Key-gated; a `null` key
   makes every call a typed `disabled` error (`:6-8`).
4. **MCP over HTTP** — `src/mcp/http.ts:40-49`. Loopback by default, and
   **already fail-closed**: a non-loopback bind without `--api-key` is
   refused with "refusing to expose an unauthenticated endpoint on the
   network". This is the closest existing analogue to task (B)'s ladder.
5. **Explorer live server** — `src/core/brain/explorer.ts:322-337`.
   `127.0.0.1` hard-coded and non-optional; serves the same unredacted
   graph JSON at `/data.json`.

No telemetry, analytics, or phone-home exists. Every `telemetry` module
under `src/core/brain/` writes into the vault's own continuity log.

### D. Second-vault mirrors and cross-vault reads

- `src/core/brain/shared-namespace.ts:42-84` — opt-in `shared_namespace`
  config key mirrors feedback signals and notes into a SECOND vault root,
  stamped with `origin_vault`. Fail-soft by contract (`:12-15`). No
  redaction of any kind on the mirror path.
- `src/core/search/cross-vault.ts` and
  `src/core/brain/portability/recall-sources.ts:1-14` — other vaults
  attached as READ-ONLY recall origins. Ingress, not egress.
- `src/core/brain/portability/profiles.ts` — named multi-vault profiles;
  local pointer file, no egress.

### E. Hermes plugin / openclaw

Neither adds network egress. `plugins/hermes/bridge.py:299` spawns
`o2b mcp` as a local subprocess over pipes. `src/openclaw/index.ts:15`
imports `redactConfigMapping` for its status tool.

---

## 3. Corrections to each premise

### Task (A) — "sanitize a personal brain into a shareable team brain"

| Premise | Verdict |
|---|---|
| "Open Second Brain has no personal-to-team export path" | **Wrong.** Two bidirectional bundle formats exist with CLI verbs on both sides: `bank-export`/`bank-import` (`src/cli/brain.ts:297`) and `okf-export`/`okf-import` (`src/cli/brain.ts:375`). |
| "only `sanitize-principle.ts` (narrow single-principle text sanitization)" | **Wrong.** That file (`src/core/brain/text/sanitize-principle.ts`, 68 lines) has nothing to do with privacy — it strips leaked tool-call XML fragments and backslash-escape amplification from corrupted frontmatter (`:5-17`). The privacy machinery is `src/core/redactor.ts` + `src/core/egress/guard.ts`. |
| "no staging-copy / strip-keep / history-purge module found" | **Correct, and correctly absent.** There is no git history to purge (`registry.ts:6-8`). The export IS the staging copy — it is a fresh tree composed read-only from the vault. |
| Validator: "value depends on an unproven team-sharing use case" | **Half right.** The export bundle is the only multi-recipient artefact, and it is already consumed by a second party's `bank-import`. The unproven part is not the artefact, it is who reads it. |

Corrected framing for (A): the export path exists, is guarded, and
already refuses two classes of unsafe payload. The gap is not a missing
sanitizer — it is that **a `private` label is not a boundary**.

Proven by running it. A page with `private: true` in frontmatter AND
`tags: [private, confidential]` exported **in full** through
`okf-export`; only the inline `<private>…</private>` REGION marker was
honoured:

```
--- vault/page-one.md (input) ---     --- okf/concepts/page-one.md (output) ---
Authorization: Bearer ghp_ABC…        Authorization: Bearer ***REDACTED***
<private>                             ***PRIVATE***
Salary discussion…
</private>

--- vault/page-three.md (input) ---   --- okf2/concepts/page-three.md (output) ---
private: true                         private: true            <- label ignored
tags: [private, confidential]         tags: [private, confidential]
postgres://admin:hunter2@10.4.4.9     postgres://***REDACTED***@10.4.4.9
internal-jump.corp.example:2222       internal-jump.corp.example:2222   <- kept
IP 203.0.113.44                       IP 203.0.113.44                   <- kept
operator itechmeat@gmail.com          operator itechmeat@gmail.com      <- kept
```

Grepping `src/core/brain/portability/` and `src/core/brain/regions.ts`
for any honouring of a `private` frontmatter key or tag returns nothing.
The only content-derived `private` signal in the product is the region
marker, at `src/core/brain/continuity/redaction.ts:9` — and it governs
the continuity log, not pages.

### Task (B) — "portable repo-visibility verification, fail closed both ways"

| Premise | Verdict |
|---|---|
| "OSB scans content for leaks but does not verify a destination remote is private before pushing" | **Correct in the second half, and there is nothing to fix.** There is no push. |
| Validator: "NO INTEGRATION SUBSTRATE: no git-push path in src (verified by grep this run)" | **Confirmed, and it is a design commitment, not an omission** — `src/core/egress/registry.ts:6-8` states it in prose. |
| "where the visibility check hooks in is an open decision" | **Closed by this recon.** Nowhere. A repo-visibility ladder guarding an operation this product does not perform is a fail-closed check with nothing to guard. |

The transferable idea from upstream is the *shape*, not the subject:
verify the destination before the bytes go, and refuse when the answer is
unprovable. That shape already exists twice here —
`guard.ts:147-176` (refuse an unscannable payload) and
`src/mcp/http.ts:45-49` (refuse an unauthenticated non-loopback bind).
The place it is missing is the destinations that actually exist.

---

## 4. Smallest native unit per task

### (A) → Make `--export` an egress site, and make the census able to see it

Four edits, all inside existing structures:

1. `tests/core/architecture/egress-census.test.ts:96-104` — add `export`
   to `DESTINATION_FLAGS`. It is unambiguous: nothing reads from an
   `--export`. Grep confirms `explorer.ts:15` is the ONLY flag in `src/`
   matching `(export|save|write|archive|snapshot|bundle): { type: "string" }`,
   so this widens the population by exactly one module — the tripwire
   firing on a real hole, which is the behaviour the census documents at
   `:361-369`.
2. `src/core/egress/registry.ts` — add a `brain-explorer-export` entry
   with `redaction: sharedRedactor` and a reason naming what the HTML
   carries (every preference principle verbatim, plus the vault path via
   `src/core/brain/explorer.ts:286-288`).
3. `src/cli/brain/verbs/explorer.ts:22-32` — route the graph through
   `redactForEgress("brain-explorer-export", graph)` before
   `renderExportedHtml`, honouring both refusal arms and emitting
   `EGRESS_REDACTION_NOTICE` on stderr, exactly as `bank-export.ts:44`
   does.
4. A regression test that the exported HTML does not contain a
   vendor-prefixed key present in the vault.

This is native because it adds no concept: it fills the seventh slot in a
registry whose docstring already says its purpose is "what stops a
seventh appearing unredacted" (`registry.ts:10-11`).

**Optional second half, if the label question is in scope**: decide
whether `private: true` frontmatter is a boundary. Today it is not, and
nothing in the code claims it is — so either honour it in the export
composers (`okf.ts`, `graph.ts`, `page-contract.ts`) or state in
`registry.ts`'s reason strings that the region marker is the only
privacy primitive. Stating it is cheaper and is the repo's own idiom
("that gap is stated here rather than left to be discovered",
`guard.ts:48-49`).

### (B) → Retarget to the destination that exists, or close the task

There is no push to guard. The honest native units, in order of value:

1. **Close (B) as not-applicable**, citing `registry.ts:6-8`. The task
   body's own validator already found the missing substrate; this recon
   confirms the absence is a commitment.
2. If the fail-closed *shape* is wanted, the destination that actually
   exists and is unverified is the **shared-namespace mirror**
   (`src/core/brain/shared-namespace.ts:42-84`): it writes signals into a
   second vault root the operator names, with no redaction and no
   verification that the target is a vault the operator owns. A
   `verifyMirrorTarget` that refuses an unresolvable or non-vault target
   would be the same ladder against a destination that is real here. Note
   it already refuses one case — a self-mirror (`:92-94`).
3. The **embedding endpoint** is the other real unverified destination:
   raw vault content to an operator-configured URL with no scan. A
   fail-closed check there (refuse to embed a chunk whose text carries a
   vendor-prefixed credential, rather than shipping it) would be the
   highest-value application of (B)'s principle in this codebase.

---

## 5. Defects noticed

### D1 — `explorer --export` writes unredacted credentials (HIGH)

Observed in the bytes. Scratch vault, one preference created through the
real writer (`o2b brain feedback --force-confirmed`), then:

```
$ o2b brain explorer --vault $V --export $SP/explorer.html
exported 1 nodes to …/explorer.html

$ grep -o '"nodes":\[[^]]*\]' explorer.html
"nodes":[{"id":"pref-secret-leak","kind":"preference","topic":"secret-leak",
"principle":"Always deploy with OPENAI_API_KEY=sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234
 set from <operator-home>/private-client-work", …}]
```

The identical principle through `bank-export` comes out as
`OPENAI_API_KEY=***REDACTED***`. Anchors: `src/cli/brain/verbs/explorer.ts:15,28`
(flag and write), zero `redactForEgress` in that file or in
`src/core/brain/explorer.ts`, zero `explorer` in
`src/core/egress/registry.ts`. The census gap is
`tests/core/architecture/egress-census.test.ts:96-118`.

### D2 — OKF `log.md` is silently empty on every default install (MEDIUM)

`src/core/brain/portability/okf.ts:334`:

```ts
const dateRe = /^(\d{4}-\d{2}-\d{2})\.md$/;
```

matches only the LEGACY un-sharded log filename. The current default
writes a per-device shard `<date>.<deviceId>.md`
(`src/core/brain/log.ts:113-114`, `:256-258`). Observed: `Brain/log/`
contained `2026-08-16.bb4363ed.md`, and the export reported
`0 log day(s)` with an empty `log.md`. The bundle presents "this vault
has no change log" as a fact rather than reporting that it could not read
one — the misleading success this repo forbids.

### D3 — Signal-provenance wikilinks are destroyed by the egress guard, and the damage survives import (MEDIUM)

`sig-2026-08-16-secret-leak` is 26 characters of `[A-Za-z0-9_-]` mixing
letters and digits, and is not pure hex, so it matches
`HIGH_ENTROPY_TOKEN_RE` (`src/core/redactor.ts:337-338`) and is replaced.
Every OSB signal id has the shape `sig-YYYY-MM-DD-<slug>` and crosses the
24-character gate as soon as the slug reaches 9 characters — i.e.
routinely. Round trip observed end to end:

```
on disk:   _evidenced_by: ["[[sig-2026-08-16-secret-leak]]"]
exported:  "evidenced_by": ["[[***REDACTED***]]"]
imported:  _evidenced_by: ["[[***REDACTED***]]"]     <- restored 1 of 1, failed 0
```

`bundle.ts:35-41` anticipates exactly this hazard ("a placeholder is a
constant — two records that lost a name land on one") and guards the
NAMING fields via `redacted_identifier` refusals. It does not guard
`evidenced_by`, so the import reports full success while writing a
dangling wikilink that every preference with a redacted signal id shares.
`CONTENT_ADDRESS_RE` (`redactor.ts:356`) already carves out hex ids for
this reason; a `sig-<date>-<slug>` carve-out is the same fix.

### D4 — `collectExportRows` silently drops unparseable preferences (MEDIUM)

`src/core/brain/export.ts:106-107` and `:118-119` both `continue` on a
caught exception. Observed during this recon: a preference file with
legacy un-prefixed Group C frontmatter keys produced
`"preferences": []` in the bundle with exit code 0 and nothing on stderr,
while the file sat on disk. This is a path that writes data outward while
swallowing the error that says the data is incomplete — an export that
omits a rule reads identically to a vault that never had it.
`src/core/brain/explorer.ts:105-108` has the same shape with an explicit
comment.

### D5 — Shared-namespace mirror swallows the reason (LOW)

`src/core/brain/shared-namespace.ts:52-54` and `:80-83` catch and return
`"failed"` with no diagnostic. Fail-soft is the stated contract
(`:12-15`) and is right, but discarding the message means an operator
whose mirror has been silently failing for a month has no way to learn
whether the cause is a permission error, a missing directory, or a
corrupt target vault.

### D6 — Duplicated `isoSecond` (TRIVIAL)

`src/core/brain/secrets/store.ts:309-311` reimplements the helper that
`src/core/brain/time.ts` already exports and that `shared-namespace.ts`
imports.

---

## 6. Answer to "is there a team brain here"

Yes, but exactly one artefact, and it is not a vault.

The only multi-recipient artefacts are the **export bundles**:
`bank-export` → `bank-import` and `okf-export` → `okf-import`. Both have
importers a second person runs. Everything else that looks multi-party is
not: cross-vault recall sources are read-only ingress
(`recall-sources.ts:1-14`), profiles are one operator's own vaults
(`profiles.ts:1-13`), and the shared namespace is a one-way mirror
between agents, not people (`shared-namespace.ts:15-17`).

So the honest scope for (A) is: **guard the export that does exist.**
That is D1.
