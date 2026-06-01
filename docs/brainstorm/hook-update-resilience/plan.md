# Hook update resilience - implementation plan

## Tasks

### Task 1: o2b-hook fail-soft + robust resolution
- **Files**: `scripts/o2b-hook`, `tests/hooks/o2b-hook.test.ts` (new)
- **Acceptance**:
  - Given a hook name whose `.ts` file is missing, the wrapper writes a warning to stderr and exits `0` (never `2`).
  - Resolution order: `$CLAUDE_PLUGIN_ROOT/hooks/<name>.ts` if present, else own-realpath root, else `$OSB_PLUGIN_ROOT`, else PATH-derived; first existing wins.
  - Bun-missing/precheck failure in hook context does not produce a blocking exit.
- **Depends on**: none

### Task 2: hooks.json version-current command
- **Files**: `hooks/hooks.json`, command-shape test
- **Acceptance**:
  - Every hook command resolves `o2b-hook` via `$CLAUDE_PLUGIN_ROOT/scripts/o2b-hook` when the env is set, else PATH `o2b-hook`, and never blocks if neither resolves.
  - Codex (env absent) still runs the PATH wrapper.
- **Depends on**: Task 1

### Task 3: self-heal stale ~/.local/bin OSB symlinks
- **Files**: `scripts/o2b-hook` (or a small lib), `src/cli/install-cli.ts`, tests
- **Acceptance**:
  - When invoked from a valid current root, a dangling or different-OSB-checkout `~/.local/bin/o2b-hook|o2b|vault-log` symlink is re-pointed to the current checkout; best-effort, never fatal.
  - A symlink owned by an unrelated tool, or a real (non-symlink) file, is never touched.
- **Depends on**: Task 1

### Task 4: install-cli idempotent re-point
- **Files**: `src/cli/install-cli.ts`, `tests/cli/install-cli.test.ts`
- **Acceptance**:
  - Re-running `install-cli` re-points an OSB-owned or dangling symlink to the current checkout without manual `rm`.
  - Still refuses to clobber a non-symlink file or an unrelated tool's symlink (clear error).
- **Depends on**: none

### Task 5: hard update-safety instruction
- **Files**: `CLAUDE.md`, `AGENTS.md` (mirror), `docs/updating.md` (new), `README.md` pointer
- **Acceptance**:
  - A documented invariant set: updates must not require manual symlink surgery; hooks must fail-soft (never exit 2); CLI/hook resolution self-heals after update.
  - `diff CLAUDE.md AGENTS.md` differs only on the title/audience lines.
- **Depends on**: Tasks 1-4 (document the shipped behavior)

### Task 6: QA + release
- Full `bun run validate` (typecheck, lint, test suite) green.
- Smoke: simulate stale symlink + run hook -> agent not blocked; run hook with CLAUDE_PLUGIN_ROOT set -> resolves current version.
- Version bump + CHANGELOG, PR, release per feature-release-playbook (separate bump handled in release phase).
