# v0.10.7 — Agent logging discipline tail (§30 §B + §D + §E)

Status: draft
Owners: TBD
Source:
- `Projects/OpenSecondBrain/Features/_summary.md` §30 — Agent logging
  discipline (open work).
- `Projects/OpenSecondBrain/Plan/3. Agent logging discipline.md` §B,
  §D, §E.

## Context

`§30 §A` (broaden stop guardrail) and `§30 §C` (SKILL reformulation)
shipped in v0.10.6. The three remaining tracks (`§B`, `§D`, `§E`) are
the writable side of the same discipline problem: removing barriers
to logging, observing whether logging happens, and bridging the
parallel runtime memory layer (Claude Code MEMORY) into Brain so
`brain_apply_evidence` can find the rule it was about to record
against.

The three tracks are independent in surface (MCP server config, cron
script, CLI verb) and share no code. They ship together because they
close one named feature in `_summary.md` and because pacing them out
across three releases would each spend the same amount of changelog,
release, and review attention on a smaller delta.

## Goals

- **G1 — §B writer MCP split.** Expose `brain_feedback` and
  `brain_apply_evidence` as an always-loaded MCP surface so that a
  Claude Code agent does not pay the ToolSearch round-trip before
  recording a taste signal or evidence event. The remaining 15 OSB
  MCP tools stay deferred — their context cost is not warranted on
  every session boot.
- **G2 — §D daily discipline report.** Land a deterministic
  Hermes-cron job that, once per day, compares brain-event counts per
  agent (read from `Brain/log/<date>.md`) against a runtime-agnostic
  activity proxy (git activity over watched repos + `find -newer` over
  watched non-repo paths + vault delta). Telegram-deliver a status
  block with `ok | info | alert`. No LLM in the report path.
- **G3 — §E claude-memory bridge.** Add `o2b brain
  import-claude-memory [--dry-run] [--apply] [--yes] [--json]
  [--memory <path>] [--vault <path>]` that imports `metadata.type:
  feedback` entries from a Claude Code memory directory directly into
  `Brain/preferences/` as `status: confirmed`, with sidecar-tracked
  idempotency.

## Non-goals (explicitly deferred)

Each entry below is recorded in `_summary.md → ## Deferred work` or
in the respective Plan/ doc in the same commit so it survives across
planning sessions.

- **Per-tool always-load in Claude Code.** Claude Code's tool-search
  threshold is per-server, not per-tool (changelog 2.1.121:
  `alwaysLoad` is a `.mcp.json` server flag). Per-tool pinning, if it
  ever lands, would let us drop the writer-server split. Trigger:
  `alwaysLoad` per-tool appears in Claude Code changelog.
- **Bidirectional MEMORY ↔ Brain sync.** Out of scope for v0.10.7.
  Current direction (MEMORY → Brain) closes the `apply_evidence
  misses` symptom. The reverse direction (Brain rule written through
  `brain_feedback` should reach Claude Code MEMORY so it survives
  cross-runtime) would invert the "dream is the only mutating writer
  of `Brain/`" invariant — and writing into `~/.claude/projects/.../
  memory/` from outside Claude Code is risky. Trigger: explicit user
  request, or a second example of a Brain-only rule that did not
  reach a Claude Code session that needed it.
- **§D non-bash-runtime activity sources.** Extending the activity
  proxy to Cursor / Aider / opencode session files would tie the
  report to runtime-specific transcript paths. The current proxy is
  runtime-agnostic on purpose. Trigger: §4 second half installer
  ships, runtime detection moves into a shared library.
- **§D non-binary thresholds.** Status is `alert | info | ok` based on
  the binary `total_brain_events == 0 AND activity > 0`. Numeric
  thresholds (e.g. "less than 1 brain event per 10 commits") would
  introduce noise without a baseline. Trigger: real
  false-positive/false-negative pairs from operating the report.
- **§E import of `user` / `project` / `reference` MEMORY entries.**
  Only `metadata.type: feedback` is mapped. The other three are not
  taste rules. Trigger: a real case where a `project`-typed memory
  shaped agent behavior in a way `brain_apply_evidence` should have
  recorded.
- **§E MCP wrapper.** `import-claude-memory` stays CLI-only by
  design doc §9.1 ("absence from MCP protects against autonomous
  mistakes") — same posture as `init`, `reject`, `pin`, `rollback`,
  `upgrade`.

## §B — Writer MCP server (always-loaded)

### Mechanism (what Claude Code actually supports)

- Claude Code 2.1.121 added `alwaysLoad: true` as a `.mcp.json`
  per-server flag. When set, the server's full tool surface skips
  tool-search deferral.
- There is no per-tool pin (verified against changelog and config
  schema as of 2026-05-18). Without splitting, the only options are
  "all OSB tools always loaded" (≈17 schemas in every session — too
  expensive) or "all deferred" (status quo).
- Splitting OSB into two MCP-server entries with the same backing
  binary but different `--scope` flags lets us keep the existing
  large surface deferred while pinning the two writer tools.

### `.mcp.json`

Both entries point to the same `${CLAUDE_PLUGIN_ROOT}/scripts/o2b`
binary; the second one adds `--scope writer` and `alwaysLoad: true`:

```json
{
  "mcpServers": {
    "open-second-brain": {
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
      "args": ["mcp"]
    },
    "open-second-brain-writer": {
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/o2b",
      "args": ["mcp", "--scope", "writer"],
      "alwaysLoad": true
    }
  }
}
```

`/srv/projects/open-second-brain/.mcp.json` and the plugin-cache
mirror (`/root/.claude/plugins/cache/open-second-brain/.../.mcp.json`)
both ship the same content.

### `src/mcp/tools.ts`

`buildToolTable()` gains an optional `scope` parameter:

```ts
export type ToolScope = "full" | "writer";

