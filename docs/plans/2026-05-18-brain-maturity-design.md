# v0.10.5 — Brain maturity + embeddings activation

Status: draft
Owners: TBD
Source: `/root/vault/Projects/OpenSecondBrain/Features/_summary.md` §14, §12, §15-tail, §4-tail; `/root/vault/Projects/OpenSecondBrain/Features/embedding-provider-activation.md` (Hermes onboarding report)

## Context

`_summary` groups four items under the theme "Brain maturity, when rules
grow numerous". They are independent in code surface but share one
intent: once a vault accumulates tens of preferences, the operator and
the agents need (a) a way to see the rule set as a graph rather than a
flat list, (b) a way to recognise and resolve near-duplicate rules
without LLM help, (c) better calibration of new entries at the moment
they are written, and (d) per-runtime cadence reminders so the existing
record-discipline scales to long Claude Code sessions and one-shot Codex
execs without drifting.

All four ship in one PR under the `v0.10.5` CHANGELOG entry. They share
no executable surface, but they share the deferred-work block in
`_summary.md` (two of them retire entries there), the digest renderer
(§12 adds a section), and the `tokenise`/`jaccard` helpers (§12 lifts
them out of `doctor.ts` so both `doctor` and `merge-candidates` reuse
one implementation — DRY).

## Goals

- **G1.** A local browser-based explorer over `Brain/preferences/` and
  `Brain/retired/`. Two modes: live (loopback HTTP server, re-reads on
  every `/data.json` request, no watchers) and static export (single
  HTML file with inlined data, no server). Zero backend, no LLM, no
  network. Force layout, status / scope / topic filters, full-text
  search over `principle` and `topic`, right-side detail panel.
- **G2.** Merge-suggestions in `brain_digest` plus an explicit
  `o2b brain merge <keep-pref-id> <drop-pref-id>` CLI. The digest
  surfaces pairs of confirmed/quarantine preferences with same
  `(topic, scope)` and jaccard-similar `principle` between
  `JACCARD_MERGE_SUGGEST_THRESHOLD` and `JACCARD_DUPLICATE_THRESHOLD`.
  The CLI merges keep-first: `keep` stays, `drop` retires with reason
  `merged-into`. No auto-merge.
- **G3.** A `## Examples — good vs bad` section in
  `skills/brain-memory/SKILL.md`. Four contrastive pairs covering weak
  vs strong `principle`, too-general vs precise `topic`, and `note`
  with and without "why".
- **G4.** Per-runtime cadence in `hooks/lib/messages.ts:postWriteReminder`
  and `hooks/lib/messages.ts:stopGuardrailReason`. Runtime is detected
  from the hook payload shape via a new `detectHookRuntime` helper in
  `hooks/lib/detect.ts`. Three branches: `claudecode`, `codex`,
  `unknown`. Unknown is byte-identical to the current text — absolute
  back-compat.
- **G5.** macOS `sqlite-vec` activation works out of the box. A new
  `scripts/_macos-sqlite.sh` shim, sourced from `scripts/o2b`,
  detects Darwin + Homebrew SQLite and exports `DYLD_LIBRARY_PATH`
  so `bun:sqlite` picks up a build with `LOAD_EXTENSION` enabled.
  No-op on Linux and on macOS without `brew install sqlite`.
- **G6.** `o2b search check` becomes actionable: when
  `vec_extension: unavailable` or `embedding_key: missing`, the
  output ends with a concrete recipe (env var to set, brew command
  to run, next command to invoke). JSON output gains a
  `recommendations` array with the same shape.
- **G7.** `o2b search reindex --cron-template` prints a ready-to-use
  watchdog script plus crontab line (and a `hermes cron create`
  invocation when applicable). Pure stdout, writes nothing — agents
  copy the recipe into the host's cron infrastructure. Preserves
  the "no daemon in OSB core" invariant.
- **G8.** New `embeddings-setup` SKILL describing when to engage
  the proactive setup flow (trigger: user mentions embeddings /
  semantic search / `o2b search check` warns) and the exact step
  sequence (check → request key → on macOS suggest `brew install
  sqlite` → reindex → offer `--cron-template`).

## Non-goals (explicitly deferred)

Each entry below is recorded in `_summary.md → ## Deferred work` in the
same commit so it survives across planning sessions.

- **D14.1 — Obsidian deep-link on double-click in the explorer.** The
  live mode could open `obsidian://` URIs since it knows the vault
  path; the export mode runs from anywhere on disk and does not. We
  keep the surfaces identical: principle visible in the right panel,
  id button to copy. Trigger to revisit: an operator asking for
  click-through into Obsidian.
- **D14.2 — Live refresh in the explorer (SSE / WebSocket).** Manual
  F5 is enough for the first iteration. A push channel breaks the
  "zero backend" invariant. Trigger: an operator asking for it.
