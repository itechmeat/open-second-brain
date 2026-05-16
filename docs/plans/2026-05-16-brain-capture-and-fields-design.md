# Brain — Capture Extensions and Derived-field Convention

Status: design
Target: Open Second Brain v0.10.2
Authors: Sergey Eroshenkov (product), Claude (drafting)

## 1. Overview

The v0.10 line shipped the deterministic core of the Brain layer — capture
(`brain_feedback`), accretion (`dream`), evidence (`brain_apply_evidence`),
search (`brain_search`), and v0.10.1 hygiene (`reject --reason`, recent-evidence
sections, body migration). Capture in v0.10 has one shape: a live MCP / CLI
call at the moment the rule is formulated. Every other surface — a rule jotted
into a Daily note, a rule stated in an offline session whose transcript only
exists on disk, a rule the agent missed in a busy conversation — is invisible
to Brain.

This document specifies three additions that close the capture gap and clean
up an unrelated frontmatter readability issue:

- **§9 inline `@osb` markers** — deterministic, no-LLM parser for `@osb`
  markers found anywhere in the vault. Each marker becomes a signal in
  `Brain/inbox/` through the same writer as `brain_feedback`.
- **§16 session-import** — `o2b brain import-session <path>` with an
  adapter registry for Claude Code, Codex CLI, and Hermes session JSONL
  files. Signals are extracted via two paths: `@osb` markers embedded
  in message text (reuses §9 parser) and replay of `brain_feedback`
  tool-use calls recorded in the transcript.
- **§24 `_field` prefix convention** — derived (dream-rewritten)
  fields on `pref-*.md` and `ret-*.md` frontmatter receive a `_`
  prefix (`_status`, `_applied_count`, …). Parser accepts both shapes
  for one minor; writer always emits the new shape. Migration helper
  `o2b brain migrate-frontmatter` available for users who want
  immediate, snapshotted migration instead of lazy dream-driven
  rewrites.

This plan covers Tier-A items §9, §16, and §24 from
`Projects/OpenSecondBrain/Features/_summary` (the vault-side product
brief).

## 2. Scope

In scope:

- New CLI verbs: `o2b brain scan-inline`, `o2b brain import-session`,
  `o2b brain migrate-frontmatter`. Each is intentionally CLI-only (no
  MCP mirror) — they are operator surfaces, not agent loops.
- New module `src/core/brain/inline.ts` shared by §9 and §16
  (single source of truth for the `@osb` marker grammar).
- New module tree `src/core/brain/sessions/` with adapter registry
  and three concrete adapters (`claude.ts`, `codex.ts`, `hermes.ts`).
- New module `src/core/brain/migrate-frontmatter.ts`.
- Extension of `BrainSignal` frontmatter with three optional fields:
  `source_type`, `dedup_hash`, `session_ref`. Default-shape on read
  is `live` to keep existing files identical.
- Extension of `BrainPreference` / `BrainRetired` parser to accept
  both legacy (`status:`) and `_`-prefixed (`_status:`) forms; writer
  emits only the new form.
- Doctor gets one new warning `frontmatter-double-shape` for a
  preference / retired file that has both shapes for the same field
  (manual-edit corruption signal).
- Three new log-event kinds: `scan-inline`, `import-session`,
  `migrate-frontmatter`.
- New optional `_brain.yaml` key `scan_inline.exclude: [...]`.

Out of scope:

- LLM-based or heuristic-phrase extraction of preference signals from
  session text (deferred to BRAIN-FUT-003; needs real observation
  data before tuning).
- MCP tools for `scan-inline` / `import-session` / `migrate-frontmatter`
  (operator commands, not agent loop; consistent with `init`, `reject`,
  `pin`, `unpin`, `rollback`, never exposed via MCP).
- Long-running watcher / daemon over `Brain/inbox/` or vault files
  (violates the "no daemon" invariant).
- Hard removal of the legacy frontmatter shape — planned for v0.12.0.
- Cross-vault dedup / external attribution beyond `session_ref`.
- Mutating writes inside session files (read-only by design — these
  files are runtime logs owned by Claude / Codex / Hermes).

## 3. Architectural Principles

1. **No LLM in core.** Both new capture paths are deterministic. The
   marker parser is a rule-based tokenizer; the session importer
   only extracts what is already marked or recorded by the agent.
2. **Filesystem-first.** Dedup state for `scan-inline` and
   `import-session` lives in the signal frontmatter (`dedup_hash`,
   `session_ref`), not in a sidecar ledger. The whole `Brain/` tree
   remains the source of truth.
3. **Single mutating writer is preserved.** Every signal — live,
   inline, or imported — goes through `writeSignal` in
   `src/core/brain/signal.ts`. The dream pass stays the only mutator
   of `preferences/` and `retired/`. Inline rewrite only touches
   user-authored markdown outside `Brain/`.
4. **Idempotency.** Re-running `scan-inline` on an unchanged vault
   creates no signals and no file rewrites. Re-running
   `import-session` on the same file creates no signals.
5. **Snapshot before destructive operator commands.**
   `migrate-frontmatter --apply` takes a pre-run snapshot through the
   existing `Brain/.snapshots/` infrastructure; rollback works
   identically to `dream`.
