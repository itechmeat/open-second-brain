# Multi-runtime install orchestrator + Most-applied in digest — design

Status: design
Target release: v0.10.11 (additive; no breaking CLI contract)
Closes / advances:

- `_summary.md` §4 second half (Deferred work) — full `o2b install --target X`
  orchestrator with auto-detect, idempotent managed-block / JSON-merge,
  `--dry-run` and `--check`.
- `_summary.md` §15 second half (Deferred work) — interactive
  `o2b init --interactive` wizard.
- `_summary.md` §13 cousin — `Most-applied (Nd)` block in `brain_digest`
  mirroring `active.md`, with `_brain.yaml`-driven window and limit.
- New companion lint surface — `o2b install --check` covers the
  "I installed it but it doesn't run" reports.
- `_summary.md` Deferred §D non-bash-runtime activity sources — partial
  uptake (Claude Code / Codex / Cursor session-transcript adapters land
  with this change; opencode / kiro / Copilot CLI / Gemini CLI / Aider /
  Pi stay deferred).

---

## 1. Scope and motivation

### 1.1 What this change delivers

Two themes plus three companions, all wired through a single new
abstraction layer (`InstallAdapter`).

**Theme 1 — single-command install across runtimes.** Today, installing
OSB on a new runtime requires walking `install.md` (1350 lines, five
hand-maintained branches A–E) and translating each step into the
runtime's native plugin / MCP machinery. The supported set is
{Hermes, OpenClaw, Codex, Claude Code, generic}; everything else — Cursor,
Aider, opencode, kiro, GitHub Copilot CLI, Google Gemini CLI, Pi — is
manual. After this change:

```
o2b install                        # detect-only; prints a table of detected
                                   # runtimes + the exact command to install
o2b install --target X             # plan-only; prints what would be written
o2b install --target X --apply     # apply the plan; idempotent
o2b install --target X --check     # post-install verify: managed block on
                                   # disk + MCP server responds
o2b uninstall --target X --apply   # remove exactly what install wrote,
                                   # never user-authored config
o2b init --interactive             # wizard that composes the commands
                                   # above into the first-time setup path
```

The seven new targets ship together: `cursor`, `aider`, `opencode`,
`kiro`, `copilot-cli`, `gemini-cli`, `pi`, `generic`. Existing targets
(`claudecode`, `codex`, `hermes`, `openclaw`) are not changed in this
PR — they keep their current install paths (documented in
`install/claudecode.md`, etc., after the doc restructure).

**Theme 2 — Most-applied surfaced to operators, not only agents.**
`Brain/active.md` already carries a `## Most-applied (30d)` block since
v0.10.10. `brain_digest` carries `## Top applied` (lifetime), but no
windowed equivalent. Operators reading the daily digest cannot tell
which rules are firing _now_ versus _ever_. After this change, both
`active.md` and `brain_digest` share one computer and one config block
(`active.most_applied.{window_days, limit}` in `Brain/_brain.yaml`).

