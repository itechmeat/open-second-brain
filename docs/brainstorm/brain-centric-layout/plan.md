# Brain-centric layout - implementation plan

Order matters - the atom layer (config + path constants) must land before the helpers (init / pay-memory / scan-inline) that depend on it. Each task lands on `feat/brain-centric-layout` as a separate conventional commit on top of the brainstorm commit.

## Tasks

### Task 1: `notes` config block + atom types

- **Files**: `src/core/brain/types.ts` (modified - add `BrainNotesConfig` + `ResolvedBrainNotesConfig`, slot `notes?` into `BrainConfig` + `notes` into `ResolvedBrainConfig`), `src/core/brain/policy.ts` (modified - add `BRAIN_NOTES_DEFAULTS = { read_paths: [] }`, `resolveNotes(cfg)`, validator), `tests/core/brain/notes-config.test.ts` (new).
- **Acceptance**:
  - `BrainNotesConfig.read_paths` is `ReadonlyArray<string>`, frozen.
  - Absent block resolves to defaults (empty array).
  - Validator rejects: non-array `read_paths`, non-string entries, empty strings, absolute paths (starts with `/`), parent-traversal (`..` segment anywhere).
  - Tests cover happy path, defaults fallback, every rejection branch.
- **Depends on**: none.

### Task 2: Pay Memory path migration constant

- **Files**: `src/core/pay-memory/paths.ts` (modified - swap root constant from `"AI Wiki"` to `posix.join("Brain", "payments")`; the sub-roots `policies/`, `assets/`, `drafts/`, `reports/`, `_pending/`, and the dated `YYYY-MM-DD/` receipt subdir become `Brain/payments/<sub>/`), `tests/core/pay-memory/paths.test.ts` (modified - update all expected paths).
- **Acceptance**:
  - Every Pay Memory write path resolves under `<vault>/Brain/payments/`.
  - No file in `src/core/pay-memory/` references the literal `"AI Wiki"` after the change.
  - Existing Pay Memory tests pass against the new paths after fixture updates.
- **Depends on**: none.

### Task 3: Init no longer scaffolds AI Wiki/

- **Files**: `src/core/init.ts` (modified - drop the seven `AI Wiki/...` template registrations, drop the corresponding `relPath` blocks, drop the `agent-name` rewrite branch that targets `AI Wiki/identity/agents.md`), `src/core/brain/templates/_OPEN_SECOND_BRAIN.md.tpl` (deleted), `src/core/brain/templates/_open-second-brain.yaml.tpl` (deleted if present), `src/core/brain/templates.ts` (modified - drop template registry entries for the deleted files), `tests/core/init.test.ts` (modified - update the expected scaffolding list).
- **Acceptance**:
  - `o2b init --vault <path>` writes the profile config + creates `.open-second-brain/` index dir only. No `<vault>/AI Wiki/` is created.
  - `o2b brain init --vault <path>` continues to bootstrap `<vault>/Brain/` as before (no change there).
  - Init tests verify the absence of `AI Wiki/` after a fresh init.
- **Depends on**: none (independent of Tasks 1, 2).

### Task 4: `_BRAIN.md` operating-manual cleanup

- **Files**: `src/core/brain/templates/_BRAIN.md.tpl` (modified).
- **Acceptance**:
  - Removes the `AI Wiki/` and `Daily/` paragraphs from the template.
  - Adds a one-line pointer: `For user-authored notes (daily journal, weekly notes, etc.), declare their folders under `notes.read_paths` in `_brain.yaml`; the agent only reads from those paths.`
  - Snapshot test or golden-file test verifies the new template content matches expectations.
- **Depends on**: Task 1 (config block must exist to reference).

### Task 5: Remove legacy `event_log_append` write path