6. **CLI-only for operator commands.** The three new verbs are not
   exposed to MCP. Consistent with how `init`, `reject`, `pin`,
   `unpin`, `rollback` are kept off the agent loop.
7. **Read/write asymmetry on session files.** Session files belong
   to upstream runtimes (Claude, Codex, Hermes). We read them; we
   never write back.

## 4. Module Layout

```
src/core/brain/
  inline.ts                  # @osb marker parser (inline + fenced block)
  inline-rewrite.ts          # atomic in-place mark-as-processed
  inline-scan.ts             # vault walker that orchestrates inline.ts
  sessions/
    types.ts                 # SessionAdapter, SessionTurn, SessionToolCall
    registry.ts              # adapter registry + autodetect
    claude.ts                # Claude Code .jsonl adapter
    codex.ts                 # Codex CLI .jsonl adapter
    hermes.ts                # Hermes .jsonl adapter
    import.ts                # orchestrator: iterate → extract → writeSignal
  migrate-frontmatter.ts     # opt-in rewriter for legacy frontmatter shape
src/cli/
  brain.ts                   # +3 cmdBrain handlers, +3 entries in VERB_HELP
src/core/brain/
  signal.ts                  # accepts new optional fields + tag extension
  preference.ts              # parser accepts both shapes; writer emits new
  doctor.ts                  # +1 lint: frontmatter-double-shape
  types.ts                   # +BrainSignalSourceType, +new log event kinds
  log.ts                     # +helpers for the three new event kinds
tests/core/
  brain.inline.test.ts
  brain.inline-rewrite.test.ts
  brain.inline-scan.test.ts
  brain.sessions.claude.test.ts
  brain.sessions.codex.test.ts
  brain.sessions.hermes.test.ts
  brain.sessions.import.test.ts
  brain.migrate-frontmatter.test.ts
tests/cli/
  brain.test.ts              # extended with 3 new verb sections
tests/fixtures/sessions/
  claude-minimal.jsonl
  codex-minimal.jsonl
  hermes-minimal.jsonl
```

Dependency graph (top-down):

```
inline-scan.ts ───┬─► inline.ts ─────────────┐
                  │                          │
sessions/import ──┤                          │
                  └─► sessions/registry ─►   │
                       sessions/{claude,     │
                       codex, hermes}.ts ───►│
                                             ▼
                                       writeSignal (signal.ts)
                                             ▲
inline-rewrite.ts ──► fs-atomic + proper-lockfile
migrate-frontmatter ──► preference.ts + snapshot.ts
```

External dependencies introduced: zero. `proper-lockfile` already in
`package.json` is reused for the in-file rewrite path.

## 5. §9 — Inline `@osb` Markers

### 5.1 Marker format

Two syntaxes are accepted. The parser tries the block form first; if
the current line does not open a block, the inline form is tried.

**Inline (single line):**

```
@osb <kind> <signal> key=value key2="quoted value with spaces"
```

Concrete example:

```
@osb feedback negative topic=mocking principle="don't mock DB in integration tests" scope=testing
```

**Fenced block (info-string `osb`):**

````
```osb
kind: feedback
signal: negative
topic: mocking
principle: don't mock DB in integration tests
scope: testing
note: |
  Long-form context that does not fit one line.
  Multiple paragraphs allowed.
```
````

The info-string is `osb`, not `@osb` — info-strings in CommonMark are
language identifiers; the `@` sigil is reserved for the inline shape
that lives outside fenced blocks.

### 5.2 Required and optional fields

Required:

- `kind` — always `feedback` for now. The enum exists so future
  versions can add `apply-evidence` without changing the surface.
- `signal` — `positive` or `negative`. Same enum as `BrainSignal`.
- `topic` — kebab-slug; validated through the existing `validateSlug`
  used by `writeSignal`.
- `principle` — single line in inline form, may be multi-line in block
  form. NFC-normalized before hashing (see §6.4).

Optional:

- `scope` — slug-adjacent tag, same shape as in `brain_feedback`.
- `agent` — overrides the default `resolveAgentName(config)` result.
- `note` — long-form context. Block form only.
- `source` — comma-separated wikilinks (inline form) or YAML list
  (block form). When absent, the parser still records a wikilink to
  the source file as a single-element `source` array (so the captured
  signal carries provenance even without an explicit value).

Inline parser is a small hand-written tokenizer (not a regex) so it
handles escaped quotes inside `"..."` correctly. Block-form payload
goes through the existing simple frontmatter YAML reader from
`src/core/vault.ts`.

### 5.3 Scan scope and ignore set

The walker traverses the vault from `<vault>/` and visits every `*.md`
file whose path does not match the ignore set. Default ignore set:

```
.git/                  # version control
node_modules/          # transitive
.open-second-brain/    # index / cache root
.obsidian/cache/       # Obsidian per-device state
.trash/                # Obsidian-trashed items
.stversions/           # Syncthing versioning
Brain/                 # the derived layer (signals, prefs, logs)
Brain/.snapshots/      # tar.zst archives
```

`Brain/` is mandatory in the ignore set: signal files include the
verbatim user text in `## Raw`, and recursive scanning would create
self-referential signals.

Additional excludes go to `_brain.yaml`:

```yaml
scan_inline:
  exclude:
    - "AI Wiki"        # example user-specific exclude
    - "Drafts/private" # example
```

Per-file size cap: 1 MiB. Files larger than the cap are skipped with
a `[WARN] file too large to scan` message in CLI output and the log
event. Non-UTF8 files are skipped silently (with the same warning).

### 5.4 Marker processing algorithm

For each scanned file, the walker produces a list of marker matches
top-down. Each match is processed in document order:

1. Parse the marker payload through `inline.ts:parseMarker(input)`.
   Malformed payload yields a `MalformedMarker` entry. In `--strict`
   mode, malformed markers raise the run exit code to 1; otherwise
   they are warnings.
2. Compute `dedup_hash` (see §8.4).
3. Consult the in-memory signal index (built once per run by
   scanning `Brain/inbox/` and `Brain/inbox/processed/` for the
   `dedup_hash` field) to decide whether the signal already exists.
4. If the signal already exists and the marker is not yet rewritten
   as `@osb✓` → perform only the in-file rewrite. Logged as
   `noted: already-captured`.
5. If the signal does not exist → `writeSignal(...)` with the
   payload, `source_type: 'inline'`, `dedup_hash: <hash>`, and the
   source-file wikilink in `source`. Then the in-file rewrite.

In-memory signal index format:

```ts
type DedupIndex = ReadonlyMap<
  string /* dedup_hash */,
  { id: string; path: string }
>;
```

Built lazily on first need per run; cost is one `readdir` plus one
frontmatter parse per signal — equivalent to what `dream` already
does on every pass.

### 5.5 In-file rewrite

**Inline:**

```
before: @osb feedback negative topic=mocking principle="..." scope=testing
after:  @osb✓ [[sig-2026-05-16-mocking]] feedback negative topic=mocking principle="..." scope=testing
```

**Block:** the info-string flips from `osb` to `osb-checked`, and the
first line of the block body is rewritten to embed the signal id as
an HTML comment (which markdown renderers will not interpret, since
the fence body is treated as literal text):

````
before:
```osb
kind: feedback
signal: negative
...
```

after:
```osb-checked
<!-- @osb✓ [[sig-2026-05-16-mocking]] -->
kind: feedback
signal: negative
...
```
````

Reasons:

- `[[sig-...]]` wikilink is picked up by the existing
  `buildBacklinkIndex` from v0.9.1, providing a free reverse link.
- `@osb✓` (or `osb-checked` info-string) is the parser's "already
  processed" sentinel — the next `scan-inline` run skips it.
- The original payload remains visible to the human; the marker is
  not "consumed", it is annotated.

Write protocol: lock the source file with `proper-lockfile.lock(path,
{retries: 3, factor: 2})`, read full contents, apply all marker
rewrites in order, write to `<path>.tmp-<pid>`, `fsync`, `rename` over
the original. Standard `fs-atomic.ts` pattern.

### 5.6 CLI

```
o2b brain scan-inline [--vault <path>] [--path <subdir>...]
                      [--dry-run] [--strict] [--json]
```

- `--path <subdir>` (repeatable): limit the walker to one or more
  vault-relative subdirectories. Used in CI / spot-checks.
- `--dry-run`: do not write signals, do not rewrite source files;
  emit the plan only.
- `--strict`: malformed markers raise exit code to 1.
- `--json`: structured report:

  ```json
  {
    "scanned": 142,
    "found": 4,
    "created": 3,
    "deduped": 1,
    "malformed": 0,
    "errors": [],
    "files_with_markers": [
      {"path": "Daily/2026-05-15.md", "markers": 2},
      {"path": "Projects/foo/notes.md", "markers": 2}
    ]
  }
  ```

Exit codes: `0` success, `1` error, `2` `--strict` with malformed
markers.

### 5.7 Log event

Appended to `Brain/log/<today>.md`:

```markdown
## 16:23:45Z — scan-inline
- run_id: scan-2026-05-16T16-23-45Z
- agent: claude-vps
- scanned: 142
- created: 3
- deduped: 1
- malformed: 0
```

The `run_id` follows the same `<verb>-<ISO-no-colons>` shape as
`dream` snapshots.

### 5.8 Edge cases

- **Marker inside another language's fence** (`\`\`\`python\n@osb …\n\`\`\``):
  the parser tracks fence context line-by-line. Markers inside a
  fence whose info-string is not `osb` are skipped. This prevents
  false-positives in technical documentation that shows OSB usage
  examples.
- **`@osb` in prose without recognized `kind`**: the inline parser
  requires the second token to be a known `kind`. `"@osb is great"`
  is not a marker; `"@osb feedback positive"` is.
- **Symlink loops**: the walker follows symlinks once (`find -L`
  semantics) and remembers visited inodes. Cycle protection prevents
  infinite loops.
- **Concurrent edit while scanning** (Obsidian / Syncthing): the
  per-file lock prevents partial writes; the atomic rename makes
  partial writes invisible to readers.
- **Duplicate markers within one file**: each occurrence is processed
  independently. Content-hash dedup ensures Brain receives one
  signal regardless.

## 6. §16 — Session-import

### 6.1 CLI

