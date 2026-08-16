# What the machine already has - implementation plan

Eleven atomic units across nine tracker items, on one branch, each its own commit.
Every unit is test-first: the test is written, run, and observed failing for the expected
reason before the implementation exists.

Tracker mapping:

| unit | tracker item |
| --- | --- |
| 1, 3, 4 | t_9f5b974b, t_367a31c1 |
| 2 | t_85cc975b |
| 5 | t_9b209fbe |
| 6, 7 | t_53e77d0a |
| 8 | t_553ce8f6 |
| 9 | t_3745dd4b |
| 10 | t_7c89c306 |
| 11 | t_2866fef9 |

## Tasks

### Task 1: Runtime facts substrate
- **Files**: `src/core/runtime/host-facts.ts` (new); `src/core/install/types.ts`;
  `tests/core/runtime/host-facts.test.ts` (new);
  `tests/core/architecture/host-facts-census.test.ts` (new);
  `tests/core/architecture/verdict-vocabulary-census.test.ts`
- **Acceptance**: `INSTALL_TARGET_ID` / `InstallTargetId` / `INSTALL_TARGET_IDS` /
  `isInstallTargetId` follow the house closed-vocabulary pattern and are enrolled in the
  vocabulary census. `TOOL_CEILING_KIND` has exactly three members and `unknown` carries
  a reason. A census derives the target population from `registerAllAdapters().targets()`
  and asserts it equals the `RUNTIME_FACTS` key set in both directions; the census fails
  if the population is empty. `InstallAdapter.target` is typed `InstallTargetId`.
- **Depends on**: none

### Task 2: Committed vault tier and config provenance
- **Files**: `src/core/validate.ts`; `src/core/config.ts`; `src/core/brain/policy/load.ts`;
  `src/core/brain/policy/blocks/install.ts` (new); `src/core/install/payload.ts`;
  `src/core/install/grok-asset.ts`; `tests/core/config-origin.test.ts` (new);
  `tests/core/brain/policy/install-block.test.ts` (new)
- **Acceptance**: `CONFIG_ORIGIN` is a closed vocabulary (`env`, `user-config`,
  `vault-config`, `default`). `resolveWithOrigin` returns value plus origin and
  `envOrConfig` delegates to it with no call-site change - proved by a test that asserts
  the two agree on every branch. An `install:` block in `<vault>/Brain/_brain.yaml`
  supplies `hook_timeout_seconds` and `tool_profile`; an env var beats it, a user-level
  key loses to it, and each resolution reports its origin. An unreadable or malformed
  vault config makes install and hook generation refuse by name rather than default.
  Regeneration from identical inputs stays byte-identical.
- **Depends on**: none

### Task 3: Ceiling-aware tool profile in the generated payload
- **Files**: `src/core/install/payload.ts`; `src/core/install/payload-equals.ts`;
  `src/core/install/adapters/_json-mcp.ts`, `cursor.ts`, `opencode.ts`, `grok.ts`,
  `copilot-cli.ts`; `src/mcp/capabilities.ts`; `install/cursor.md`;
  `tests/core/install/tool-ceiling.test.ts` (new); `tests/mcp/profiles.test.ts`
- **Acceptance**: for every target whose `RUNTIME_FACTS` row declares a ceiling, the
  generated `full` entry carries `--tool-profile <name>` and the advertised tool count
  under that profile is at or under the ceiling - asserted with the real
  `buildToolTable` count, pinned as an equality, and driven by the derived population so
  a new target with a ceiling cannot avoid the check. A target with an `unknown` ceiling
  gets no profile and `second_brain_capabilities` reports the ceiling as unchecked with
  its reason. `verify()` still reconstructs the expected payload from `InstallEnv` alone
  and reports no drift on a fresh apply. `install/cursor.md`'s expected-output block is
  updated to whatever `verify()` now prints, and
  `tests/docs/install-verify-conformance.test.ts` is the check that the two agree.
- **Precedence, stated once**: `OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE` beats an `install:`
  block `tool_profile` in `<vault>/Brain/_brain.yaml`, which beats the profile declared
  on the `RUNTIME_FACTS` row, which beats no profile at all. Each resolution reports its
  `CONFIG_ORIGIN`, and a test drives all four layers.
- **Depends on**: 1, 2

### Task 4: Adapter friction diff and keyless host probe
- **Files**: `src/core/install/friction.ts` (new); `src/core/install/types.ts`;
  `src/cli/install/install.ts`; `src/cli/install/render.ts`;
  `src/cli/command-manifest.ts`; `docs/cli-reference.md`;
  `tests/core/install/friction.test.ts` (new); `tests/cli/install-friction.test.ts` (new)