- **D14.3 — Layout-state persistence across runs.** Nodes resettle
  every load. `localStorage` keyed by `id → {x, y}` is cheap but not
  critical. Trigger: visible complaint about positions jumping.
- **D12.1 — MCP `brain_merge` tool.** Merge is rare, mutating, and
  operator-initiated after reviewing the digest. The agent should not
  call it autonomously. Trigger: a concrete agent use-case that
  warrants automating the choice.
- **D12.2 — Bulk / interactive merge walkthrough.** Today the CLI
  takes one `(keep, drop)` pair per invocation. Trigger: ≥10 stable
  suggestions surface in `brain_digest` for at least one operator.

## §14 — Local explorer

### Surface

```bash
o2b brain explorer                            # live, default port 7777
o2b brain explorer --port 8080                # live on a different port
o2b brain explorer --export <path>            # static single-file HTML
o2b brain explorer --export <path> --force    # overwrite an existing file
o2b brain explorer --vault <path> [...]       # override the configured vault
```

Live binds to `127.0.0.1` only. The CLI prints the URL and waits on
SIGINT. Every GET `/` rebuilds the graph from disk and substitutes the
JSON into the template; every GET `/data.json` does the same and serves
the bare JSON. No watchers, no caches, no write endpoints. Bun's
`Bun.serve` is the HTTP layer (already a project dependency).

Export reads the same template, replaces the data placeholder, writes
to the given path. Without `--force` an existing file aborts with exit
1. No partial writes — the file is written atomically through the
existing `fs-atomic` helper.

### Modules

```ts
src/core/brain/explorer.ts
  - collectExplorerData(vault: string): ExplorerGraph     // pure read
  - renderExportedHtml(graph: ExplorerGraph): string      // template + inline JSON
  - buildLiveServer(vault: string, port: number):         // Bun.serve
      { url: string; close: () => Promise<void> }

templates/brain-explorer.html
  - <style>  ~80 lines, system fonts, light/dark via prefers-color-scheme
  - <body>   canvas, left panel (filters + search), right panel (node details)
  - <script type="application/json" id="brain-data">__GRAPH_JSON__</script>
  - <script> ~250 lines:
      parseGraph, miniForceLayout, canvasRenderLoop,
      hitTest, filterAndSearch, renderRightPanel
```

The placeholder `__GRAPH_JSON__` is a unique sentinel string that
appears nowhere else in the template. Both live and export substitute
the same way.

### Graph schema

```ts
interface ExplorerGraph {
  readonly generated_at: string;       // ISO-8601
  readonly schema_version: 1;
  readonly vault_basename: string;     // last segment of vault path, for the page <title>
  readonly nodes: ReadonlyArray<ExplorerNode>;
  readonly edges: ReadonlyArray<ExplorerEdge>;
}

interface ExplorerNode {
  readonly id: string;                 // "pref-*" or "ret-*"
  readonly kind: "preference" | "retired";
  readonly topic: string;
  readonly scope: string | null;
  readonly principle: string;          // full body — used for tooltip and search
  readonly status: "unconfirmed" | "confirmed" | "quarantine" | "retired";
  readonly confidence: "low" | "medium" | "high" | null;
  readonly confidence_value: number | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly pinned: boolean;
  readonly retired_reason: string | null;
  readonly last_evidence_at: string | null;
  readonly backlink_count: number;
}

interface ExplorerEdge {
  readonly source: string;             // pref-* or ret-* id
  readonly target: string;             // pref-* or ret-* id
  readonly kind: "supersedes" | "wikilink";
}
```

Signals (`sig-*`) and log days are deliberately excluded from the
graph — they are noise for observability. Edges come from two sources:

1. Frontmatter `supersedes` / `superseded_by` → kind `supersedes`.
2. Inline `[[...]]` in `principle` and pref/retired body text →
   kind `wikilink`. The existing `buildBacklinkIndex` already enumerates
   these; the explorer filters its output down to edges where both
   endpoints are preference or retired ids.

`backlink_count` is the count of inbound edges *of any kind in the
backlink index* — including refs from log entries and signals — so it
matches what `brain_digest` already reports under "Top referenced".

Stable ordering: nodes sorted by `(kind asc, id asc)`, edges by
`(source asc, target asc, kind asc)`. The same vault state produces
byte-identical JSON across runs.

### Visual coding (browser-side)

- **Node colour by status:** confirmed = green, unconfirmed = yellow,
  quarantine = orange, retired = grey. Concrete hex values match the
  digest section labels for cross-surface consistency (TBD in impl —
  pick once, write once).