```
o2b brain import-session <path> [--vault <vault>]
                                [--format auto|claude|codex|hermes]
                                [--since <ISO>] [--dry-run] [--json]
```

- `<path>`: single `.jsonl` file or a directory. For a directory,
  the importer recurses and processes every `*.jsonl` file with its
  detected adapter.
- `--format`: force a specific adapter. Default is `auto`: the first
  line is read and run through `registry.detect()`. Failure to detect
  exits with code 2 and a message listing the adapters tried.
- `--since <ISO>`: process only turns with `timestamp >= since`. The
  dedup_hash already prevents duplicates on re-runs; this flag is
  for performance on large historical sessions.
- `--dry-run`: print the extraction plan, do not write signals.
- `--json`: structured report.

Exit codes: `0` success, `1` I/O or adapter error, `2` autodetect
failure with no `--format` given.

### 6.2 SessionAdapter interface

```ts
// src/core/brain/sessions/types.ts

export interface SessionTurn {
  /** Adapter-specific stable id (uuid / sequence number / synthetic). */
  readonly turnId: string;
  /** ISO-8601 UTC; synthesized when the format omits the field. */
  readonly timestamp: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'meta';
  /** Flat-text view of the turn's content blocks; undefined for meta. */
  readonly text?: string;
  /** Tool-use blocks emitted by the agent in this turn. */
  readonly toolCalls?: ReadonlyArray<SessionToolCall>;
}

export interface SessionToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Tool-use id for tool_result correlation. */
  readonly id?: string;
}

export interface SessionAdapter {
  readonly id: 'claude' | 'codex' | 'hermes';
  /** True iff the adapter recognises the file from its first line. */
  detect(firstLine: string): boolean;
  /** Async iterator of normalised turns from a single .jsonl file. */
  iterate(path: string): AsyncIterable<SessionTurn>;
}
```

Each adapter:

- Implements `detect()` on a single first-line read.
- Streams turns via `AsyncIterable` so we never hold a multi-megabyte
  session in memory.
- Normalises content blocks (`type: "text"`, `type: "tool_use"`,
  array-of-blocks vs. string) into the flat `SessionTurn` shape.

`registry.ts` exports:

```ts
export const SESSION_ADAPTERS: ReadonlyArray<SessionAdapter>;
export function detectAdapter(firstLine: string): SessionAdapter | null;
export function getAdapter(id: SessionAdapter['id']): SessionAdapter;
```

### 6.3 Adapter detect heuristics

Derived from inspecting actual session files on the running server:

- **Claude Code (`claude.ts`):** first line is JSON containing either
  `"type":"queue-operation"` or an object with `parentUuid`,
  `sessionId`, `entrypoint` (and usually `version`, `gitBranch`).
- **Codex CLI (`codex.ts`):** first line contains
  `"type":"session_meta"` plus `"originator":"codex_exec"` or
  `"cli_version"` field.
- **Hermes (`hermes.ts`):** first line is `"role":"session_meta"` and
  carries a `"tools"` array (distinguishes from Claude `meta` events
  that lack the array).

If `detectAdapter()` returns null, autodetect fails. We deliberately
do **not** add fuzzy text heuristics — a misdetected adapter would
silently mis-parse content and pollute Brain.

### 6.4 Signal extraction

For every `SessionTurn` from an adapter, the orchestrator runs two
independent extractors:

**Path A — markers in message text** (only when `turn.role` is
`user` or `assistant` and `turn.text` is non-empty):

```ts
const markers = parseMarkers(turn.text);
for (const m of markers) {
  yield { kind: 'marker', payload: m, sourceTurn: turn };
}
```

This is the same `parseMarkers` from `inline.ts`. Users / agents who
type `@osb feedback ...` in chat get their signals captured even if
no MCP call happened.

**Path B — replay `brain_feedback` tool-use** (when `turn.toolCalls`
contains an entry with `name === 'brain_feedback'`):

```ts
for (const call of turn.toolCalls ?? []) {
  if (call.name !== 'brain_feedback') continue;
  const validated = validateBrainFeedbackInput(call.input);
  if (validated.ok) {
    yield { kind: 'replay', payload: validated.value, sourceTurn: turn };
  } else {
    // emit MalformedToolCall warning
  }
}
```

`validateBrainFeedbackInput` mirrors the validation in
`src/mcp/brain-tools.ts:toolBrainFeedback` but as a pure function
returning `{ok, value} | {ok: false, reason}`. Reused, not
re-implemented.

Turns with `role: 'tool' | 'system' | 'meta'` are skipped — no
content-bearing payload there.

### 6.5 Writing the signal

For each extracted entry:

1. Compute `dedup_hash` over `(topic, signal, principle, scope)` —
   identical algorithm to §9 (see §8.4 below). Important: a marker
   captured by `scan-inline` and the same text replayed from a
   session yield the same hash, so they dedup against each other.