- **Acceptance**: `o2b install --friction [--base <t> --compare <t>] [--json]` renders one
  row per capability dimension per target, derived from `RUNTIME_FACTS` and the adapter
  registry rather than a hand-written table, and a diff form names which dimensions
  differ. For a target declaring a host probe, `verify()` returns either a real
  registration-shape answer or a named skip reason; the blanket
  "no MCP handshake attempted" note survives only where no probe is declared, and a test
  asserts that string no longer appears for probe-bearing targets. The probe runner is
  injectable and both branches are driven.
- **Depends on**: 1

### Task 5: Lane vocabulary, step deadline, maintenance retry, parity census
- **Files**: `src/core/brain/maintenance/lane.ts`; `src/core/brain/dream-step.ts`;
  `src/core/brain/dream-scan.ts`; `src/core/brain/heal-run.ts`;
  `src/mcp/brain/feedback-tools.ts`; `src/mcp/brain/admin-tools.ts`;
  `src/cli/brain/verbs/maintenance.ts`; `docs/mcp.md`; `docs/cli-reference.md`;
  `tests/mcp/maintenance-parity-census.test.ts` (new);
  `tests/mcp/long-running-tools.test.ts`; `tests/cli/brain-maintenance.test.ts`;
  `tests/core/brain/maintenance/maintenance.test.ts`
- **Acceptance**: `LANE_TASK` is a closed vocabulary with a guard, and both the CLI task
  list and the MCP task list are built from it - a source census asserts neither module
  contains a bare lane-name literal. `runDreamStep(vault, step, opts)` accepts a
  safeguard and a progress sink, `scanBrain` and `runHealEnrichment` honour checkpoints,
  and a jumping-clock test proves `brain_dream action=run step=<x>` trips the deadline
  and names the operation. `brain_maintenance` accepts `retry_tasks`, `busy_minutes`,
  `busy_threshold` and `limit`; an unknown retry name is refused by name, matching the
  CLI. The `force` description names every gate it disables. A parity census derives the
  CLI flag set from the verb's flag table and the MCP property set from the tool
  definition and requires each to map or carry a declared exemption with a written
  reason; it fails if either population is empty. The `docs/mcp.md` deadline row for
  `step` no longer reads **none**.
- **Depends on**: none

### Task 6: State surface inventory
- **Files**: `src/core/state/surfaces.ts` (new); `src/core/install/ownership.ts`;
  `src/core/doctor.ts`; `src/mcp/tools.ts`; `src/cli/brain/verbs/state.ts` (new);
  `src/cli/state-render.ts` (new); `src/cli/main.ts`; `src/cli/command-manifest.ts`;
  `tests/core/state/surfaces.test.ts` (new);
  `tests/core/architecture/state-surface-census.test.ts` (new)
- **Acceptance**: `STATE_SURFACE_ID` is a closed vocabulary; every row carries a
  resolver, tier, override env key, override config key, whether it carries memory, and
  a written reason. `inventoryStateSurfaces(vault)` returns per-surface resolved path,
  reachability as a tri-state with a reason, and the origin that placed it, rendered
  through one value with two renderings (`o2b state status` and the `vault_health`
  field). A source census sweeps for path builders under the derived-store directory and
  demands each be attributed to a row or excused with a reason of a minimum length; it
  fails if the population is empty, and its count is pinned as an equality.
- **Depends on**: 2

### Task 7: State migrate, rollback, and graceful drain
- **Files**: `src/core/state/migrate.ts` (new); `src/mcp/http.ts`; `src/mcp/stdio.ts`;
  `src/cli/brain/verbs/state.ts`; `src/cli/main.ts`; `docs/cli-reference.md`;
  `tests/core/state/migrate.test.ts` (new); `tests/mcp/http-drain.test.ts` (new)
- **Acceptance**: `o2b state migrate --to <dir>` plans by default and mutates only under
  `--apply --yes`, refused non-interactively without `--yes`, following the
  `brain upgrade` ladder. The manifest binds source type, canonical roots, the path
  inventory, byte counts and SHA-256 digests through `sha256Hex` and `canonicalJson`. It
  refuses before committing on a symlink, a special file, a destination conflict,
  insufficient space, a reserved namespace, or a held writer lock. `o2b state rollback`
  restores only manifest-bound content whose digest still matches and refuses to delete
  anything that changed after the migration, naming each. On SIGTERM or SIGINT the HTTP
  transport stops accepting, reports `draining` on `/health`, awaits in-flight requests
  to a bounded deadline, then closes - proved by a test holding a request open across the
  signal - and the exit hooks that checkpoint the search index and release locks still
  run afterwards. The drain deadline defaults to ten seconds and is overridable; when it
  expires, the still-open requests are named on stderr rather than dropped silently.