- **Pinned:** gold stroke around the node.
- **Size:** `8 + sqrt(applied_count) * 6`, clamped to `[8, 40]`.
- **Edge style:** `supersedes` — red dashed; `wikilink` — thin grey.
- **Clustering:** soft attractor per `topic` (virtual centre, weak
  spring); topic centres weakly repel each other. No layered layout,
  just charge + spring.

### Mini physics engine

A Verlet-style integrator in plain JS, ~150 lines. State per node:
`{x, y, vx, vy}`. Per tick: (a) topic-centre attraction with constant
`K_TOPIC = 0.005`, (b) global charge repulsion `K_CHARGE = 600` against
all other nodes, (c) edge spring `K_SPRING = 0.05` with rest length
proportional to size sum, (d) velocity damping 0.85, (e) clamp to
canvas. `requestAnimationFrame` loop. Layout settles in ~3–5 seconds on
~200 nodes (back-of-envelope; verify in impl).

Quality is acceptable up to ~300 nodes. For larger vaults a notice
"layout may be sluggish — consider filtering by topic" in the right
panel; we do not gate.

### Right panel

Selected node renders:
- id, principle, topic, scope.
- status badge with confidence band/value.
- applied_count / violated_count.
- pinned flag.
- last_evidence_at.
- backlink_count.
- retired_reason and superseded-by link if retired.
- list of inbound and outbound edges with kind labels.

Empty selection: short legend (colour → status, size → applied_count,
edge styles) and counts (N preferences, M retired, K edges).

### Error handling

| Condition | Behaviour |
|---|---|
| `--vault` not found | `CliError` from existing `resolveBrainVault` |
| `Brain/preferences/` and `Brain/retired/` both absent | empty graph, HTML shows "No preferences yet" |
| corrupt frontmatter in a `pref-*.md` | skip the node, stderr warning once (same convention as digest) |
| live port already in use | exit 1, message "port 7777 already in use; try --port N" |
| `--export <path>` already exists, no `--force` | exit 1, message "<path> exists; pass --force to overwrite" |

## §12 — Merge suggestions and `o2b brain merge`

### Surface

```bash
o2b brain merge <keep-pref-id> <drop-pref-id> [--dry-run] [--force] [--vault <path>]
```

- Without flags, the CLI prints the plan (resulting `evidenced_by`,
  `applied_count`, `violated_count`, retired path for `drop`) and
  prompts `y/N`. EOF or anything other than `y`/`Y` aborts.
- `--dry-run` prints the plan and exits 0; no disk writes.
- `--force` bypasses the interactive prompt. It does **not** bypass
  invariant guards (mismatched topic/scope, pinned mismatch) — those
  always abort.

### Merge rules

| `keep` field | Result |
|---|---|
| `id`, `topic`, `scope`, `principle`, `created_at`, `confirmed_at`, `unconfirmed_until`, `status`, `pinned` | unchanged (keep wins) |
| `evidenced_by` | sorted dedup of `keep.evidenced_by ∪ drop.evidenced_by` |
| `applied_count` | `keep + drop` |
| `violated_count` | `keep + drop` |
| `last_evidence_at` | `max(keep, drop)` by ISO-8601 string comparison |
| `confidence`, `confidence_value` | unchanged at merge time — recomputed by the next `dream` pass from the merged counters |

`drop` lands in `retired/` with:
- `retired_reason: merged-into` (new constant in `BRAIN_RETIRED_REASON`).
- `superseded_by: [[<keep-id>|<keep.principle>]]`.
- `retired_at: now` (UTC, second precision, same as the rest of the
  Brain writers).
- `retired_by: [[Brain/log/<today>]]`.

### Guards

Each is a fail-loud abort with exit 1. `--force` does not bypass any of
them — they are data invariants, not UX safety nets.

1. Both ids resolve to files under `preferences/`. If either points
   into `retired/` (already retired) → abort.
2. `topic` and `scope` are identical (treating `null === null`). →
   abort with the suggestion "use `o2b brain reject` if `drop` is
   wrong, not `merge`".
3. Pin parity: if one is pinned and the other is not, the pinned side
   must be `keep`. → abort with the suggestion "put the pinned one
   first as `<keep>`".
4. `keep.id === drop.id` → abort.

### Atomicity

No snapshot is created for `merge`. The operation is point-precise and
the existing `o2b brain reject` (the closest analogue) does not snapshot
either. Roll-back path: copy `retired/<drop-id>.md` back to
`preferences/<drop-id>.md` and re-run `dream` to recompute counters.

Write order:
1. `writePreference({ ...mergedKeep, overwrite: true })`.
2. `moveToRetired(vault, dropPath, "merged-into", { now, retired_by, superseded_by })`.
3. `appendLogEvent(vault, mergeEvent)` — new event kind `merge`.
4. `regenerateActiveQuiet(vault, { now })` — `drop` drops out of
   `active.md`, `keep` reflects the merged counters.

