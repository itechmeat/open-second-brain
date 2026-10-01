# Example CLI outputs and JSON shapes - search/diagnostics/vault-hygiene wave

Reference shapes the fourteen tasks will emit. Rendering follows the tree's conventions: human lines via `ok()` on stdout, progress on stderr, `--json` shapes on stdout, and every new finding names its recovery. Values below are illustrative.

## 1. Readiness probes (`o2b doctor --readiness`, Tasks 6 and 10)

New probes in the existing registry; plain `o2b doctor` output stays byte-identical.

```text
readiness:
  embedding-provider         pass      openai-compat / text-embedding-3-small / 1536
  runtime-adapter-wiring     pass      11 adapter(s) wired
  installed-runtimes         pass      9 verified, 0 drift, 0 unreachable
  registered-commands        unknown   1 of 8 registered commands could not be confirmed
    claude     ~/.claude.json          command "o2b"            bare name not on this process's PATH (the client's spawn PATH may still resolve it)
    aider      ~/.aider.conf.yml       managed block            present
    grok       ~/.grok/settings.json   command "bun"            `bun` resolved; script /home/me/old/osb/src/cli/main.ts does not exist
    pi         (no config_path)        nothing to probe         skill-symlink entry
  writeback-contract         skipped   AGENTS.md has no Open Second Brain managed block
    detail: the ambient write-back managed block is not installed, so the write gate is not graded; recovery: add the ambient write-back managed block between the begin and end marker lines, stating the marker_writeback same-turn atomic-fact write gate
```

A proved-absent absolute path renders `fail` for the probe with the recovery line `o2b install <target> --apply` in the entry detail; a bare name that does not resolve is never a `fail` (the spawn-PATH caveat is printed verbatim). Exit semantics are unchanged: any `fail` drives `DOCTOR_EXIT.failed`, any `unknown` drives `probeIncomplete` (6).

## 2. Functional self-test (`o2b doctor selftest`, Task 9)

```text
doctor selftest: temp vault /tmp/osb-selftest-a1b2c3 (removed)
  store-open          ok    init + migrations v1..v6, wal mode: wal (measured)
  index               ok    3 documents, 7 chunks, 1 concurrent-writer race resolved by writer-lock
  search              ok    keyword roundtrip: 1 hit for "alpha", 42ms p50 / 55ms p100 over 20 queries
  delete              ok    document removed, 0 orphan rows
  close               ok
doctor selftest: ok (7 checks, 0 warnings)
```

`--json` (stable key order across runs):

```json
{
  "verb": "doctor-selftest",
  "ok": true,
  "warnings": 0,
  "walMode": "wal",
  "tempVault": "/tmp/osb-selftest-a1b2c3",
  "stages": [
    { "name": "store-open", "ok": true, "message": "init + migrations v1..v6, wal mode: wal (measured)", "durationMs": 118 },
    { "name": "index", "ok": true, "message": "3 documents, 7 chunks, 1 concurrent-writer race resolved by writer-lock", "durationMs": 640 },
    { "name": "search", "ok": true, "message": "keyword roundtrip: 1 hit for \"alpha\"", "metrics": { "queries": 20, "p50Ms": 42, "p100Ms": 55 }, "durationMs": 310 },
    { "name": "delete", "ok": true, "message": "document removed, 0 orphan rows", "durationMs": 9 },
    { "name": "close", "ok": true, "message": "", "durationMs": 4 }
  ]
}
```

Exit codes reuse `DOCTOR_EXIT`: 0 all stages pass; 1 any stage fails (the failing stage names the fault and the fix); 6 the harness itself could not run (e.g. temp storage unavailable).

## 3. Maintenance honesty (`o2b brain maintenance run`, Task 8)