2. Check the dedup index. Hits log as `deduped` and continue.
3. Otherwise, `writeSignal(...)` with:
   - `source_type: 'session'`
   - `agent`:
     - Claude session → `agent: 'claude'` (or the explicit value
       carried in the tool_use input).
     - Codex session → `agent: 'codex'`.
     - Hermes session → `agent: hermes-<role>` where `<role>` comes
       from `session_meta` (e.g. `hermes-product-tech-lead`),
       fallback `hermes` if missing.
   - `source`: `['[[<vault-rel-or-abs-path>:<turn-id>]]']` using the
     existing artifact-range wikilink form (§17 of v0.9.1).
   - `session_ref`: `<path>#<turnId>` as a structured field for
     machine processing.
   - `dedup_hash`: the computed hash.

### 6.6 Immutability of source session files

We do not modify session files. Rationale:

- They are runtime logs owned by Claude / Codex / Hermes.
- Their format, ownership, and sync model are upstream concerns.
- Mutation introduces inconsistency with whatever process appends to
  them (Claude session writer, Hermes gateway, Codex exec).

Idempotency relies on `dedup_hash` (for markers) and `session_ref`
(for tool-use replays). On a re-run, the orchestrator builds an
in-memory `Set<string>` of existing `dedup_hash` plus `session_ref`
values from the inbox / processed directories and skips matches.

### 6.7 Log event

One log block per session file (multiple blocks when `<path>` was a
directory):

```markdown
## 18:42:13Z — import-session
- run_id: imp-2026-05-16T18-42-13Z
- agent: claude-vps
- file: [[~/.claude/projects/-root/abc123.jsonl]]
- format: claude
- turns_scanned: 412
- signals_created: 5
- signals_deduped: 2
- tool_replays: 1
- malformed: 0
```

### 6.8 Error handling

- **Non-JSONL line in a `.jsonl` file**: each line is parsed
  independently. Bad lines yield `{ line, reason }` entries in the
  report. The run exit code is 1 if any line fails.
- **Turn missing `timestamp`**: synthesized from the prior turn's
  timestamp or epoch-zero for sort purposes. The created signal
  uses the orchestrator's wall-clock `created_at`.
- **Malformed marker in message text**: warning, continue. `--strict`
  promotes to exit 1.
- **`brain_feedback` tool-use with invalid input** (e.g. missing
  `principle`): warning, continue.
- **Adapter detect fails for one file inside a directory walk**:
  warning, skip the file, continue with the next.

## 7. §24 — `_field` Prefix Convention

### 7.1 Field partition

Frontmatter fields on `pref-*.md` and `ret-*.md` split into three
groups.

**Group A — identity (no prefix, immutable after creation):**

```
kind, id, created_at, topic, principle, scope, agent, tags, aliases,
unconfirmed_until, supersedes, superseded_by,
retired_at, retired_reason, retired_by, user_rejected_reason
```

**Group B — user-editable (no prefix):**

```
pinned
```

**Group C — derived (gains `_` prefix, dream rewrites freely):**

```
_status            (was status)
_confirmed_at      (was confirmed_at)
_last_evidence_at  (was last_evidence_at)
_applied_count     (was applied_count)
_violated_count    (was violated_count)
_confidence        (was confidence)
_evidenced_by      (was evidenced_by)
_contradicted_by   (was contradicted_by; reserved for BRAIN-FUT-002)
```

Notes:

- `unconfirmed_until` is set once at write time and not modified by
  dream; identity, no prefix.
- `evidenced_by` starts at creation but dream extends it under
  `noted-redundant`; derived, gets `_`.
- `tags` is auto-composed by `composePreferenceTags`, but Obsidian
  tooling reads the literal `tags:` key. Pragmatic exception: no
  prefix. A code comment documents this.
- `pinned` is the only Group B field today. Reserved without prefix
  for forward-compatibility with future user-editable flags.

### 7.2 Backward-compat policy

The v0.10.x parser accepts both `name` and `_name` for every Group C
field. The writer always emits the `_`-prefixed form. v0.12.0 will
remove the legacy-read path (a separate document at release time).

Reader behaviour (pseudo-code):

```ts
function readDerivedField(meta, name, kind) {
  const legacy = name in meta;
  const modern = `_${name}` in meta;
  if (legacy && modern) {
    throw new Error(
      `both '_${name}' and legacy '${name}' present; pick one`,
    );
  }
  return modern ? meta[`_${name}`] : meta[name];
}
```

The simultaneous-presence case is a hard error: a half-migrated file
indicates a manual-edit conflict that needs human resolution. The
doctor surfaces this as a `frontmatter-double-shape` warning so it
shows up in the daily digest.

Writer behaviour: always emits `_status`, `_applied_count`, etc.
Existing legacy files are not rewritten on read; they migrate
lazily the next time `dream` rewrites them for a legitimate reason
(refresh evidence sections, status change, retire). Files that never
change after the upgrade stay in legacy form indefinitely — and they
keep parsing correctly through the dual-shape parser.

### 7.3 Explicit migration helper

For users who want immediate migration with a snapshot fallback:

```
o2b brain migrate-frontmatter [--vault <path>]
                              [--dry-run | --apply] [--yes] [--json]
```

- `--dry-run` (default): scan `preferences/` and `retired/`, list
  files with legacy-form keys, print a plan, exit 0.
- `--apply`: take a pre-run snapshot via `Brain/.snapshots/`, rewrite
  files atomically, log a `migrate-frontmatter` event, exit 0 on
  success. Requires `--yes` in non-interactive mode (parity with
  `o2b brain rollback`).