Step 1 leaves an intermediate state on disk where `keep` is updated but
`drop` is still in `preferences/`. A crash between (1) and (2) would
leave the vault with a duplicate-looking pair, which `o2b brain doctor`
already reports as `duplicate-preferences`. No corruption, no data
loss — the operator re-runs `merge` to finish.

### Log event shape

```markdown
## 2026-05-18T11:23:45Z merge
- keep: [[pref-foo|Use imperative voice in commit subjects]]
- drop: [[pref-bar|Imperative commit messages]] (now [[ret-bar]])
- signal_union: 8 (was 5, 4)
- applied_sum: 17 (was 11, 6)
- violated_sum: 1 (was 1, 0)
- agent: <agent_name>
```

`agent` comes from the new `BRAIN_AGENT_NAME` env var that the install
flow already sets — same convention as `o2b brain reject`.

### `merge-candidates` detector

```text
src/core/brain/merge-candidates.ts
  - findMergeCandidates(vault: string, opts?: { threshold?: number }):
      ReadonlyArray<MergeCandidate>
```

```ts
interface MergeCandidate {
  readonly a: string;          // lexicographically smaller of the two ids
  readonly b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly jaccard: number;    // rounded to 0.01
}
```

The function:
1. Reads `confirmed` and `quarantine` preferences (the same filter as
   `checkDuplicatePreferences`).
2. Groups by `(topic, scope ?? "")`.
3. Pairwise jaccard on `tokenise(principle)`.
4. Keeps pairs with `jaccard >= threshold`.
5. Sorts by `(jaccard desc, a asc, b asc)`.
6. Truncates to `MERGE_SUGGESTION_LIMIT = 10`.

Default threshold: `JACCARD_MERGE_SUGGEST_THRESHOLD = 0.6`. Pairs in
`[0.6, 0.85)` are merge candidates only (surface in digest). Pairs
`>= 0.85` continue to be flagged by `doctor` as `duplicate-preferences`
AND surface in the digest — the operator sees them on both surfaces at
different intensities.

### Similarity helpers (DRY)

`tokenise` and `jaccard` are currently private to `src/core/brain/doctor.ts`.
Lift them as-is to `src/core/brain/similarity.ts` and update `doctor.ts`
to import. No functional change; existing doctor tests act as regression
coverage. The helpers are pure functions, suitable for unit tests
moved/duplicated under `tests/core/brain/similarity.test.ts`.

### Digest integration

A new optional section in `renderDigest`, between `## Top referenced`
and `## Confidence shifts`:

```markdown
## Merge suggestions

- [[pref-foo|Principle one]] ≈ [[pref-bar|Principle two]] — topic 'mocking', scope 'testing', jaccard 0.72
- [[pref-baz|Principle three]] ≈ [[pref-qux|Principle four]] — topic 'commits', no scope, jaccard 0.64
```

JSON form:

```ts
interface DigestJsonMergeSuggestion {
  readonly a: string;
  readonly b: string;
  readonly principle_a: string;
  readonly principle_b: string;
  readonly topic: string;
  readonly scope: string | null;
  readonly jaccard: number;
}
```

Added to `DigestJson` as `merge_suggestions: ReadonlyArray<…>`. The JSON
`schema_version` is **not** bumped: additive optional fields are
non-breaking under the project's current convention (only changes to
existing field shapes or removed fields would warrant a bump).

Empty list → section omitted in Markdown, empty array in JSON.

The `isEmpty` digest predicate is **not** updated to count merge
suggestions. `merge_suggestions` reflects current vault state, not
windowed change — including it would turn every digest into "not
empty", defeating the silent-if-no-changes contract.

`MERGE_SUGGESTION_LIMIT = 10` (defined in `merge-candidates.ts` and
re-exported, mirroring `HOT_SECTION_LIMIT`).

## §15-tail — Good vs bad section in `skills/brain-memory/SKILL.md`

Insertion point: after `## Rules`, before `## Fallback capture surfaces`.

```markdown
## Examples — good vs bad

**Bad:** `principle: "Write good commits"`
**Good:** `principle: "Use imperative voice in commit subjects; describe what the commit does, not what was done"`
*Why:* the bad form is unenforceable — no future signal can reasonably mark an artifact as "applied" or "violated" against it. The good form names a checkable behaviour.

**Bad:** `principle: "Be careful with secrets"`
**Good:** `principle: "Do not commit `.env`, credentials, or API keys; route them through environment variables"`
*Why:* the bad form is a vibe. The good form gives the agent a concrete list of patterns to spot in a diff.

**Bad:** `topic: "stuff"`
**Good:** `topic: "no-internal-abbrev"`
*Why:* topic is the stable bucket future signals join. A generic slug collects unrelated rules; a precise one keeps the cluster meaningful and lets `brain_query --topic <slug>` return a focused slice.

**Bad:** `note: "fixed it"`
**Good:** `note: "expanded 'OSB' to 'Open Second Brain' on first use — README diff still carried the abbreviation, would have confused a new reader"`
*Why:* notes survive the artifact. Without the "why" line you cannot tell in three months whether a violation was a regression or a deliberate change.
```