```text
maintenance: 1 of 4 tasks failed
  embedding spend: model text-embedding-3-small, 214 chunks pending, estimated $0.011 (gate: off)
  reindex:      ok in 18234ms (tokens=38110, estimatedUsd=0.0076, model=text-embedding-3-small)
  bridges:      TIMED OUT (safeguard 120s) in 120001ms
  clusters:     ok in 4211ms
```

Same run, exit code: **6** (`MAINTENANCE_EXIT.probeIncomplete`) - the timed-out pass is "could not find out", not a proved failure. A deterministic task error still exits **1** and outranks a timeout; a refusal-only run still exits **7**.

`--json`:

```json
{
  "verdict": "failed",
  "spend": {
    "banner": { "model": "text-embedding-3-small", "pendingChunks": 214, "estimatedUsd": 0.011, "gateUsd": 0 },
    "receipt": { "model": "text-embedding-3-small", "tokens": 38110, "estimatedUsd": 0.0076, "forced": false }
  },
  "tasks": [
    { "name": "reindex", "ok": true, "duration_ms": 18234, "receipt": { "model": "text-embedding-3-small", "tokens": 38110, "estimatedUsd": 0.0076, "forced": false } },
    { "name": "bridges", "ok": false, "timed_out": true, "error": "safeguard timeout after 120s", "duration_ms": 120001 },
    { "name": "clusters", "ok": true, "duration_ms": 4211 }
  ]
}
```

A `--force-cost` bypass over a positive gate sets `"forced": true` on the receipt.

## 4. Hybrid deadline degradation (Task 4)

Search result envelope, degradation trail:

```json
{
  "degradations": [
    { "code": "hybrid-degraded", "detail": { "reason": "hybridDeadlineExceeded" } },
    { "code": "hybrid-deadline-exceeded", "detail": { "elapsedMs": 15003, "budgetMs": 15000 } }
  ],
  "results": [ "…keyword-lane rows only…" ]
}
```

Human surface: one stderr warning - `warning: hybrid deadline 15000ms exceeded at 15003ms; returning keyword-only results`. Config: `search_hybrid_deadline_ms` (default 15000), env `OPEN_SECOND_BRAIN_SEARCH_HYBRID_DEADLINE`.

## 5. Ranking receipts (Tasks 3 and 5)

Per-result `reasons` strings under the two guards:

```text
1. [[hub-page]] score=2.14
   bm25 lead, pinned (+0.05 cap layer), link +0.03, gated: no lexical vote suppressed 4 layers
```

`--explain` breakdown (JSON):

```json
{
  "breakdown": {
    "bm25": 1.82,
    "pinned": 0.05,
    "link": 0.03,
    "entity": 0,
    "gate": { "active": true, "lexicalVote": false, "suppressedLayers": ["entity", "activation", "coAccess", "reuse"] }
  }
}
```

Relational pin (cross-encoder on, `search_relational_rerank_pin` on): the trail notes `relational-pin: 2 candidate(s) floored at pre-rerank positions 1, 3`. Both guards off -> byte-identical output to today.

## 6. Near-duplicate on a note receipt (Task 11)

The MCP note receipt gains a `lint` entry exactly when a finding exists (additive-absent-when-clean):

```json
{
  "path": "Brain/captures/cdk-deploy-notes.md",
  "written": true,
  "lint": {
    "findings": [
      {
        "kind": "near-duplicate",
        "message": "resembles 1 same-scope page",
        "evidence": [
          { "path": "Brain/captures/cdk-deploy-notes-2.md", "jaccard": 0.86 }
        ]
      }
    ]
  }
}
```

The write ALWAYS proceeds; nothing gates.

## 7. Hygiene findings (Tasks 12 and 14)