**Companion 1 — `o2b install --check`.** Adapter-driven runtime health
check that catches the most common operator complaint ("I installed
it but the agent doesn't see it"). Not in `brain doctor` — that command
stays scoped to vault invariants.

**Companion 2 — partial uptake of per-runtime session-transcript
parsing in `o2b discipline report`.** The current "agent worked but did
not record" detector is runtime-agnostic (git + mtime + vault delta).
With install-time runtime detection in place, we can cheaply ask each
adapter "where do your session transcripts live?" and confirm activity
from the runtime's own logs. First round: Claude Code, Codex, Cursor
(transcript paths are documented and stable). Other runtimes stay on
the agnostic proxy until their transcript story stabilises.

**Companion 3 — `install/` documentation split.** `install.md` becomes
a short router pointing at `install/<target>.md`. Each per-runtime
file is the runtime-specific one-liner plus its caveats — terse enough
for an agent to consume verbatim, still readable for a human.

### 1.2 Out of scope for this PR

- Refactor of existing `claudecode` / `codex` / `hermes` / `openclaw`
  install flows. Those work today and have their own per-runtime
  branches. After this PR they live behind the same `InstallAdapter`
  interface for consistency, but the on-disk effect is unchanged.
- Pi runtime path resolution beyond the documented `~/.pi/skills/`
  default. If Pi stabilises a different convention, we add detection
  in a follow-up.
- Auto-merge of session-transcript signals into Brain (e.g. extracting
  user preferences from Cursor chat). Discipline-report only counts
  activity from transcripts; it does not _import_ them.
- New permission / sandbox features. Install never edits anything
  outside the runtime's documented config location and the vault's
  sidecar.

---

## 2. Architecture

### 2.1 Module layout

```
src/
  core/
    install/
      types.ts              # InstallAdapter, InstallPlan, ManifestEntry, ...
      registry.ts           # Map<target, InstallAdapter>, detectAll()
      manifest.ts           # sidecar I/O (<vault>/.open-second-brain/install.lock.json)
      managed-block.ts      # marker-fenced editor for text/YAML/TOML
      json-merge.ts         # safe mcpServers merge (preserves user keys)
      payload.ts            # builds the MCP-server payload from current config
      session-paths.ts      # per-target session-transcript globs
      adapters/
        cursor.ts
        aider.ts
        opencode.ts
        kiro.ts
        copilot-cli.ts
        gemini-cli.ts
        pi.ts
        generic.ts
    brain/
      most-applied.ts       # extended: windowDays/limit options
      digest.ts             # extended: most_applied block (text + JSON)
      active.ts             # uses computeMostApplied with config values
      policy.ts             # _brain.yaml loader extended for active.* block
  cli/
    install/
      install.ts            # `o2b install [--target X] [--apply|--check]`
      uninstall.ts          # `o2b uninstall --target X [--apply]`
      init-interactive.ts   # `o2b init --interactive` wizard
      render.ts             # table / plan / verify renderers
docs/
  install.md                # router/index
  install/
    prerequisites.md
    cursor.md
    aider.md
    opencode.md
    kiro.md
    copilot-cli.md
    gemini-cli.md
    pi.md
    claudecode.md           # current Branch D, restructured
    codex.md                # current Branch C, restructured
    hermes.md               # current Branch A, restructured
    openclaw.md             # current Branch B, restructured
    generic.md              # current Branch E + stdout/file format
templates/
  install/
    aider-context.md.tmpl   # Aider's read-list payload (skill summary)
tests/
  fixtures/install/<target>/
    before.{json|yml|txt}
    after.{json|yml|txt}
    manifest.json
```

### 2.2 InstallAdapter interface

```typescript
export interface InstallEnv {
  readonly vault: string;
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly now: Date;
}

export type AdapterStatus =
  | "not-installed"
  | "installed"
  | "drift"
  | "unsupported-on-this-platform";

export interface DetectResult {
  readonly target: string;
  readonly status: AdapterStatus;
  readonly configPath: string | null;
  readonly notes: ReadonlyArray<string>;
}

export interface InstallStep {
  readonly kind:
    | "json-merge"
    | "managed-block"
    | "subprocess"
    | "file-copy"
    | "symlink"
    | "print";
  readonly path: string | null;            // null for print / subprocess
  readonly preview: string;                 // human-readable diff or command
}

export interface InstallPlan {
  readonly target: string;
  readonly steps: ReadonlyArray<InstallStep>;
  readonly postNotes: ReadonlyArray<string>;
}

export interface ApplyOpts {
  readonly dryRun: boolean;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

export interface ManifestEntry {
  readonly target: string;
  readonly applied_at: string;              // ISO
  readonly operation: InstallStep["kind"];
  readonly config_path: string | null;
  readonly owned_keys?: ReadonlyArray<string>;     // JSON pointer paths
  readonly owned_paths?: ReadonlyArray<string>;    // absolute fs paths
  readonly owned_block_marker?: string;            // marker text for managed-block
}

export interface ApplyResult {
  readonly target: string;
  readonly manifest: ManifestEntry;
  readonly steps_executed: number;
}

export interface UninstallResult {
  readonly target: string;
  readonly removed_keys: ReadonlyArray<string>;
  readonly removed_paths: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<readonly [string, string]>; // (what, reason)
}

export interface VerifyResult {
  readonly target: string;
  readonly status: "ok" | "drift" | "not-installed" | "mcp-unreachable";
  readonly details: ReadonlyArray<string>;
  readonly fix_hint: string | null;          // exact command to repair
}

export interface SessionPathsResult {
  readonly target: string;
  readonly paths: ReadonlyArray<string>;
  readonly format: "claude-jsonl" | "codex-json" | "cursor-sqlite" | "unknown";
}

export interface InstallAdapter {
  readonly target: string;
  readonly label: string;
  detect(env: InstallEnv): DetectResult;
  plan(payload: McpPayload, env: InstallEnv): InstallPlan;
  apply(plan: InstallPlan, env: InstallEnv, opts: ApplyOpts): ApplyResult;
  uninstall(env: InstallEnv, opts: ApplyOpts): UninstallResult;
  verify(env: InstallEnv): VerifyResult;
  sessionPaths?(env: InstallEnv): SessionPathsResult | null;
}
```

`InstallAdapter` is the single seam everything else hangs off:

- `install.ts` CLI verb calls `detect → plan → apply → verify`.
- `uninstall.ts` calls `uninstall` (which reads sidecar manifest).
- `o2b install --check` calls `verify` per target.
- `o2b init --interactive` calls `registry.detectAll()` and then
  delegates to per-target `plan / apply` for the chosen targets.
- `o2b discipline report` calls `sessionPaths` for targets that
  implement it.

### 2.3 Idempotency model

Two patterns, picked per target by the adapter:

**JSON-merge (Cursor / opencode / kiro / Gemini CLI / Copilot CLI
fallback file).** The adapter parses the existing JSON, replaces or
inserts exactly two well-known keys (`mcpServers.open-second-brain`,
`mcpServers.open-second-brain-writer`), writes back with the same
indentation if detectable. Re-running `--apply` overwrites those two
keys verbatim and leaves every other key unchanged. `uninstall`
removes exactly those two keys based on the sidecar manifest.

**Marker-fenced block (Aider, generic-text-fallback).** The adapter
wraps its payload between `# >>> open-second-brain managed >>>` and
`# <<< open-second-brain managed <<<` markers (mirroring the existing
`o2b brain protect --target codex` convention). The block is the unit
of overwrite — content between markers is replaced atomically;
content outside is never touched. `uninstall` removes both markers
and everything between them.

In both cases the sidecar manifest records the exact intent. The
uninstall path is **manifest-driven**, not heuristic. Without a
sidecar entry, `uninstall` refuses unless `--force-from-snippet` is
passed (which then performs an exact-match check on the current OSB
payload signature, and removes only on full match).

### 2.4 Sidecar manifest

Path: `<vault>/.open-second-brain/install.lock.json`. Shared
directory with `protect.lock.json`, schema is independent.

```json
{
  "schema_version": 1,
  "installs": {
    "cursor": {
      "applied_at": "...Z",
      "operation": "json-merge",
      "config_path": "/home/user/.cursor/mcp.json",
      "owned_keys": [
        "mcpServers.open-second-brain",
        "mcpServers.open-second-brain-writer"
      ]
    },
    "aider": {
      "applied_at": "...Z",
      "operation": "managed-block",
      "config_path": "/home/user/.aider.conf.yml",
      "owned_block_marker": "# >>> open-second-brain managed >>>"
    },
    "pi": {
      "applied_at": "...Z",
      "operation": "symlink",
      "owned_paths": ["/home/user/.pi/skills/brain-memory"]
    }
  }
}
```

Atomic writes via the existing `atomicWriteFileSync` helper. Reads
tolerate missing file (returns `{ schema_version: 1, installs: {} }`)
and forward-compat unknown keys (logged as warnings, not errors).

---

## 3. Per-target adapters

### 3.1 `cursor`

- Operation: JSON-merge.
- Detect:
  - Default scope is user-global. Config path:
    `${XDG_CONFIG_HOME:-$HOME}/.cursor/mcp.json`. macOS fallback:
    `~/.cursor/mcp.json`.
  - `--scope project` (`<cwd>/.cursor/mcp.json`) is deferred — see §12.
- Plan: insert/replace two keys in `mcpServers`.
- Apply: write JSON, record manifest with both `owned_keys`.
- Verify: file parses as JSON, both keys present, optional MCP ping via
  `o2b mcp --probe`. Cursor needs an app-restart to reload — `verify`
  surfaces "MCP server registered on disk; restart Cursor to load"
  rather than treating "no ping yet" as failure.
- Uninstall: remove both `owned_keys`. If `mcpServers` is now empty,
  drop the empty object too.

### 3.2 `aider`

- Operation: managed-block in YAML config + sidecar context file.
- Detect:
  - Config path candidates (first wins): `<cwd>/.aider.conf.yml`,
    `$AIDER_CONFIG`, `~/.aider.conf.yml`.
- Plan:
  1. Generate `<vault>/.open-second-brain/aider-context.md` from
     `templates/install/aider-context.md.tmpl` (one render per
     install; idempotent overwrite).
  2. Add managed-block to `~/.aider.conf.yml` under the `read:` list,
     adding the generated context file path.
- Apply: write both files; manifest records `owned_block_marker` and
  `owned_paths: ['<vault>/.open-second-brain/aider-context.md']`.
- Verify: managed-block present, generated file exists, generated
  file is non-empty.
- Uninstall: remove managed-block; remove generated file.
- Open question for impl: confirm via WebFetch whether Aider has
  native MCP at impl time. If yes, switch to JSON-merge against
  Aider's MCP config; if no, the managed-block path stays. The
  adapter is structured to allow either without rewriting callers.

### 3.3 `opencode`

- Operation: JSON-merge.
- Detect: `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/mcp.json`.
- Plan / apply / verify / uninstall: identical pattern to `cursor`.
- Impl note: confirm config path via opencode upstream docs at impl
  time; the path above is the documented default but may move.

### 3.4 `kiro`

- Operation: JSON-merge.
- Detect: `~/.kiro/settings.json` (verify at impl time).
- Plan / apply / verify / uninstall: identical pattern.

### 3.5 `copilot-cli`

- Operation: subprocess, with JSON-merge fallback.
- Detect: `command -v copilot` (or `gh copilot` per upstream docs).
- Plan:
  1. If `copilot` CLI is on PATH: `copilot mcp remove open-second-brain`
     then `copilot mcp add open-second-brain ...` (twice — once per
     name). The CLI is the official path per
     `docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers`.
  2. Else: JSON-merge fallback at the documented file location.
- Apply: execute subprocess sequence or JSON-merge; manifest records
  `operation: "subprocess"` plus a `fallback_file` field when the
  fallback path was used.
- Verify: `copilot mcp list` shows both names (subprocess form) or
  config file parses with both keys (fallback form), plus MCP ping.
- Uninstall: `copilot mcp remove` per name, or remove JSON keys.

### 3.6 `gemini-cli`

- Operation: JSON-merge in `~/.gemini/settings.json` under `mcpServers`.
  Anchored in `github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md`.
- Plan / apply / verify / uninstall: standard JSON-merge.
- Verify ping: `gemini --help` exit-code 0 (cheap liveness),
  `gemini --version` for runtime version, and `o2b mcp --probe`
  for the MCP-side handshake.

### 3.7 `pi`

- Operation: symlink, no config edit.
- Detect: `${PI_HOME:-$HOME/.pi}`. Adapter creates the `skills/`
  subdir if missing.
- Plan: `ln -s <plugin-checkout>/skills/brain-memory $PI_HOME/skills/brain-memory`.
- Apply: create symlink; manifest records `owned_paths`.
- Verify: symlink exists, target resolves to a readable
  `brain-memory/SKILL.md`.
- Uninstall: remove symlink only (never the source).
- Open question for impl: confirm Pi's actual skills directory
  convention. If pi.dev / pi-mono stabilises a different layout,
  the adapter accepts `--pi-skill-dir <path>` as an override and
  records the chosen path in the manifest.

### 3.8 `generic`

- Operation: print.
- Detect: always `not-installed` (no canonical config to detect).
- Plan: build the MCP server payload (`o2b mcp` command + env) and
  render as JSON or YAML.
- Apply: write to `--out <path>` (or stdout if `--out -` or absent).
  Never edits any other file. Manifest records the output path so
  uninstall can report "you wrote it to /path/X; remove it yourself".
- Verify: if `--out <path>` was used, check the file still exists
  and parses. Else `not-installed`.
- Uninstall: print the path; do not delete (the operator chose
  where to put it; the runtime that consumed it may not know about
  our manifest).

### 3.9 Shared helpers

**`payload.ts`** builds the canonical MCP server payload from
`~/.config/open-second-brain/config.yaml`:

```json
{
  "command": "o2b",
  "args": ["mcp", "--vault", "<vault>"],
  "env": { "VAULT_AGENT_NAME": "...", "VAULT_TIMEZONE": "..." }
}
```

Two variants: full server (`open-second-brain`) and writer-only
(`open-second-brain-writer`, `args: ["mcp", "--writer-only"]`). The
writer-only path adds a new `--writer-only` flag to `o2b mcp` that
filters `buildToolTable()` to the three writer tools + `brain_context`
(consistent with the existing `alwaysLoad` writer-MCP server
introduced in v0.10.7).

**`json-merge.ts`** loads JSON5-tolerant (BOM, trailing newline),
records original indentation when detectable, replaces exactly the
two named keys under `mcpServers`, writes back with the original
indentation. No reformatting of unrelated content. If `mcpServers`
is missing, creates it; if the file is missing, creates it with
both keys only.

**`managed-block.ts`** matches the existing `protect.ts` marker
convention. Replaces the block atomically; rejects nested markers;
preserves surrounding content byte-for-byte.

**`manifest.ts`** is a thin sidecar I/O helper. The manifest schema
is independent of the rest of Brain — it lives under
`<vault>/.open-second-brain/` rather than `<vault>/Brain/` because
it tracks runtime-side state, not Brain memory state.

---

## 4. `o2b install` CLI surface

### 4.1 Verbs and flags

```
o2b install                                # detect-only; table output
o2b install --json                         # same, JSON

o2b install --target X                     # plan-only; prints what would change
o2b install --target X --apply             # execute the plan
o2b install --target X --apply --json      # apply + machine output

o2b install --target generic --out <path>  # write payload to file
o2b install --target generic --out -       # write payload to stdout
o2b install --target generic --format json # default
o2b install --target generic --format yaml

o2b install --check                        # verify all known runtimes
o2b install --check --target X             # verify one
o2b install --check --json                 # machine output

o2b uninstall --target X                   # dry-run
o2b uninstall --target X --apply           # remove what install wrote
o2b uninstall --target X --force-from-snippet
                                           # uninstall without sidecar entry,
                                           # using exact-payload match
```

The default `o2b install` (no flag) is **detect-only by design**.
This is the safest entry-point for the active user (the Hermes agent
on this VPS): zero side effects until `--apply` is named. Plan-mode
(`--target X` without `--apply`) is the second-safest: human-readable
diff per step, still no writes.

### 4.2 Exit codes

| code | meaning |
|------|---------|
| 0 | success (or `--check` reports all-ok / not-installed) |
| 1 | I/O error, parse error, subprocess failure |
| 2 | usage error (unknown target, missing flag) |
| 3 | `--check` found drift |
| 4 | `--apply` would have touched a file modified outside our managed-block / outside our owned JSON keys; aborted to avoid clobbering user changes |

Exit-code 4 is the safety net: when re-applying, the adapter builds
the canonical payload it would write right now (from the current
plugin config), reads the current on-disk content of the owned keys
or marker block, and compares them. If they differ **and** the
target file's mtime is newer than the manifest's `applied_at`, the
adapter refuses to overwrite without `--force`. This catches "user
hand-edited our block; don't blow it away on next `--apply`". No
content hash is stored in the manifest — the canonical payload is
fully determined by the plugin config plus a fixed payload template,
so it can be regenerated deterministically.

### 4.3 Output format

Default text output is operator-facing. Same data renders as JSON
under `--json` for the Hermes agent. Both formats include enough
detail for the agent to produce a follow-up command without needing
a second probe.

Detect-only table (excerpt):

```
o2b install — detected runtimes
-------------------------------
  cursor          installed     ~/.cursor/mcp.json (2 OSB keys present)
  aider           not-installed ~/.aider.conf.yml exists (no managed block)
  opencode        not-installed (config file missing)
  pi              installed     ~/.pi/skills/brain-memory (symlink ok)
  gemini-cli      drift         ~/.gemini/settings.json: writer key missing
                                fix: o2b install --target gemini-cli --apply

5 runtimes in registry; 2 installed, 1 drift, 2 not-installed.
```

---

## 5. `o2b init --interactive` wizard

Plain linear script — no TUI library. The wizard is a thin composer
over already-existing commands; no parallel implementation of
"what `o2b init` does".

Flow:

1. Vault path — scan `~/`, `~/Documents/`, `~/Sync/`, `~/Dropbox/`,
   `~/Library/Mobile Documents/.../Documents/` for `.obsidian/`.
   Numbered list + "other path" option.
2. Agent name — check `~/.config/open-second-brain/config.yaml` and
   `<vault>/AI Wiki/identity/agents.md` first. If found, offer to
   reuse; else propose `<hostname>-<runtime>` defaults + custom.
3. Timezone — free-form input; local IANA normalisation; one retry
   on invalid.
4. Language — optional; ISO 639-1 code; defaults to `en`. Recorded
   in plugin config for future language-aware behaviour.
5. Runtime selection — `registry.detectAll()` numbered list +
   "select multiple as comma-separated".
6. Optional `o2b brain init [--starter]`.
7. Summary plan — print the entire action list. Default answer:
   no. Require explicit `yes`.
8. Apply — `o2b init ...`, `o2b brain init ...`, then for each
   chosen runtime `o2b install --target X --apply`.
9. Verify — final `o2b install --check`.

Implementation: `src/cli/install/init-interactive.ts`. Tested via
mock-stdin / mock-stdout (`Bun.stdin` rewriting in test setup).

---

## 6. `o2b install --check` design

Per-target verifier driven by `adapter.verify()`:

1. **Sidecar manifest probe.** Look up the target's entry. Missing →
   status `not-installed`.
2. **Disk state.** For `json-merge`: file parses; both `owned_keys`
   present and match the canonical payload. For `managed-block`:
   marker pair found; content between markers matches canonical
   payload. For `symlink`: link exists and target resolves.
3. **MCP probe (where applicable).** Spawn `o2b mcp --probe`. The
   `--probe` flag is a new sub-flag on `o2b mcp`: it performs the
   MCP `initialize` handshake, reports tool count, and exits 0.
   Non-MCP targets (Pi, generic) skip the probe.
4. **Side-channel hint.** Cursor needs an app restart for MCP
   reload; the verifier surfaces this rather than treating "no
   ping" as failure when disk state is otherwise ok.

Output (text):

```
o2b install --check
-------------------
  cursor          ok          managed: ~/.cursor/mcp.json (2/2 keys; restart Cursor to load)
  gemini-cli      drift       managed: ~/.gemini/settings.json — writer key missing
                              fix: o2b install --target gemini-cli --apply
  pi              ok          symlink: ~/.pi/skills/brain-memory → <repo>/skills/brain-memory
  copilot-cli     not-installed
```

Exit code: 0 on all-ok-or-not-installed, 3 on any drift, 1 on I/O
error. JSON form mirrors text form field-for-field.

---

## 7. `brain_digest` extension (Theme 2)

### 7.1 Config block

`Brain/_brain.yaml` gains an optional top-level `active` block:

```yaml
schema_version: 1
active:
  most_applied:
    window_days: 30   # int 1..365; default 30
    limit: 10         # int 1..50;  default 10
```

Loader (`policy.ts`) returns `BrainActiveConfig | undefined`.
Validator rejects out-of-range and non-integer values with
`BrainConfigError` carrying the offending value and the accepted
range. Default values are not back-filled into the config object —
consumers read `cfg.active?.most_applied?.window_days ?? 30`.

`o2b brain upgrade` (additive deep-merge, v0.10.6) carries the new
block forward for existing vaults without user action; the starter
bundle ships the block populated at defaults so new vaults document
the knob.

### 7.2 Computer

`computeMostApplied(vault, prefs, opts)` already exists. Signature
change is additive:

```typescript
interface ComputeMostAppliedOptions {
  readonly now?: Date;
  readonly windowDays?: number;  // default 30
  readonly limit?: number;        // default 10
}
```

Internal `WINDOW_MS` is replaced with `windowDaysToMs(windowDays)`.
Day-level fence (`earliestDayPrefix`) still subtracts one day from
window start for UTC drift; that fence is independent of
`windowDays`.

### 7.3 Digest output

JSON (additive — `top_applied` lifetime block stays):

```json
{
  "top_applied": [...],
  "most_applied": {
    "window_days": 30,
    "limit": 10,
    "entries": [
      { "id": "pref-no-em-dashes", "principle": "...", "applied_in_window": 12 },
      ...
    ]
  }
}
```

Markdown (new section, rendered only when `entries.length > 0`):

```markdown
## Most-applied (30d)

- [[pref-no-em-dashes|No em-dashes in Russian prose]] — 12 applied
- [[pref-no-simply-word|Never use "simply"]] — 8 applied
```

Header text uses the actual `window_days` value (`(30d)`, `(14d)`,
`(7d)`). Empty-window markdown skips the section entirely; empty-
window JSON still emits the block with `entries: []` so machine
consumers see the shape.

### 7.4 `active.md`

`regenerateActive` now reads `cfg.active?.most_applied`. The
`active.md` header still says `Most-applied (30d)` when the config
holds the default; for non-default windows the header reflects the
actual value. Hash-stability for golden tests is preserved by
threading `now` through.

---

## 8. `o2b discipline report` extension (Companion 2)

`adapter.sessionPaths(env)` is optional. First-round implementers:

- `claudecode` → Claude Code project transcripts (`~/.claude/projects/`
  layout). Adapter reuses the path resolver from
  `src/core/brain/claude-memory-paths.ts`; format `claude-jsonl`.
- `codex` → Codex per-session transcripts under `~/.codex/`.
  Adapter resolves the exact subdirectory at impl time from the
  current Codex CLI version (the location has moved at least once
  upstream); format `codex-json`.
- `cursor` → Cursor workspace storage SQLite files
  (`~/.cursor/.../state.vscdb` on Linux, `~/Library/Application
  Support/Cursor/User/workspaceStorage/<hash>/state.vscdb` on
  macOS). Adapter resolves the exact path at impl time; format
  `cursor-sqlite`. Reader uses `bun:sqlite` (already in our stack).

For each path glob, the report:

1. Lists files modified inside the report window.
2. Reads each file, counts "agent-active turns" (tool calls
   detected: Claude `assistant.message.content[*].input` for
   `Write|Edit|MultiEdit|apply_patch`; Codex equivalent; Cursor
   reads from `aiServer.*` rows).
3. Computes per-agent activity-with-no-brain-events: an agent name
   appears in transcripts inside the window, but no `feedback` /
   `apply-evidence` / `note` event in `Brain/log/<date>.jsonl`
   carries the same agent for that day.

Status taxonomy adds a sub-reason in alert: `transcript-confirmed`
when the transcript glob confirms activity that the existing
proxy (git + mtime + vault-delta) also flagged. This reduces false
positives where activity was inferred from mtime but the agent
genuinely did read-only work.

Adapters without a `sessionPaths` implementation return `null`;
the report falls back to the existing proxy for those agents.

---

## 9. Documentation restructure (Companion 3)

### 9.1 New layout

```
docs/
  install.md                  # router; ~80 lines
  install/
    prerequisites.md          # Bun, common preconditions
    cursor.md                 # ~50 lines: command + caveats + verify
    aider.md
    opencode.md
    kiro.md
    copilot-cli.md
    gemini-cli.md
    pi.md
    claudecode.md             # current Branch D content, restructured
    codex.md                  # current Branch C
    hermes.md                 # current Branch A
    openclaw.md               # current Branch B
    generic.md                # current Branch E + stdout/file format
```

`install.md` (router) holds:

- One-paragraph intro to what OSB is.
- Link to `install/prerequisites.md`.
- Table of supported runtimes with one-liner command and link to
  per-runtime detail.
- Two paragraphs: `o2b init --interactive` and uninstall.
- Pointer to `install/generic.md` for runtimes outside the supported
  list.

Per-runtime files are terse — operator-readable, agent-consumable,
no historical context. Anything that needed two paragraphs of
rationale stays in the design doc, not the install guide.

### 9.2 README

Add a "Quick install" section above existing content:

```markdown
## Quick install

```
o2b install --target <name> --apply
```

| runtime | target name |
|---|---|
| Cursor | `cursor` |
| Aider | `aider` |
| opencode | `opencode` |
| kiro | `kiro` |
| GitHub Copilot CLI | `copilot-cli` |
| Google Gemini CLI | `gemini-cli` |
| Pi (pi.dev) | `pi` |
| Claude Code | `claudecode` |
| Codex | `codex` |
| Hermes | `hermes` |
| OpenClaw | `openclaw` |
| any other (printout) | `generic` |

See `docs/install.md` for per-runtime detail.
```

---

## 10. Testing strategy

### 10.1 Unit

- `managed-block.ts`: clean insert, idempotent overwrite, rejection
  of nested markers, byte-preservation of surrounding content,
  LF/CRLF tolerance.
- `json-merge.ts`: insert-into-empty, replace-existing-keys,
  preserve-unrelated-keys, preserve-indentation, BOM tolerance,
  trailing-newline preservation.
- `manifest.ts`: missing file → empty manifest, forward-compat
  unknown keys, atomic write, concurrent-write safety (mtime
  monotonicity).
- `payload.ts`: full server vs writer-only payloads;
  config-missing vs config-present; env-var override.

### 10.2 Per-adapter

Each adapter has a `tests/fixtures/install/<target>/` directory:

- `before.{json|yml|txt}` — config file contents before install
  (with realistic user keys mixed in).
- `after.{json|yml|txt}` — expected contents after install.
- `manifest.json` — expected sidecar manifest entry.
- Test cases per adapter:
  - clean install (`before.json` doesn't have OSB keys)
  - re-apply (apply twice; second is no-op; manifest `applied_at`
    is updated, file bytes do not change unless the canonical
    payload changed)
  - drift detection (manually mutate the file, run `--check`,
    expect drift status)
  - uninstall (apply then uninstall; expect exact pre-install
    state, except for the trailing newline)
  - uninstall without manifest (`--force-from-snippet`)
  - user-modified block (mtime newer than `applied_at`, content
    differs from canonical; expect exit 4 without `--force`)

### 10.3 Integration

- `o2b init --interactive` wizard with mock-stdin scripted answers.
  Covers: clean vault, vault with prior identity, vault with
  prior Brain layer, two runtimes selected, all runtimes selected,
  user cancels at summary.
- `o2b install --check` against a tmpdir vault with mock adapters
  in all four states (`ok`, `drift`, `not-installed`, `mcp-unreachable`).

### 10.4 Brain digest tests

- Default config (no `active` block) renders 30d/10.
- Custom config (`window_days: 7, limit: 3`) renders 7d/3.
- Empty window: markdown skips the section; JSON emits empty
  `entries`.
- Invalid config: validator rejects with the offending value and
  range; loader returns the error path; `brain doctor` surfaces it.

---

## 11. Versioning, migration, rollout

- **Version:** v0.10.11. Additive: new `_brain.yaml` block (optional;
  loader returns undefined when absent), new CLI verbs, new docs
  files. No CLI flag removed, no env var renamed.
- **Schema migration:** `o2b brain upgrade --apply` adds the
  `active.most_applied` block at defaults to existing
  `_brain.yaml`. No data migration required.
- **CHANGELOG:** one entry under `v0.10.11` covering both themes
  and the three companions. Per the project convention, single PR
  → single version entry; expanded scope grows the entry, never
  bumps version mid-PR.

---

## 12. Deferred work

After this PR ships, `_summary.md` Deferred section gets these
adjustments:

- Strike: `_summary.md` §4 second half (closed by this PR).
- Strike: `_summary.md` §15 second half (closed by this PR).
- Update Companion 2 entry: "shipped partial uptake (Claude Code /
  Codex / Cursor); remaining runtimes (opencode / kiro / Copilot
  CLI / Gemini CLI / Aider / Pi) stay deferred. Trigger for
  uptake: each runtime documents a stable session-transcript path
  and we have a user actively running that runtime."

New deferred items introduced by this PR:

- `--scope project` for Cursor / opencode (and any other runtime
  that supports project-scope configs). v0.10.11 defaults to
  user-scope only. Trigger: an operator reports a vault used from
  multiple project trees, or two runtime installs on the same
  machine collide on user-scope.
- Pi path auto-detection beyond `~/.pi/skills/`. Trigger: pi.dev
  stabilises a different convention, or `--pi-skill-dir` becomes
  the common case.
- `o2b install --apply --interactive`: confirm-each-step prompt
  for users who want the wizard's safety without running the full
  `o2b init --interactive`. Trigger: explicit operator request.
- Per-target restart hooks (kill old MCP server processes after
  install). Right now we rely on the runtime's own restart cadence.
  Trigger: drift reports where the file is correct but the runtime
  did not pick up the change.

---

## 13. Open questions for impl

Each is testable at impl time with WebFetch or a one-liner probe;
not blocking design approval.

1. Aider MCP support status at impl time. If native MCP exists,
   switch the `aider` adapter from managed-block-in-YAML to
   JSON-merge against Aider's own MCP config. Adapter structure
   admits either backend.
2. opencode / kiro / Copilot CLI / Gemini CLI exact config-file
   paths and any required env vars beyond `VAULT_AGENT_NAME` /
   `VAULT_TIMEZONE`.
3. Pi's documented skills directory convention. If `~/.pi/skills/`
   is wrong, the adapter accepts `--pi-skill-dir <path>` and the
   wizard surfaces the override.
4. Cursor restart automation. Right now `verify` surfaces "restart
   to load" as a hint; we do not kill the Cursor process. Confirm
   no IPC channel exists for graceful reload before declaring this
   a closed question.