No code, no config. Hermes picks up the change on next gateway restart;
Claude Code picks it up on the next `SessionStart` (the
`sync-claude-skills.sh` hook reads the canonical source).

## §4-tail — Per-runtime cadence in post-write reminder and stop guardrail

### `detectHookRuntime`

```text
hooks/lib/detect.ts
  - type HookRuntime = "claudecode" | "codex" | "unknown"
  - function detectHookRuntime(payload: unknown): HookRuntime
```

Detection order (first hit wins):

1. `payload.transcript_path` is a string containing `/.claude/projects/`
   or `/.claude/sessions/` → `claudecode`.
2. `payload.transcript_path` is a string containing `/.codex/sessions/`
   → `codex`.
3. Payload exposes Claude Code's distinctive triple
   (`session_id`, `cwd`, `tool_use_id` all present as strings) →
   `claudecode`.
4. Payload exposes Codex's distinctive single field
   (`function_call_output` present, or `tool_name === "apply_patch"`
   with `tool_input.input` being a patch string) → `codex`.
5. Otherwise → `unknown`.

Detection is best-effort and **silent on failure**: malformed payload,
missing fields, unexpected types all return `unknown`. The hook never
crashes on detection.

### Reminder text

`postWriteReminder({ toolName, filePath, runtime })`:

```ts
function cadenceLine(runtime: HookRuntime): string {
  switch (runtime) {
    case "claudecode":
      return [
        "_Claude Code session: many turns ahead — capture the signal_",
        "_or evidence now rather than batching to end-of-session; long_",
        "_sessions risk forgetting the context that distinguishes one_",
        "_artifact from the next._",
      ].join("\n");
    case "codex":
      return [
        "_Codex `codex exec` is a one-shot run — call `brain_feedback`_",
        "_or `brain_apply_evidence` before this exec returns; there_",
        "_is no second turn._",
      ].join("\n");
    case "unknown":
      return "";
  }
}
```

The cadence block is rendered between the opening sentence
(`Open Second Brain hook: you just ran ...`) and the
`brain_feedback`/`brain_apply_evidence` paragraphs. When `runtime ===
"unknown"` the empty string is filtered out, so the rendered text is
byte-identical to the current v0.10.4 output — back-compat is
unconditional.

`stopGuardrailReason(runtime)` follows the same pattern, with its own
cadence block:
- `claudecode`: "_This guardrail fires at most once per turn — send_
  _another reply (with or without `event_log_append`) to clear it._"
- `codex`: "_This `codex exec` is about to end — call_
  _`event_log_append` now or finish silently; no further guardrail will fire._"
- `unknown`: empty.

### Call-site updates

```text
hooks/post-write-reminder.ts
  - import detectHookRuntime
  - const runtime = detectHookRuntime(payload)
  - postWriteReminder({ toolName, filePath, runtime })

hooks/stop-log-guardrail.ts
  - import detectHookRuntime
  - const runtime = detectHookRuntime(payload)
  - reason: stopGuardrailReason(runtime)
```

`hooks.json` matchers stay unchanged.

### What this does NOT touch

- `templates/identity-reminder.<target>.txt` — those are the per-turn
  identity reminders for Hermes / OpenClaw (shipped in v0.10.4),
  unrelated mechanism.
- `O2B_TARGET` env var — that's the resolver for `buildReminder`, not
  for hook reminders. No new env var introduced.
- `hooks/active-inject.ts` — different hook, different cadence.

## §E — Embeddings activation

Folded into v0.10.5 in response to the Hermes onboarding report at
`/root/vault/Projects/OpenSecondBrain/Features/embedding-provider-activation.md`.
Three independent slices, all additive, no breaking changes.

### §E.1 — macOS `sqlite-vec` shim

`scripts/_macos-sqlite.sh` is sourced by `scripts/o2b` immediately
after the Bun precheck:

```bash
. "$SCRIPT_DIR/_bun-precheck.sh"
. "$SCRIPT_DIR/_macos-sqlite.sh"
exec bun run "$REPO_ROOT/src/cli/main.ts" "$@"
```

Shim contract:

- Returns early on non-Darwin (Linux ignores the file entirely).
- Returns early when `DYLD_LIBRARY_PATH` is already set — never
  clobbers a user-configured environment.