```json
{
  "scan": { "detectors": ["conflicts", "dedup", "freshness", "usefulness", "slug-collisions"], "findings": 2, "errors": 0 },
  "findings": [
    {
      "id": "slug-collisions:9f2a…",
      "detector": "slug-collisions",
      "severity": "info",
      "title": "3 notes share the slug stem \"topic\" in Brain/captures/",
      "targets": ["Brain/captures/topic.md", "Brain/captures/topic-2.md", "Brain/captures/topic-3.md"],
      "proposed_action": "review",
      "evidence": { "stem": "topic", "directory": "Brain/captures", "mtimes": ["2026-09-01T10:00:00Z", "2026-09-01T10:00:01Z", "2026-09-12T08:31:00Z"] }
    }
  ]
}
```

Tags detector (opt-in: `--detectors tags`); header states the scope:

```json
{
  "scan": { "detectors": ["tags"], "findings": 2, "errors": 0, "scope": "inline body tags only; frontmatter tags: arrays are not audited" },
  "findings": [
    {
      "id": "tags:1c7b…",
      "detector": "tags",
      "severity": "info",
      "title": "Malformed tag: the index will never match #my tag!",
      "targets": ["Brain/notes/ideas.md"],
      "proposed_action": "review",
      "evidence": { "class": "malformed", "tag": "#my tag!", "reason": "rejected by the index tag rule (space not allowed); accepted by the looser Obsidian rule" }
    },
    {
      "id": "tags:44e0…",
      "detector": "tags",
      "severity": "info",
      "title": "Inconsistent tag spellings: #Foo vs #foo",
      "targets": ["Brain/notes/a.md", "Brain/notes/b.md"],
      "proposed_action": "review",
      "evidence": { "class": "inconsistent", "variants": ["#Foo", "#foo"] }
    }
  ]
}
```

Default `o2b brain hygiene` runs `DEFAULT_SCAN_IDS` (includes slug-collisions, excludes tags).

## 8. Hub candidates through the repair lane (Task 13)

Drain (apply mode) appends to `Brain/.state/repair-candidates.jsonl` and reports:

```text
inbox drain: 2 routed
  idea  captured/cdk-deploy-notes.md  (hub candidate: unique hub Brain/areas/ops.md)
  idea  captured/grocery-ideas.md     (hub candidate: refused, skip-no-hub, scope bucket (unscoped))
```

`o2b brain repair-lane` (dry-run default) merges the file candidates:

```text
repair lane: 3 candidate(s) in dry-run order
  write   [[captured/cdk-deploy-notes.md]] -> [[areas/ops]]    area_membership  confidence 1.00  (area hub for scope (unscoped))
  skip-no-hub        captured/grocery-ideas.md  no hub page in scope bucket (unscoped)
  skip-ambiguous-hub captured/plan-notes.md     2 hub pages in scope bucket project=atlas: Brain/areas/atlas.md, Brain/areas/atlas-index.md
```

Apply still requires `--confirm "apply repair"` and passes the graph-holdout gate; refusals are never re-decided, never counted in `written`, never capped. Rerunning the drain after apply proposes nothing new (forward-scan convergence).

## 9. Brain doctor merge-chain finding (Task 7)

```text
brain doctor:
  merge-chain-dangling  pref-0012  merged_into -> pref-0007, but no file exists for pref-0007
    this page is excluded from dedup candidacy until the pointer is resolved
    repair is a content judgement: re-point, un-merge, or restore the canonical (no automated repair)
```

Registered in `DIAGNOSTIC_SIGNALS` with an exclusion row (content judgement), so the doctor exit census stays green. Over-deep chains are NOT duplicated here - `o2b brain lint` already renders them.

## 10. Event-time window census (Tasks 1 and 3)

`o2b search status` (or the census consumer) gains:

```json
{
  "counts": { "documents": 412, "chunks": 1893, "embeddings": 1893, "staleEmbeddings": 0 },
  "eventTimeWindow": {
    "since": "2026-09-01T00:00:00Z",
    "until": "2026-09-30T23:59:59Z",
    "documents": 412,
    "declared": 377,
    "intersecting": 118,
    "mtimeFallback": 35
  }
}
```

`mtimeFallback` is the unmeasured bucket (no declared event time) - named, never hidden as zero.