export function buildToolTable(scope: ToolScope = "full"): ToolDefinition[] {
  const all = [/* current array, unchanged */];
  if (scope === "full") return all;
  const writerAllow = new Set(["brain_feedback", "brain_apply_evidence"]);
  return all.filter((t) => writerAllow.has(t.name));
}
```

Filtering after the existing list — not a separate writer-only
table — keeps tool schemas defined exactly once. Adding a new
brain-event tool that should also be always-loaded becomes a
one-line set extension.

### `src/cli/main.ts`

Add `--scope writer|full` (default `full`) to the `mcp` subcommand.
The parsed value is forwarded into `serveStdio({ scope })`. Invalid
values exit 2 with `unknown --scope: <value>; expected one of: full,
writer`.

### `src/mcp/stdio.ts` and `src/mcp/server.ts`

- `MCPServer` constructor takes an optional `serverName` override.
  Default stays `"open-second-brain"`. Writer mode passes
  `"open-second-brain-writer"` so the MCP handshake matches the
  `.mcp.json` key (Claude Code uses the server name for tool-id
  decoration).
- `serveStdio({ scope, serverName })`: `scope` selects the tool
  table; `serverName` flows into the `initialize` response.

### `src/mcp/instructions.ts`

A separate short instructions string for writer mode. Wording (final
phrasing during impl):

> Open Second Brain — writer surface. Two tools:
>
> - `brain_feedback` — record one new taste signal the user just
>   expressed.
> - `brain_apply_evidence` — record `applied | violated | outdated`
>   against an active preference for an artifact this turn produced.
>
> The full Brain surface (`brain_dream`, `brain_digest`,
> `brain_query`, `brain_doctor`, `brain_backlinks`, `brain_search`,
> Pay Memory tools) lives on the sibling `open-second-brain` MCP
> server (deferred). Use that one through ToolSearch when needed.

Full-server instructions are unchanged; an addendum line points to
the writer server for `feedback` / `apply_evidence`.

### Duplicate-tool note

Both servers expose `brain_feedback` and `brain_apply_evidence`. The
agent sees two entries:
`mcp__plugin_open-second-brain_open-second-brain-writer__brain_feedback`
(always loaded) and
`mcp__plugin_open-second-brain_open-second-brain__brain_feedback`
(deferred — same handler). Backing handler is identical, so either
call writes the same Brain artifact. The instructions text in writer
mode explicitly tells the agent to prefer the writer-server tool.
We do not attempt to dedupe at the server level — Claude Code's
tool-id namespacing is by server.

### Tests (`tests/mcp/`)

- `scope-filter.test.ts` — `buildToolTable("writer")` returns exactly
  `["brain_feedback", "brain_apply_evidence"]`. `buildToolTable("full")`
  contains all current tools plus those two. Schemas are object-equal
  to the entries in the full table (no drift).
- `writer-server.test.ts` — spawn `o2b mcp --scope writer`, send
  JSON-RPC `initialize` then `tools/list`. Assert exactly two tools,
  matching names and schemas. Assert handshake `serverInfo.name` is
  `open-second-brain-writer`.
- `cli/mcp-scope-arg.test.ts` — `o2b mcp --scope nope` exits 2 with
  a message naming the valid values. `o2b mcp --scope` (missing
  value) exits 2.

## §D — Daily discipline report

### Mechanism

A pure bun script (no LLM) runs once a day from a Hermes cron job,
reads three deterministic sources, prints a Telegram-safe Markdown
block to stdout. Hermes' cron delivery writes that block into the
configured Telegram topic with `cron.wrap_response: false`.

### Entry point

- New script `bin/o2b-discipline-report` (executable, bun shebang).
  Argument: `--config-path` defaults to `~/.osb/config.yaml` via the
  existing `discoverConfig`. Output: plain text (Telegram
  MarkdownV2 escaped) to stdout. Exit code: 0 on `ok`/`info`, 0 on
  `alert` too (cron should still post the message; the human reads
  the status line).

The report code lives in `src/core/discipline/report.ts`. The
bin/-level script imports it. The CLI also exposes a verb for ad-hoc
local runs and for installer scripts: `o2b discipline report
[--yesterday | --date YYYY-MM-DD]`. Same code path as the cron-bin,
different entrypoint.

### Sources

**Source 1 — brain-events per agent.** Read
`Brain/log/<yesterday-in-config-tz>.md`. Parse the existing structure
defined in `src/core/brain/log.ts`:

```text
## HH:MM:SSZ — <kind>
- ...
- agent: <name>
- ...
```

For each block:
- Skip if no `agent:` field.
- Count by `(agent_name, kind_bucket)` where
  - `feedback` → bucket `feedback`,
  - `apply-evidence` → bucket `apply_evidence`,
  - everything else (`dream-pass`, `snapshot`, `merge`, `import-*`,
    `upgrade`, ...) → bucket `other`.

Emit a per-agent total. Keep agents whose names appear in
`discipline_report.known_agents` even when their count is zero
(explicit zero is informative); list unknown agent names below the
known block.

**Source 2 — repo activity (watched_paths with `.git`).** For each
configured watched path that contains a `.git/` directory:

```bash
git -C <path> log --since=<24h ago in tz> --until=<midnight in tz> \
    --no-merges --shortstat --pretty=tformat:%H
