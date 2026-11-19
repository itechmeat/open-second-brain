# Proposal: the automatic migration worker always starts, and says so when it cannot

## Why

On a machine where the session start runs without Bun on PATH (an ssh
session, an agent a macOS GUI started), the start spawned the automatic
store migration worker through the launcher `scripts/o2b`, which looks Bun
up on PATH: the worker died at once, its error output went nowhere, and
every start rewrote the worker lock with a dead process while status kept
saying the next start runs the migration. The same machine's cohort report
dated a device by the month in its continuity shard's name although its
rows were later, and `o2b brain migrate-store` on a switched machine named
devices the doctor and the status call retired by silence as still on the
legacy layout.

## What Changes

- One helper decides how Open Second Brain starts its own code as a child:
  the running runtime by its absolute path and the entry script, the
  launcher only as the fallback of a process that does not run under Bun;
  every background child is detached on every platform. A census test holds
  every self-spawn site to it.
- The claim a start hands to the worker awaits the worker's confirmation (its
  own stamp). A worker gone without confirming it is recorded as a failed
  attempt by its spawner or by the next start, with its exit and its error
  output (kept in a small device-local log); status, doctor and the session
  notice name it before that too.
- A shard's row times date its device for every naming scheme; the name's
  period is a floor.
- The transition report reads the cohort status module.

## Capabilities

### Modified Capabilities

- `brain-migration`: the silence rule's evidence, the cohort surfaces and
  the automatic worker's process.

## Impact

- `src/core/maintenance/o2b-command.ts`, `ensure-current.ts`,
  `src/core/search/freshen.ts`, `hooks/session-capture.ts`.
- `src/core/store-migration/auto-state.ts`, `auto-worker.ts`,
  `auto-report.ts`, `device-evidence.ts`, `outcome.ts`;
  `src/core/brain/runtime-notices.ts`; `src/cli/brain/verbs/migrate-store.ts`.
- Docs: `docs/brain-store.md`, `CHANGELOG.md`.