- `--json`: structured report.

Per-file algorithm under `--apply`:

1. `parseFrontmatter(path)` → `meta, body`.
2. If every Group C key is already in `_`-form → skip.
3. Otherwise, rename `name` → `_name` in `meta`. Body is untouched.
4. `formatFrontmatter(meta, body)` → `writeFrontmatterAtomic` with
   `overwrite: true`.
5. If both forms of the same field are present → abort the run with
   a clear error listing the offending file and instructing
   `o2b brain rollback migrate-...` to revert.

Log event:

```markdown
## 10:15:22Z — migrate-frontmatter
- run_id: migrate-2026-05-16T10-15-22Z
- agent: claude-vps
- snapshot: Brain/.snapshots/migrate-2026-05-16T10-15-22Z.tar.zst
- files_scanned: 47
- files_migrated: 39
- files_already_new: 8
- conflicts: 0
```

Rollback path is the standard one: `o2b brain rollback
migrate-2026-05-16T10-15-22Z`. No special code path.

### 7.4 Doctor extension

`runDoctor` adds one new warning code `frontmatter-double-shape`,
fired when a preference or retired file has both the legacy and the
prefixed form of the same Group C field. Severity: warning. Message
quotes the offending field name and suggests `o2b brain
migrate-frontmatter --apply` or hand-removal of the duplicate.

No "uses legacy form" warning is added — lazy migration through
dream natural rewrites makes the per-file noise more annoying than
useful.

## 8. Data Model Changes

### 8.1 BrainSignal — new optional fields

In `src/core/brain/types.ts`:

```ts
export const BRAIN_SIGNAL_SOURCE_TYPE = {
  /** Default for `brain_feedback` CLI / MCP calls. */
  live: 'live',
  /** Captured by `o2b brain scan-inline` from an @osb marker. */
  inline: 'inline',
  /** Replayed from a session file by `o2b brain import-session`. */
  session: 'session',
} as const;
export type BrainSignalSourceType =
  (typeof BRAIN_SIGNAL_SOURCE_TYPE)[keyof typeof BRAIN_SIGNAL_SOURCE_TYPE];

export interface BrainSignal {
  // existing fields...

  /**
   * Origin of the signal. Absent on read for legacy files; the
   * reader treats absence as 'live' but never injects a default into
   * the parsed object.
   */
  readonly source_type?: BrainSignalSourceType;

  /**
   * Normalised hash of (topic, signal, principle, scope). Anchor for
   * inline / session-import idempotency. Empty / absent for legacy
   * signals.
   */
  readonly dedup_hash?: string;

  /**
   * Source coordinates for session-imported signals:
   * `<path>#<turn-id>`. Empty for inline / live signals.
   */
  readonly session_ref?: string;
}
```

All three are optional on write and read. Absence is not coerced to a
default in the parsed object — downstream code distinguishes
`undefined` ("legacy file") from explicit `'live'`.

### 8.2 Tag extension

`composeSignalTags` in `signal.ts` gains one rule:

```ts
if (input.source_type && input.source_type !== 'live') {
  push(`brain/source/${input.source_type}`);  // 'inline' or 'session'
}
```

`live` does not get a tag — default is the absence of the marker.
Obsidian users can filter by `tag:brain/source/inline` and similar.

### 8.3 Migration matrix

| Artifact | Before this release | After (writer) | New parser | Future break |
|---|---|---|---|---|
| `sig-*.md` without `source_type` | exists | unchanged | trace as `live` | unchanged |
| `sig-*.md` from `scan-inline` | — | `source_type: inline`, `dedup_hash` | parse normally | unchanged |
| `sig-*.md` from `import-session` | — | `source_type: session`, `dedup_hash`, `session_ref` | parse normally | unchanged |
| `pref-*.md` legacy frontmatter | `status:` | dream lazily rewrites to `_status:` | accepts both | hard break: only `_status:` |
| `pref-*.md` new frontmatter | — | `_status:` | parse normally | parse normally |

No wave-rewrite at upgrade time. New writes use the new shape;
existing reads continue working.

### 8.4 `dedup_hash` algorithm

```ts
import * as crypto from 'node:crypto';

export function computeDedupHash(input: {
  topic: string;
  signal: 'positive' | 'negative';
  principle: string;
  scope?: string;
}): string {
  const parts = [
    input.topic.trim(),
    input.signal,
    input.principle.normalize('NFC').trim().replace(/\s+/g, ' '),
    (input.scope ?? '').trim(),
  ];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}
```

Normalisation rationale:

- NFC for `principle` so Mac / Linux / Windows-typed text yields the
  same hash.
- Collapse internal whitespace in `principle` so cosmetic reflow does
  not create a new signal.
- `scope` trim with empty-string default — `scope=undefined` and
  `scope=""` hash identically.
- `agent` is deliberately excluded — the same rule from two agents
  is still one rule.

A user fixing a typo in `principle` after the first scan changes the
hash. The next scan creates a new signal. This is the intended
behaviour: a fixed typo is a different statement of the rule.

### 8.5 Public surface summary

**New CLI verbs:**

```
o2b brain scan-inline             # §9
o2b brain import-session <path>   # §16
o2b brain migrate-frontmatter     # §24 (opt-in)
```

**New MCP tools:** none.

**New optional `_brain.yaml` keys:**

```yaml
scan_inline:
  exclude: []   # list of vault-relative paths