```

Aggregate: commits count, files changed, insertions, deletions.

**Source 3 — non-repo activity.** For each watched path without
`.git/`: count files whose mtime falls in the `[yesterday 00:00,
today 00:00)` interval in vault tz. Exclude common noise: `.cache`,
`node_modules`, `.git`, `.snapshots`, `*.lock`, dotfiles named
`.tmp-*`. Exclusion list is hardcoded inside `report.ts` (no config
knob — knob = future bug).

**Source 4 — vault delta.** Always-included extra source:
`Brain/inbox/` mtime in window (`new_signals`),
`Brain/preferences/` mtime in window (`new_preferences`),
`Brain/retired/` mtime in window (`new_retired`). Sourced from the
vault directly, not from log parsing — catches signals that landed
through `@osb` inline scan rather than through the live agent path.

### Status decision (binary)

```text
activity_signal = repo_activity_commits > 0
               OR non_repo_modified_files >= 3
               OR vault_delta_total > 0

total_brain_events = sum of feedback+apply_evidence+other across all agents

status =
  "alert" if total_brain_events == 0 AND activity_signal == true
  "info"  if total_brain_events == 0 AND activity_signal == false
  "ok"    otherwise
```

This intentionally avoids ratio thresholds. The two real shapes we
want to catch are "a quiet day" (info, no action needed) and "a busy
day with zero brain logging" (alert, guardrail likely bypassed).
Everything else is `ok`.

### Output (Telegram MarkdownV2)

```text
🧠 OSB discipline — <YYYY-MM-DD> (<tz_name>)

Status: <ok | info | alert>