- **Files**: `src/core/event-log.ts` (deleted if the file's only purpose was `appendEvent`; otherwise modified to remove `appendEvent` + the `Daily/<date>.md` writer + the redactor if unused), `src/cli/append-event.ts` (deleted), `src/cli/main.ts` (modified - drop the `append-event` subcommand registration), `tests/cli/append-event.test.ts` (deleted), `tests/core/event-log.test.ts` (deleted or trimmed).
- **Acceptance**:
  - `o2b append-event` is no longer a registered subcommand; running it exits with the standard "unknown command" message and exit code 2.
  - The MCP `event_log_append` tool was already removed in v0.10.8; this task removes the dead `appendEvent` internal helper plus the historical comment blocks pointing at it (`src/mcp/tools.ts:21,166,236`, `src/openclaw/index.ts:11,28,218`, `src/core/brain/types.ts:195`, `src/mcp/brain-tools.ts:366`).
  - Typecheck and lint pass.
- **Depends on**: none.

### Task 6: `scan-inline` honours `notes.read_paths`

- **Files**: `src/core/brain/inline-scan.ts` (modified - resolve scan roots from `ResolvedBrainConfig.notes.read_paths`; default empty list = no work, exit 0 with a stderr note), `tests/core/brain/inline-scan.test.ts` (modified - add cases for: empty config, single read_path, multiple read_paths, read_path that does not exist on disk, ignore_paths inside a read_path).
- **Acceptance**:
  - With no `notes:` block, `o2b brain scan-inline` exits 0 and writes nothing.
  - With `notes.read_paths: ["Daily"]`, the scanner walks `<vault>/Daily/` and captures `@osb` markers as before.
  - With multiple paths, every listed root is walked.
  - `vault.ignore_paths` is honoured for each root.
- **Depends on**: Task 1.

### Task 7: Doctor + manifest + path-safety cleanup

- **Files**: `src/core/brain/doctor.ts` (modified - drop the `AI Wiki/` / `Daily/` exclusion comment block, rely on `vault.ignore_paths`), `src/core/brain/manifest.ts` (modified - same), `src/core/path-safety.ts` (modified - drop the `AI Wiki/` allow-list if present), `src/mcp/tools.ts` (modified - rewrite `second_brain_query`'s description to remove the `AI Wiki/notes/` framing), `src/mcp/instructions.ts` (modified - remove `AI Wiki/` and `Daily/` references), `src/mcp/brain-tools.ts` (modified - drop the `Daily/` fallback comment in `brain_note`'s docstring), `tests/core/brain/doctor.test.ts` + `tests/core/brain/manifest.test.ts` + `tests/core/path-safety.test.ts` (modified - update expected exclusions to be `vault.ignore_paths` only).
- **Acceptance**:
  - No source file under `src/` contains a hardcoded `"AI Wiki"` or `"Daily/"` string after this task (except the upgrade migration in Task 8, which uses them as detection inputs).
  - Doctor and manifest tests pass with `vault.ignore_paths` as the only exclusion mechanism.
- **Depends on**: Task 2 (Pay Memory already off `AI Wiki/`), Task 3 (init already off `AI Wiki/`), Task 5 (no more `Daily/`-writer).

### Task 8: Migration in `brain upgrade`

- **Files**: `src/core/brain/upgrade.ts` (modified - new step `migrateLegacyLayout(vault, dryRun)`), `src/core/brain/upgrade-migrations/legacy-aiwiki-payments.ts` (new - moves `<vault>/AI Wiki/{payments,policies,assets,drafts,reports,_pending}/**` to `<vault>/Brain/payments/<same>/**`), `src/core/brain/upgrade-migrations/legacy-aiwiki-scaffolding.ts` (new - removes the seven OSB-managed scaffolding files: `_OPEN_SECOND_BRAIN.md`, `_open-second-brain.yaml`, `index.md`, `hot.md`, `log.md`, `identity/user.md`, `identity/agents.md`; leaves the empty `AI Wiki/` directory if nothing else is in it; leaves any user-authored content alone), `src/core/brain/upgrade-migrations/legacy-daily-event-log.ts` (new - removes top-level `Daily/<date>.md` files whose first line matches the `appendEvent` marker comment; user-authored daily notes without that marker are left alone), `tests/core/brain/upgrade-aiwiki-migration.test.ts` (new - covers Pay Memory move, scaffolding removal, daily-event-log removal, user-content preservation, idempotency).
- **Acceptance**:
  - Running `o2b brain upgrade --apply` on a v0.10.x vault moves every OSB-managed file into the new location, removes the scaffolding, and leaves user-authored content untouched.
  - Re-running on a migrated vault is a no-op (no log entry, no snapshot, idempotent via sidecar manifest entry).
  - `--dry-run` reports the planned moves and removals without writing.
  - A pre-run snapshot is taken before any move (existing `brain upgrade` behaviour).
  - Post-migration doctor reports clean (no `AI Wiki/payments/` left, no `Daily/<date>.md` written by `appendEvent` left).
- **Depends on**: Tasks 2, 3, 5 (these define the new layout the migration moves to).

### Task 9: Docs update

- **Files**: `README.md`, `docs/how-it-works.md`, `docs/pay-memory.md`, `docs/cli-reference.md`, `docs/architecture.md`, `docs/mcp.md`, `install/prerequisites.md`, `install/hermes.md` and any other `install/*.md` that names `AI Wiki/` or `Daily/`.
- **Acceptance**:
  - `grep -rE 'AI Wiki|/Daily/' README.md docs/ install/ skills/` returns zero matches outside `docs/plans/`, `docs/brainstorm/`, and `docs/legacy-skills/`.
  - The `docs/how-it-works.md` vault layout shows only `Brain/` + `.open-second-brain/` + an optional `notes.read_paths` example pointing at any folder the operator names.
  - `docs/pay-memory.md` uses `Brain/payments/...` paths throughout.
  - Per the "no legacy framing in public docs" rule, the README + docs read as if this layout has always been the design; migration framing lives only in CHANGELOG and the brainstorm folder.
- **Depends on**: all earlier tasks complete.

### Task 10: Version bump + CHANGELOG

- **Files**: `package.json` (version `0.11.0`), runtime manifests via `bun run sync-version`, `CHANGELOG.md`.
- **Acceptance**:
  - Major-minor bump to `0.11.0` (breaking change: removed `o2b append-event`, removed `event_log_append` MCP tool's last vestiges, Pay Memory paths changed).
  - `CHANGELOG.md` carries a single `[0.11.0]` entry listing: removed AI Wiki/, removed Daily/ hardcoding, moved Pay Memory to Brain/payments/, removed legacy event log, added `notes.read_paths`, migration via `o2b brain upgrade`.
  - `bun run sync-version` mirrors the version to every runtime manifest.
- **Depends on**: Tasks 1-9.