```

**New `BrainSignal` optional fields:**

```
source_type, dedup_hash, session_ref
```

**Updated `BrainPreference` / `BrainRetired` parse / write:**

- Parser reads both `name` and `_name` for Group C fields.
- Writer emits only `_name`.

**New log-event kinds (3):**

```
'scan-inline', 'import-session', 'migrate-frontmatter'
```

**New doctor lint:** `frontmatter-double-shape` (warning).

### 8.6 SOLID / KISS / DRY

- **SRP:** each module has one responsibility; orchestrators
  (`inline-scan.ts`, `sessions/import.ts`) only stitch.
- **OCP:** adapter-registry is open for extension — adding Cursor or
  another runtime is a new file plus a registry entry, no
  modification of existing adapters.
- **DIP:** CLI handlers depend on the `SessionAdapter` interface,
  not on concrete adapters.
- **KISS:** zero new external dependencies; one shared marker parser
  for §9 and §16; lazy migration for §24 instead of a wave-rewrite.
- **DRY:** `dedup_hash` is one algorithm shared by both new capture
  paths; in-file rewrite reuses `fs-atomic.ts` and `proper-lockfile`;
  migration reuses `snapshot.ts` and `rollback`.

## 9. Testing Strategy

### 9.1 Core unit tests

| File | Coverage |
|---|---|
| `tests/core/brain.inline.test.ts` | inline form positional + key=value + quoted; block form with YAML body; unknown `kind` → not a marker; escaped quotes; multi-marker per file; markers inside non-osb fences ignored; non-UTF8 input rejected |
| `tests/core/brain.inline-rewrite.test.ts` | inline → `@osb✓ [[sig-...]]`; block → `osb-checked`; repeat-run is no-op; lock contention surfaced; atomic on partial write |
| `tests/core/brain.inline-scan.test.ts` | ignore set respected; `--path` narrows scope; size cap; symlink loop protection; dedup against existing inbox files |
| `tests/core/brain.sessions.claude.test.ts` | detect matches own format only; iterate normalises tool_use blocks; missing fields synthesised |
| `tests/core/brain.sessions.codex.test.ts` | same as above for Codex schema |
| `tests/core/brain.sessions.hermes.test.ts` | same as above for Hermes schema, including the role-derived agent name |
| `tests/core/brain.sessions.import.test.ts` | dedup between marker and tool_use replay; dedup on re-run; directory walk with one unknown file; `--since` filter |
| `tests/core/brain.migrate-frontmatter.test.ts` | dry-run prints plan and writes nothing; apply takes snapshot + rewrites; idempotent; double-shape file aborts with clear error; rollback restores |
| `tests/core/brain.preference.test.ts` (extended) | parser accepts both shapes; both-shapes file throws; writer emits `_name` only |
| `tests/core/brain.doctor.test.ts` (extended) | `frontmatter-double-shape` warning surfaces |
| `tests/core/brain.signal.test.ts` (extended) | `writeSignal` writes new fields; tag composer adds `brain/source/<type>`; parser reads them back |

### 9.2 CLI integration tests

`tests/cli/brain.test.ts` gains three sections:

- `scan-inline` — `--help`, missing vault, `--dry-run`, `--json`,
  `--strict` exit code parity.
- `import-session` — `--help`, autodetect failure on a junk file,
  `--format` override, directory walk, `--dry-run`.
- `migrate-frontmatter` — `--help`, `--dry-run` by default, `--apply`
  refuses without `--yes` on non-TTY, snapshot creation observed.

### 9.3 E2E

One scenario in `tests/e2e/`:

1. `o2b brain init` on a tmp vault.
2. Create `Daily/2026-05-16.md` with a `@osb feedback` marker.
3. `o2b brain scan-inline` → assert signal in inbox + rewrite in file.
4. `o2b brain dream` → assert promote.
5. `o2b brain migrate-frontmatter --apply --yes` → assert `_status`
   in the resulting pref file.
6. `o2b brain rollback migrate-...` → assert legacy shape restored.

### 9.4 Fixtures

`tests/fixtures/sessions/` contains three anonymised minimal JSONL
files:

- `claude-minimal.jsonl` — 5-10 turns, one marker in user message,
  one `brain_feedback` tool_use in assistant turn.
- `codex-minimal.jsonl` — same coverage in Codex schema
  (`session_meta` + `response_item`).
- `hermes-minimal.jsonl` — same in Hermes schema (`session_meta` +
  `user` + `assistant`).

All ids are deterministic dummies; no real secrets, paths, or
content. Generated by hand once and frozen — tests assert exact
parsed shape against golden expectations.

## 10. Documentation Updates

- **README.md:** under `## CLI` Brain block, add three new verb
  lines. Under `## Brain (observing memory)`, add a short paragraph
  on capture surfaces (live / inline / session-import) after the
  MCP-tools paragraph.
- **`docs/how-it-works.md`:** new subsection "Capture surfaces"
  with the three paths and a Mermaid extension of the existing
  flowchart showing `scan-inline` and `import-session` as
  alternative entry points into `Brain/inbox/`.