- **Depends on**: 6

### Task 8: Codex CLI install adapter
- **Files**: `src/core/install/adapters/codex.ts` (new); `src/core/install/adapters/all.ts`;
  `src/core/runtime/host-facts.ts`; `install/codex.md`;
  `tests/core/install/adapters/codex.test.ts` (new);
  `tests/docs/install-verify-conformance.test.ts`
- **Acceptance**: the adapter registers both server keys through an injectable
  `CodexRunner` driving `codex mcp add|remove|list --json`, with a TOML section merge into
  `~/.codex/config.toml` as the fallback when the binary is absent; unrelated sections and
  the existing `[plugins."..."]` and `[marketplaces....]` blocks survive byte-for-byte.
  `detect`, `plan`, `apply`, `uninstall` and `verify` are driven on both branches, apply
  is idempotent, and `install/codex.md` carries an expected-output block matching
  `verify()`. Its `PIPELINE_HOSTED_DOCS` exemption is removed, and the conformance test
  binds it like any other adapter.
- **Depends on**: 1, 4

### Task 9: Machine-wide session discovery and coverage status
- **Files**: `src/core/brain/sessions/discover.ts` (new); `src/core/brain/sessions/types.ts`;
  `src/core/install/types.ts` and all ten adapters (`sessionPaths` implementations);
  `src/core/discipline/transcripts/index.ts`; `src/cli/brain/verbs/import-session.ts`;
  `src/cli/brain/help-text.ts`; `src/cli/command-manifest.ts`;
  `src/core/brain/safeguard.ts`; `tests/core/brain/sessions/discover.test.ts` (new);
  `tests/cli/session-discovery.test.ts` (new); `tests/cli/progress-emitter-census.test.ts`
- **Acceptance**: `sessionPaths()` is a required member returning roots from
  `RUNTIME_FACTS` and a `SessionAdapterId`; a runtime that stores no session logs
  (`generic`, `aider`, `pi`) returns `null`, which is a stated answer rather than an
  absent member. The orphan
  `"claude-jsonl" | "codex-json" | "cursor-sqlite"` union is gone from the tree.
  `o2b brain import-session --discover` reports what would import without importing;
  `--status` reports per runtime the found count, the imported count and the gap, keyed
  by content hash in a manifest under the derived-store directory so an unchanged file is
  reported as imported without re-parsing. `--discover --all` imports the gap. Roots are
  read once: `src/core/discipline/transcripts/` consumes the same declaration, proved by
  a test that changes a root in `RUNTIME_FACTS` and observes both consumers move. If the
  sweep carries a safeguard it carries a progress sink and satisfies the emitter census
  with a drivable entry point; if it carries neither, that is stated in the module.
- **Depends on**: 1, 8

### Task 10: Streaming session parse
- **Files**: `src/core/brain/sessions/read-lines.ts` (new); five session adapters;
  `src/core/brain/sessions/import.ts`; `tests/core/brain/sessions/read-lines.test.ts` (new);
  `tests/core/brain/sessions/streaming-memory.test.ts` (new)
- **Acceptance**: all five adapters consume a shared line reader that yields without
  materialising the whole file, and autodetect reads only the first chunk instead of the
  whole file a second time. A test drives a synthetic session larger than the previous
  whole-file path would comfortably hold and asserts peak retained bytes stay bounded,
  and every existing session-import test still passes with byte-identical vault output.
  `ImportSessionOptions` gains a safeguard and a progress sink together, or neither.
- **Depends on**: 9

### Task 11: Session transcript dataset export
- **Files**: `src/core/brain/export.ts`; `src/core/brain/export-transcripts.ts` (new);
  `src/cli/brain/verbs/export.ts`; `src/core/egress/registry.ts`;
  `src/cli/brain/help-text.ts`; `docs/cli-reference.md`;
  `tests/core/brain/export-transcripts.test.ts` (new);
  `tests/cli/brain-export.test.ts`; `tests/core/architecture/egress-census.test.ts`
- **Acceptance**: `ExportFormat` becomes a closed vocabulary with a guard and is the
  single dispatch - a source test asserts the CLI verb no longer inlines format literals.
  A transcript format emits JSONL conversation records built from the streaming reader,
  filterable by runtime and date range. Every branch calls `redactForEgress` before
  producing bytes, the guard-call count meets the destination-declaration count in the
  module, the site is declared in `EGRESS_SITES` with a written reason, and a refused
  verdict writes nothing and exits non-zero. A record carrying a secret-shaped identifier
  is refused by name in a test.
- **Depends on**: 10