- Probes two Homebrew lib prefixes:
  - `/opt/homebrew/opt/sqlite/lib` (Apple Silicon)
  - `/usr/local/opt/sqlite/lib` (Intel)
- On the first existing directory, exports `DYLD_LIBRARY_PATH=<dir>`.
- Returns 0 unconditionally — the shim never blocks the wrapper.

The shim does **not** install `brew sqlite`. If neither prefix
exists, `o2b search check` will report `vec_extension: unavailable`
and the recommendations block (§E.2) tells the operator what to
run.

The Bun:sqlite resolver consults `DYLD_LIBRARY_PATH` before the
default `/usr/lib/libsqlite3.dylib`, so once the path is set Bun
picks the Homebrew build that ships without
`SQLITE_OMIT_LOAD_EXTENSION`. That makes `sqlite-vec`'s
`db.loadExtension(getLoadablePath())` succeed.

### §E.2 — Actionable hints in `o2b search check`

`IndexCheckReport` gains an optional `recommendations: string[]`.
The renderers (human and JSON) surface it as a block after the
existing warnings/fatals.

Recommendation rules:

| Trigger | Recommendation |
|---|---|
| `embedding_key_resolved === false` | `Set OPEN_SECOND_BRAIN_EMBEDDING_KEY in ~/.hermes/.env (or ~/.config/open-second-brain/.env)` followed by `Pick a provider: OpenAI \`text-embedding-3-small\` (~$0.02 / 1M tokens) — or any OpenAI-compatible endpoint via OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL.` |
| `vecExtension === "unavailable"` AND host is Darwin | `Install Homebrew SQLite: \`brew install sqlite\`. The o2b wrapper picks it up automatically on the next invocation.` |
| `vecExtension === "unavailable"` AND host is Linux | `sqlite-vec did not load. Run \`bun pm ls\` to confirm the optional dependency landed, or rebuild with \`bun install --force\`.` |
| Both above are OK AND no embeddings yet (`semantic_enabled === false`) | `Run \`o2b search reindex --embeddings\` to compute the first vectors, then optionally \`o2b search reindex --cron-template\` for periodic refresh.` |

Host detection: `process.platform === "darwin"` resolves Darwin;
no other OS branch is needed because the Linux hint is generic.

JSON shape:

```ts
interface IndexCheckReport {
  // existing fields ...
  readonly recommendations: ReadonlyArray<string>;
}
```

The recommendations list is empty when nothing is actionable —
e.g. an already fully wired install. Existing callers that did not
expect the field are unaffected (additive).

### §E.3 — `o2b search reindex --cron-template`

New flag on the existing `reindex` verb:

```bash
o2b search reindex --cron-template [--interval <duration>] [--vault <path>]
```

When set, the verb prints the template **to stdout and exits 0
without indexing**. Side effects: none. The template carries:

1. A bash watchdog script body (commented header explains how to
   save it) that:
   - Sources `~/.hermes/.env` if present, otherwise the same file
     resolution as the rest of the CLI.
   - Runs `o2b search reindex --embeddings --json`.
   - Parses the JSON, suppresses output when `stats.added +
     stats.updated + stats.deleted === 0` (no changes), prints a
     one-line summary otherwise.
   - Exits non-zero only on real reindex failure.
2. A native crontab line for the chosen interval (default 30
   minutes; `--interval 6h` / `--interval 10m` accepted with the
   same parser used by `hermes cron`).
3. A `hermes cron create` invocation as the recommended path on a
   Hermes-bearing host. (Detection of Hermes is best-effort — the
   line prints unconditionally with a "if Hermes is available"
   header note. Pure stdout, no filesystem probe.)

The template is rendered from a fixed string with three
substitutions: the script's exec path (resolved through the same
process used by `install-cli`), the chosen interval expression,
and the Hermes job id placeholder (`<your-job-id>`). No external
template engine.

`--interval` parser shares logic with the existing duration
parser used elsewhere in the search CLI; if the project has no
single helper today, a new one lands in
`src/cli/search.ts` (private) and is reused only inside that
file.

### §E.4 — `embeddings-setup` SKILL

New skill at `skills/embeddings-setup/SKILL.md`. Shipped alongside
the existing `brain-memory` SKILL so Hermes / Claude Code / Codex
all see it in their tool list.

Skill body lays out:

- **When to invoke.** Triggers: user mentions "embedding",
  "semantic search", "vector index"; OR an agent runs
  `o2b search check` whose output contains `vec_extension:
  unavailable` or `embedding_key: missing` or any
  recommendation line.
- **Decision flow.** Always start with `o2b search check`;
  branch on what it reports. The branches mirror the
  recommendations table from §E.2 so the SKILL stays in sync if
  recommendations evolve.