Brain events:
- @claude-vps-agent: 2 feedback, 3 apply-evidence, 0 other (total 5)
- @codex-vps-agent: 0 feedback, 0 apply-evidence, 0 other (total 0)
<plus any unknown-name agents that appeared in the log>

Activity:
- /srv/projects/open-second-brain — 4 commits, 27 files, +312/-148
- /root/.hermes/plugins — 6 modified files
- vault — 3 new signals, 1 new preference, 0 retired

<if status == "alert">
[one-line explanation: e.g. "Activity present; zero brain events
recorded. Stop guardrail likely bypassed or hook regressed."]
```

MarkdownV2-safe escaping: dots, dashes, parentheses, underscores all
escaped per Telegram's rules. The escape function lives in
`src/core/discipline/telegram.ts`; reused if a future report needs it.

### Config

A new section under the existing `Brain/_brain.yaml` policy file:

```yaml
discipline_report:
  enabled: true
  timezone: "Europe/Belgrade"
  watched_paths:
    - "/srv/projects/open-second-brain"
    - "/root/.hermes/plugins"
    - "/root/.hermes/bin/agents"
  known_agents:
    - "@claude-vps-agent"
    - "@codex-vps-agent"
```

`enabled: false` (or missing section) → CLI prints
`discipline_report disabled` to stderr and exits 0. The cron job
delivers nothing in that case (`cron.wrap_response: false` + empty
stdout = empty Telegram message; we explicitly trim and bail before
that point).

### Hermes cron install

`o2b discipline install [--telegram-target <topic>] [--at <cron>]`
creates a single job in `/root/.hermes/cron/jobs.json` via the
existing `hermes cron create` CLI. Job shape:

```json
{
  "id": "osb-discipline-report-<vault-hash>",
  "name": "osb-discipline-report",
  "script": "/srv/projects/open-second-brain/bin/o2b-discipline-report",
  "no_agent": true,
  "schedule": { "kind": "cron", "expr": "59 4 * * *" },
  "deliver": "telegram:-1003895040510:216",
  "enabled": true
}
```

`vault-hash` is `sha256(vault_path).slice(0, 12)` so two vaults on
the same host get distinct job ids.

Defaults:
- `--at` defaults to `59 4 * * *` (UTC), one minute before
  `nightly-system-report` runs at 05:00 UTC; keeps the two reports
  visually adjacent without sharing a startup tick.
- `--telegram-target` defaults to the same topic as
  `nightly-system-report` (216).

`o2b discipline uninstall` removes the job. Idempotent on both ends.

### Tests (`tests/discipline/`)

- `parse-brain-log.test.ts` — fixture log file with three agents
  (one known, one known-but-zero, one unknown) → expected per-agent
  buckets.
- `repo-activity.test.ts` — temp git repo with 3 commits in the
  window and 1 commit out of window. Asserts `commits == 3`,
  `files` / `insertions` / `deletions` summed only from the in-window
  set.
- `non-repo-activity.test.ts` — temp dir with mtime-marked files in
  and out of window, plus excluded paths (`node_modules`, `.cache`).
  Asserts excluded paths are not counted.
- `decision.test.ts` — truth-table over status (4 combinations).
- `render.test.ts` — golden output for `ok`, `info`, `alert`, with
  MarkdownV2 escaping verified.
- `install-cron.test.ts` — install creates exactly one job by id;
  reinstall is a no-op; uninstall removes it.

## §E — `o2b brain import-claude-memory`

### CLI

```text
o2b brain import-claude-memory
    [--memory <path>]     default: ~/.claude/projects/<vault-slug>/memory
    [--vault  <path>]     default: from config
    [--dry-run]           plan only
    [--apply]             write (creates snapshot first)
    [--yes]               skip --apply confirmation in non-interactive
    [--json]              machine-readable output
```

- `--dry-run` and `--apply` are mutually exclusive; without either,
  defaults to `--dry-run`. Consistent with `o2b brain upgrade`
  semantics shipped in v0.10.6.
- `--memory` resolves the directory; `vault-slug` derivation: take
  the absolute vault path, replace `/` with `-`, prefix `-`. Match
  Claude Code's own slug rule. Fails fast if the directory does not
  exist with a hint pointing at `--memory <path>`.

### Mapping

For each `.md` in `<memory>/` (skip `MEMORY.md`):

```yaml
# 1. Frontmatter is required, with at least `name` and
#    `metadata.type`. Missing fields skip the file with a warning.

# 2. metadata.type == "feedback":
id:                pref-<slug(name)>
kind:              brain-preference
status:            confirmed
pinned:            false
scope:             writing                  # default; override via body marker
topic:             <slug derived from name>
principle:         <description>            # required from MEMORY frontmatter
confidence:        high
created_at:        <import iso>
_confirmed_at:     <import iso>
_force_confirmed_via: claude-memory
_imported_from:    "<memory-path>/<file>.md"
_imported_sha256:  <sha256 of source body>
_imported_at:      <import iso>
_applied_count:    0
_violated_count:   0
_evidenced_by:     []
_last_evidence_at: null
unconfirmed_until: <import iso>             # equals _confirmed_at: already confirmed

# 3. metadata.type in {"user", "project", "reference"}:
#    skipped with stderr line:
#    "skipped <file>: metadata.type=<X>; only `feedback` maps to Brain"

# 4. metadata.type missing or unknown:
#    skipped with stderr line:
#    "skipped <file>: missing or unknown metadata.type"
```

Body of the Brain preference: MEMORY body verbatim (the `**Why:**` /
`**How to apply:**` blocks are already in the shape Brain rules use).
At the bottom of the body, append:

```markdown
## Origin

Imported from Claude Code MEMORY:
`<memory-path>/<file>.md`
on <YYYY-MM-DD>.
```

`scope` extraction: scan MEMORY body for `scope:\s*<word>` on a line
by itself. If found, use it. Else default `writing`. The default is
deliberate (most feedback memories in the current repo are about
prose/style); we do not guess scope from text content.

### Idempotency

`<vault>/Brain/.imports/claude-memory.json`:

```json
{
  "version": 1,
  "imports": {
    "<basename>.md": {
      "pref_id": "pref-<slug>",
      "sha256": "<of source body>",
      "imported_at": "<ISO Z>"
    }
  }
}
```

Decision table (applied per memory file):

| In manifest? | sha256 match? | Brain pref exists? | Plan          |
|--------------|---------------|--------------------|---------------|
| no           | n/a           | no                 | CREATE        |
| no           | n/a           | yes                | CONFLICT      |
| yes          | yes           | yes                | SKIP_UNCHANGED |
| yes          | yes           | no                 | RECREATE (manifest stale) |
| yes          | no            | yes                | UPDATE        |
| yes          | no            | no                 | CREATE (manifest stale) |

`UPDATE` overwrites `principle` and body verbatim; it does NOT touch
`_applied_count`, `_violated_count`, `_evidenced_by`,
`_last_evidence_at`, `_confirmed_at`, `unconfirmed_until`, `pinned`,
or `scope`. Evidence collected over the lifetime of the preference
is preserved.

`CONFLICT` produces a clear stderr line and exits the run with the
file unprocessed:

```text
conflict: preference pref-no-em-dashes already exists in Brain but
is not registered in Brain/.imports/claude-memory.json. Resolve by:
  - rename the MEMORY entry (so a fresh pref-id is created), or
  - delete or rename Brain/preferences/pref-no-em-dashes.md, or
  - manually add the entry to Brain/.imports/claude-memory.json.
```

The run still processes the remaining files; final exit code is 0
only if every file is `CREATE | UPDATE | RECREATE | SKIP_UNCHANGED`.
Any `CONFLICT` ⇒ exit 2.

### Pre-apply snapshot

`--apply` calls the shared `createSnapshot({ runIdPrefix:
"import-claude-memory" })` from `src/core/brain/snapshot.ts` before
the first preference write. Rollback works via the same
`o2b brain rollback <run-id>` path as `upgrade`/`merge`. Failure to
write the snapshot aborts with `--force-apply` as the explicit
override; `--force-apply` follows the same posture as `upgrade`'s
`--force-rollback`.

### Brain log event

After a successful `--apply`, append one block to
`Brain/log/<today>.md` via `appendLogEvent`:

```text
## HH:MM:SSZ — import-claude-memory
- created: N
- updated: M
- recreated: R
- skipped_unchanged: K
- skipped_non_feedback: L
- conflicts: C
- snapshot: import-claude-memory-<ts>
- agent: <resolved>
```

New `BRAIN_LOG_EVENT_KIND.importClaudeMemory = "import-claude-memory"`
in `src/core/brain/types.ts`. Same shape as the existing
`import-session` event kind.

### Path safety

The default `--memory` resolves under `~/.claude/projects/`. If the
user passes a `--memory` outside that prefix:

```text
refusing to import from <path>: it is not under ~/.claude/projects/.
Pass --allow-arbitrary-memory-path to override.
```

`--allow-arbitrary-memory-path` exists for the edge case where a
secondary Claude Code install lives under a non-default home; we do
not default it on, because mis-passing a system directory should not
populate Brain.

### Tests (`tests/brain/`)

- `import-memory-mapping.test.ts` — feedback MEMORY file → expected
  preference frontmatter + body + `## Origin` block.
- `import-memory-filter.test.ts` — `user`/`project`/`reference`
  entries skipped with the expected stderr line; `MEMORY.md` always
  skipped.
- `import-memory-idempotency.test.ts` — second `--apply` with no
  changes performs zero writes; sha256 mismatch triggers UPDATE;
  manifest reflects all three states (`CREATE` → `SKIP_UNCHANGED` →
  `UPDATE`).
- `import-memory-conflict.test.ts` — preference exists without
  manifest entry → CONFLICT, exit 2, other files still processed.
- `import-memory-snapshot.test.ts` — `--apply` creates the snapshot,
  `rollback` restores the original Brain.
- `import-memory-path-safety.test.ts` — `--memory /etc/passwd`
  refuses without the override flag; with the override flag and a
  valid markdown corpus, succeeds.
- `import-memory-update-preserves-evidence.test.ts` — UPDATE keeps
  `_applied_count`/`_violated_count`/`_evidenced_by` intact.

## Cross-track decisions

### Versioning

Single v0.10.7. Updated in `package.json`, `openclaw.plugin.json`,
`plugin.yaml`. New `CHANGELOG.md` section under `## [0.10.7] -
<date>` with one Added/Changed split. No `[Unreleased]` section
carried over.

### Back-compat

- `.mcp.json` shipped with two server entries; client installs that
  predate `alwaysLoad` keep `open-second-brain-writer` deferred too
  (silent no-op behavioral change), which still works because the
  writer-mode server exposes the same tool names and the existing
  registration logic handles the dupe.
- `Brain/_brain.yaml` without `discipline_report` — feature is
  disabled; `bin/o2b-discipline-report` exits 0 without writing.
- `Brain/.imports/` absent — created on first `--apply`.
- Hermes cron job is created only by `o2b discipline install`; the
  v0.10.7 upgrade path does NOT auto-install it (user-initiated
  surface; documented in CHANGELOG and README).

### Where the deferred entries land

`_summary.md → ## Deferred work` gets four new lines (one each for
`per-tool always-load`, `bidirectional MEMORY ↔ Brain sync`,
`non-bash-runtime activity sources for §D`, `non-binary thresholds
for §D`). Each line names the trigger that would bring it back to
active planning.

`Plan/3. Agent logging discipline.md` status: `shipped`. §B / §D /
§E sections move from `open:` to `shipped:`. The "Триггер на
возврат" section is dropped — §30 is closed.

`Plan/2. Improvement.md` and `Plan/4. v0.10.5 review followups.md`
are untouched.

### Principles audit

- SOLID — each track owns one file family (`src/mcp/`,
  `src/core/discipline/`, `src/core/brain/import-claude-memory.ts`).
  Shared infra (`createSnapshot`, `appendLogEvent`,
  `BRAIN_LOG_EVENT_KIND`) is consumed, not duplicated.
- KISS — §D is a script, not an LLM; §E is one verb, not a
  bidirectional sync engine; §B is a config flag plus a filter.
- DRY — `brain_feedback` / `brain_apply_evidence` schemas defined
  once in `BRAIN_TOOLS`; writer-server filters by name; instructions
  string is a new constant in `instructions.ts`, not a fork of the
  full one.
- No active git — every track operates on local FS only.
- Honest fallbacks — `scope: writing` default in §E is explicit, not
  hidden inference. `discipline_report disabled` path in §D logs to
  stderr instead of silently producing an empty report.
