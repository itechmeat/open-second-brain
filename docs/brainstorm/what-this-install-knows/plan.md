# What this install knows about itself - implementation plan

Nine tasks. Each is one atomic commit, test-first, with the project
formatter and linter green before the commit is created.

Cards: t_dee1d1fe (tasks 1-2), t_cf827c77 (task 3), t_49315346 (task 4),
t_09d7e9e9 (task 5), t_c64b7cab (task 9, recorded refusal only).

## Tasks

### Task 1: One version constant
- **Files**: `src/core/version.ts` (new), `src/cli/brain/verbs/continuity.ts`,
  `src/mcp/protocol.ts`, `src/core/install/opencode-plugin-asset.ts`,
  `tests/core/version.test.ts` (new)
- **Acceptance**: a test asserts `OPEN_SECOND_BRAIN_VERSION` equals the
  `version` field read from `package.json`, and a source scan asserts that
  `src/` contains exactly one `package.json` import with a `version` read -
  the one in `src/core/version.ts`. The scan fails today with three hits,
  which is the failing state to reach first.
- **Depends on**: none

### Task 2: `o2b version` and `--version`
- **Files**: `src/cli/version.ts` (new), `src/cli/main.ts`,
  `src/cli/command-manifest.ts`, `tests/cli/version.test.ts` (new)
- **Acceptance**: `o2b version` prints the constant and exits 0;
  `o2b version --json` prints `{"version":"<constant>"}` and parses;
  `o2b --version` prints the same line as `o2b version`; the manifest
  carries a `version` command and a root `--version` flag, and the
  manifest-completeness ratchet
  (`tests/cli/manifest-completeness.test.ts`) accounts for the new case.
  That ratchet enumerates the dispatchers and asks the manifest to
  account for each, so adding the `switch` case before the manifest entry
  is what makes it fail first. An unknown argument after `version` is a
  usage error, not silence.
- **Depends on**: Task 1

### Task 3: Instructions rendered from the capability report
- **Files**: `src/mcp/instruction-segments.ts` (new),
  `src/mcp/instructions.ts`, `src/mcp/server.ts`,
  `tests/mcp/instruction-segments.test.ts` (new),
  `tests/mcp/mcp.test.ts` (the existing `buildInstructions` coverage)
- **Acceptance**: four tests. (a) With every tool available, each of the
  three scopes renders byte-identical text to the current constant - the
  pin that keeps this from becoming a rewrite. (b) With `brain_note`
  withheld, the writer body contains no line naming `brain_note` and the
  rendered text names it once, in a withheld block, carrying the exact
  reason string the evaluator produced. (c) With every non-diagnostic tool
  withheld, the body is the identity line plus the withheld block and
  nothing that instructs a call. (d) The unresolved-identity branch still
  renders the reason in place of the identity line, unchanged. A segment
  declaring a tool name that no scope's tool table contains fails a test,
  so a renamed tool cannot silently orphan its guidance.
- **Depends on**: none

### Task 4: `second_brain_wiring`, `projects` view
- **Files**: `src/mcp/wiring-tools.ts` (new), `src/mcp/tools.ts`,
  `src/mcp/registry-guard.ts`, `tests/mcp/wiring-tools.test.ts` (new)
- **Acceptance**: `view: "projects"` returns one entry per registered
  link carrying the project reference, the vault reference, the
  four-value `pointer` state and `vaultExists`. With `expose_host_paths`
  unset, no absolute host path appears anywhere in the payload, asserted
  against the serialised JSON, and
  `tests/core/architecture/vault-path-census.test.ts` passes. With the
  flag set, the raw paths appear. An unreadable config renders each
  reference as `{ error }` and never as a raw path. A registry damaged by
  hand degrades to the entries it can read, matching `listLinkedProjects`,
  rather than throwing. An absent `view`, or an unknown one, is an
  `INVALID_PARAMS` error naming the accepted members.
- **Depends on**: none

### Task 5: `second_brain_wiring`, `hosts` view
- **Files**: `src/mcp/wiring-tools.ts`, `tests/mcp/wiring-tools.test.ts`
- **Acceptance**: `view: "hosts"` returns one entry per registered adapter
  carrying `target`, the `VerifyStatus` member, `details` and `fix_hint`,
  from the same `verify()` call `o2b install --check` makes - asserted by a
  test that drives both and compares. With the vault unresolved, the view
  refuses by name with the same reason `runCheck` gives, and does not
  report ten targets as not-installed. The injected host-probe runner
  (`setHostProbeRunner`) drives the unreachable branch without a host
  binary present, and a probe that cannot run renders its named
  `HOST_PROBE_RESULT` reason rather than an `ok`.
- **Depends on**: Task 4

### Task 6: Scope placement and census
- **Files**: `src/mcp/tools.ts`, existing architecture and tool-census
  tests. The preview-budget rationale row lands in Task 4 with the
  registration it describes; this task only proves the surface is
  complete.
- **Acceptance**: the full tool census test passes with the new name, the
  tool is absent from the writer and catalog scopes, no import cycle is
  introduced (`tests/core/architecture/import-cycles.test.ts`), and
  `bun run typecheck` and `bun run lint` are green.
- **Depends on**: Tasks 4, 5

### Task 7: Documentation
- **Files**: `README.md`, `docs/cli-reference.md`, `docs/mcp.md`
- **Acceptance**: `docs/cli-reference.md` documents `o2b version`, its
  `--json` output and the root `--version` flag; `docs/mcp.md` documents
  `second_brain_wiring`, both views, the path policy and the probe cost;
  `README.md` gains one short paragraph. The repository link checker
  (`bun run link-ratchet:check`) passes.
- **Depends on**: Tasks 2, 5

### Task 8: Version bump and CHANGELOG
- **Files**: `package.json`, the eight mirrored manifests and
  `pyproject.toml` via `bun run scripts/sync-version.ts`, `CHANGELOG.md`
- **Acceptance**: `CHANGELOG.md` carries one new `## [1.56.0] - <date>`
  heading with its `compare` link reference at the bottom;
  `bun run sync-version:check` exits 0; the heading and `package.json`
  agree. Minor bump: four additive capabilities, no breaking contract
  change.
- **Depends on**: Tasks 1-7

### Task 9: Record the refusal of t_c64b7cab
- **Files**: `CHANGELOG.md` (Notes section)
- **Acceptance**: the notes state that release awareness was scoped,
  verified against source, and not built, naming both the missing
  producer and `src/core/install/ownership.ts:794`, and stating that the
  decision is the operator's. The design document already carries the
  full verdict. The card's own handoff summary is written at the tracker
  tick, after the release.
- **Depends on**: Task 8