- **macOS branch.** Install `brew sqlite`, no script patching —
  the OSB wrapper handles `DYLD_LIBRARY_PATH` automatically.
- **Key handling.** Never echo or commit the key. Prompt the
  user, then write to `~/.hermes/.env` or the configured env
  file. Use a placeholder when the user hasn't supplied a value
  yet so the agent never invents a fake one.
- **Periodic indexation.** After the first successful
  reindex, offer `o2b search reindex --cron-template` and
  explain the interval trade-off (30 min if the vault changes
  actively; 6 h if it's mostly read-only).
- **Multi-agent note.** Only the agent designated as the
  reindex owner (typically Hermes) needs
  `OPEN_SECOND_BRAIN_EMBEDDING_KEY` — read-only consumers
  (Claude Code, Codex) operate on the already-computed vectors
  and do not need credentials.

The SKILL is the proactive surface; the CLI hints in §E.2 are
the reactive one. Both call the same recipes — the SKILL has
narrative, the hints are one-liners with the same commands.

### §E.5 — Non-goals (added to the deferred list)

- **D-E.1 — Automatic `brew install` invocation.** The SKILL
  tells the user / agent to run it; OSB itself never calls
  `brew`. Adding package-manager side effects to a CLI wrapper
  invites privilege questions and platform-specific edge cases
  out of proportion to the win.
- **D-E.2 — `o2b search reindex --watch` long-running daemon.**
  The OSB invariant "no daemon" stands. `--cron-template` is the
  endorsed path; `--watch` would force a process-lifecycle story
  (systemd / launchctl / supervisor) that the project deliberately
  avoids.
- **D-E.3 — Auto-write of crontab entries.** The CLI prints the
  template; the operator (or the agent in the user's name)
  decides where it lands. Direct `crontab -e` invocation is
  invasive and platform-specific.

## Tests

| File | Coverage |
|---|---|
| `tests/core/brain/explorer.test.ts` | `collectExplorerData` against a fixture vault: node and edge counts, filtering signals/log out of edges, statuses, `confidence_value === null` legacy prefs, deterministic byte-identical JSON across two runs. `renderExportedHtml` substitutes the placeholder exactly once and the resulting `<script type="application/json">` block round-trips through `JSON.parse`. |
| `tests/cli/brain-explorer.test.ts` | `o2b brain explorer --export <tmp>` creates the file; second run without `--force` exits 1; with `--force` overwrites. Live mode — spawn subprocess, GET `/`, GET `/data.json`, assert Content-Type, assert `127.0.0.1` binding, SIGINT shuts down. Port already in use exits 1 with the documented message. |
| `tests/core/brain/similarity.test.ts` | `tokenise` over utf-8, punctuation, multilingual input; `jaccard` for empty, identical, disjoint, partial. Mirrors the coverage formerly inside `doctor.test.ts` so the lift-out has explicit regression. |
| `tests/core/brain/merge-candidates.test.ts` | Fixture-driven: pairs in `[0.6, 0.85)` surface; pairs `>= 0.85` also surface (and `doctor` still flags them); pairs across different `(topic, scope)` do not; unconfirmed and retired prefs do not; stable `(jaccard desc, a asc, b asc)` ordering; `MERGE_SUGGESTION_LIMIT` truncates. |
| `tests/core/brain/digest.test.ts` (extended) | New fixture with a merge-candidate pair → Markdown `## Merge suggestions` section and JSON `merge_suggestions` array present. Existing fixtures without candidates → section absent, JSON field empty. `isEmpty` predicate not affected by merge suggestions. |
| `tests/core/brain/merge.test.ts` | Full merge against a fixture: `evidenced_by` deduped union, summed counters, `last_evidence_at = max`, retired file with `merged-into` and `superseded_by`, `merge` log event, `active.md` regenerated, `keep.pinned` preserved. Guard cases: mismatched topic, mismatched scope, pinned mismatch (drop pinned, keep unpinned), `keep === drop`, drop already retired. `--dry-run` performs no writes. |
| `tests/cli/brain-merge.test.ts` | CLI shape: positional parsing, error exits with documented wording, interactive `y/N` through the existing `readSingleLine` pump, `--force` skips the prompt but not the guards. |
| `tests/hooks/detect.test.ts` (extended) | `detectHookRuntime` against fixtures of each runtime's known payload shape; malformed payloads (missing fields, wrong types) return `unknown` without throwing. |
| `tests/hooks/post-write-reminder.test.ts` (extended) | Existing cases stay green. New: Claude Code payload produces the `Claude Code session` cadence line; Codex payload produces the `Codex exec` cadence line; unknown produces no cadence line — and the resulting `additionalContext` matches the pre-change v0.10.4 string byte-for-byte. |
| `tests/hooks/stop-log-guardrail.test.ts` (extended) | Symmetric coverage for `stopGuardrailReason`. |
| `tests/scripts/macos-sqlite-shim.test.ts` | Spawn the shim under bash with `uname` stubbed via `PATH` overrides; assert `DYLD_LIBRARY_PATH` exported only on Darwin + when a Homebrew prefix exists; assert no-op when `DYLD_LIBRARY_PATH` is preset; assert no-op on Linux (`uname` says `Linux`). |
| `tests/core/search/check-recommendations.test.ts` | Drive `indexCheck` against curated fixtures: missing key → recommendation referencing `OPEN_SECOND_BRAIN_EMBEDDING_KEY`; vec unavailable on Darwin (mock `process.platform`) → `brew install sqlite`; both OK and no embeddings → reindex recipe; fully healthy install → empty recommendations array. |
| `tests/cli/search-cron-template.test.ts` | `o2b search reindex --cron-template` prints a non-empty body containing the keywords `crontab`, `o2b search reindex`, and (when `--interval 6h`) `0 */6 * * *`. Verb writes nothing to disk under `tmp`; `--cron-template` without `--vault` still resolves through the existing machine config; `--cron-template --interval garbage` exits 1 with a parser error. |

SKILL.md (§15-tail) carries no test surface — it is documentation. The
`embeddings-setup` SKILL (§E.4) likewise: prose-only, the test surface
is the live agent flow.

## Migration

None.

- §14 is pure-read against existing Brain state, no schema change.
- §12 introduces one new constant (`BRAIN_RETIRED_REASON.merged-into`)
  and one new log event kind (`merge`). Existing vaults remain valid
  — the new reason and event are only emitted when an operator runs
  `o2b brain merge`. `brain_doctor` accepts unknown retired-reason
  strings already (treats them as opaque).
- §15-tail is text inside a SKILL file; no schema and no parser.
- §4-tail is back-compat by construction: `unknown` runtime renders the
  pre-change text byte-for-byte. The new `runtime` field on
  `PostWriteReminderInput` is required at the type level (TypeScript
  catches missed call-sites at compile time), but production has only
  two call-sites (the two hook scripts) and they are updated in the
  same PR.
- §E.1 macOS shim is additive: a missing `_macos-sqlite.sh` would
  trip the `source` line in `scripts/o2b`. Pre-existing installs
  carry the new file via plugin update. Hosts where Bun never
  needed the shim (Linux, macOS without brew sqlite) see no
  behaviour change.
- §E.2 `recommendations` is an additive optional field on
  `IndexCheckReport`. Old JSON consumers that read by-key keep
  working; new ones can opt in.
- §E.3 `--cron-template` is a new flag on an existing verb; no
  existing flag changes shape.
- §E.4 SKILL is a new file under `skills/` — Hermes / Claude Code
  / Codex pick it up through the normal mirror flow (no manual
  registration needed).

## Risk and known-unknowns

- **Explorer layout quality on large vaults.** The Verlet mini-engine
  is tuned for ≤300 nodes. Larger vaults (~500+) may settle slowly
  or chaotically. Mitigation: the right panel surfaces a "consider
  filtering by topic" hint past a node-count threshold; the operator
  can also fall back to `o2b brain doctor` for the same information
  in list form. Trigger to revisit: an operator reporting unusable
  layout — at that point we either tune constants, swap in a smarter
  algorithm, or take D14.x out of deferred.
- **Force-merge of mismatched scope.** A user-friendly error message
  must spell out *why* the merge was refused; otherwise an operator
  may keep retrying with `--force` and miss that `--force` does not
  bypass invariants. The impl-plan should include a fixture test on
  the exact error wording.
- **Hook runtime detection on future Claude Code releases.** The
  detection relies on `transcript_path` substrings and the
  `session_id` / `cwd` / `tool_use_id` triple. Both have changed once
  in the project's history (the prefix on MCP tool names changed
  twice in two months — see comment in `hooks/lib/detect.ts`). The
  detector falls back to `unknown` cleanly when both signals miss,
  so the failure mode is "the cadence hint disappears", not "the
  hook crashes". Acceptable.
- **Static export size.** With ~200 preferences and a Verlet engine
  inline, the exported HTML lands around 200–300 KB. Acceptable for
  attaching to retros and Drive backups. If it ever creeps past 1 MB
  for a single vault, revisit (likely cause: long `principle` bodies;
  truncate for `tooltip`, keep full in panel).

## Out-of-scope

See *Non-goals (explicitly deferred)* above. These items are recorded
in `_summary.md → ## Deferred work` in the same commit to survive
across planning sessions.