- **`skills/brain-memory/SKILL.md`:** one paragraph mentioning that
  `@osb` markers in Daily / project notes are an alternative path
  when no agent is in the loop. The skill stays principle-level;
  procedural detail belongs in README / how-it-works.
- **CHANGELOG.md:** new `## [0.10.2]` block with `### Added` /
  `### Changed` subsections. Release date filled at release time;
  no calendar dates in the PR commit.
- **`docs/plans/2026-05-15-brain-roadmap.md`:** mark BRAIN-FUT-003
  reference (heuristic-phrase detection) as the place to grow if
  session-import shows a real miss-rate.
- **`install.md`:** unchanged. Install flow is not affected.

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `scan-inline` corrupts a user file mid-write | Per-file lock + atomic rename; `--dry-run` available; no pre-run snapshot (operation is local to user-owned files outside `Brain/`, vault-level backup is the user's responsibility) |
| Adapter misdetects a foreign format and writes wrong-shape signals | Detect uses concrete format markers (`originator`, `entrypoint`, `cli_version`); failure to detect surfaces as exit 2 asking for `--format`; no fuzzy fallback |
| `migrate-frontmatter --apply` crashes mid-rewrite leaving the vault inconsistent | Pre-run snapshot through `Brain/.snapshots/`; per-file atomic rename; rollback by `run_id` |
| Marker parser captures example markers inside documentation | Markers inside fences whose info-string is not `osb` are skipped; inline parser requires a known `kind` token |
| Hash-based dedup misses a signal whose `principle` was edited after first scan | Documented as intended behaviour — a fixed typo is a different statement; dream merges duplicates downstream via `duplicate-preferences` lint |
| New optional `BrainSignal` fields confuse legacy readers | Backward-compat is one-directional only — new readers handle absence as `live`; old readers ignore unknown fields per existing YAML-parser tolerance |
| Session files contain secrets in `principle` text from a careless paste | Existing `sanitiseTextField` redactor already runs in `writeSignal`; covers tokens, API keys, bearers in v0.9.1 |

## 12. Implementation Roll-up

Order within the single PR. Each step ships typecheck + unit tests
green before the next.

1. **§24 parser foundation** — extend `parsePreference` and
   `parseRetired` to accept both shapes; writer emits new shape;
   doctor `frontmatter-double-shape` warning. Existing tests stay
   green; new parser tests pass.
2. **§24 migration tool** — `migrate-frontmatter.ts` plus CLI plus
   tests, including snapshot + rollback.
3. **Data model** — `BrainSignal` extension (`source_type`,
   `dedup_hash`, `session_ref`); `writeSignal` accepts them; tag
   composer extended; signal tests updated.
4. **§9 marker parser** — `inline.ts` with inline + block grammar;
   isolated unit tests. No CLI yet.
5. **§9 walker + rewrite** — `inline-scan.ts`, `inline-rewrite.ts`;
   `o2b brain scan-inline` CLI; integration tests.
6. **§16 adapter framework** — `sessions/types.ts`, `registry.ts`,
   three adapters with golden fixtures.
7. **§16 orchestrator + CLI** — `sessions/import.ts`;
   `o2b brain import-session` CLI.
8. **Cross-feature E2E** — scenario from §9.3 of this doc.
9. **Documentation** — design-doc cross-references, README,
   CHANGELOG, skill update, how-it-works extension.

## 13. Open Questions

- **Adapter ergonomics for non-server runtimes.** This server hosts
  Claude / Codex / Hermes session files. Users running OSB elsewhere
  may have different paths or different session formats. The
  initial surface accepts a generic `<path>` argument; documentation
  shows the three known formats. Adding a Cursor adapter is a
  follow-up if demand appears.
- **Skill update.** The `brain-memory` skill currently teaches
  `brain_feedback`. Documenting inline markers there risks the
  agent treating them as the primary path instead of MCP. The
  paragraph added in §10 frames inline markers as the
  no-agent-available fallback, not the default.
- **CHANGELOG style for `_field` rename.** This is technically a
  schema change visible to anyone parsing `pref-*.md` outside the
  project. The release entry will call it out under `### Changed`
  with an explicit migration note pointing at
  `migrate-frontmatter` and the v0.12.0 hard-break ETA being
  dependency-driven (no calendar date).

## 14. References

- `Projects/OpenSecondBrain/Features/_summary.md` — Tier-A items
  §9, §16, §24.
- `Projects/OpenSecondBrain/Features/rowboat.md` §1 — inline marker
  source.
- `Projects/OpenSecondBrain/Features/llm-wiki-compiler.md` §1 —
  session-import source.
- `Projects/OpenSecondBrain/Features/tolaria.md` §3 — `_field`
  prefix convention source.
- `docs/plans/2026-05-15-brain-observing-memory.md` — v0.9 base
  plan; section numbering and file shapes referenced here.
- `docs/plans/2026-05-16-brain-search-design.md` — v0.10 reference
  for design-doc structure.
- `docs/plans/2026-05-15-brain-roadmap.md` — BRAIN-FUT-003 for the
  deferred heuristic phrase detection.
