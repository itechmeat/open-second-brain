# Proposal: run the brain store migration automatically after an update

## Why

The approved `brain-migration` spec says an upgrade offers the migration
but never runs it without consent. On a machine that only ever sees the
session start hook and the MCP server, nothing runs `o2b update` by hand:
the offer sits in the doctor output and the migration never happens. The
owner decided on 2026-11-17 to replace that rule: after Open Second Brain
is updated, the product itself checks whether this machine has migrated
its brain into the brain store and, if not, runs the migration, with
safeguards. A per-machine opt-out returns to the approved behaviour
(offered, never run) for a machine that wants it.

The migrator already has every safeguard this needs: it is idempotent and
resumable, quiesces only this machine, takes a verified backup, converts
through a journal, verifies, and switches only after verification passed.
The gap is that no update or start path ever calls it.

## What Changes

- `ensureVaultCurrent` (every full-scope MCP server start and the
  SessionStart hook) gains a migration step: when a migration is
  available on this machine and the opt-out is off, it claims a
  per-vault, per-machine worker lock and starts a detached
  `o2b brain migrate-store --auto <token>` worker, on the pattern of the
  self-heal upgrade worker (lock, token, failure marker, cooldown,
  metrics row). The step is a cheap read when nothing is to do and never
  runs the migration inside the hook or the server process.
- The worker, in its own process: initialise the store when none exists
  yet (the same code `o2b store init` runs), refuse on a dry run that
  reports unmapped entries or a store root problem, run the migration
  through `migrateStore` (resuming an interrupted run), record a waiting
  state for a later machine whose first machine's cut has not arrived,
  reopen the gate and leave the machine on the legacy layout on any
  failure, and record one brain log line, one metrics row and a one-time
  session start notice on success.
- `o2b update` runs the same check and worker logic in the foreground
  after updating, reports the outcome in its text and `--json` output,
  and takes `--skip-store-migration` to skip it once. A migration failure
  is named but does not fail the update.
- `o2b brain upgrade --dry-run` and its plan output name a pending
  migration and what the next start will do. A manual
  `o2b brain migrate-store` says so and exits when the automatic worker
  holds the lock.
- A device-level machine config key `auto_store_migration` (on by
  default, because consent is per machine) turns the automatic migration
  off; with it off the migration is offered and never run, as the
  previous spec required. An environment variable overrides it for CI.
- The doctor and the store status block report the automatic migration as
  one of not needed, pending, running, waiting, failed or done, and the
  session start digest carries at most one short line about a failed or
  waiting migration.

## Capabilities

### Modified Capabilities

- `brain-migration`: the upgrade requirement changes from "offers it but
  SHALL NOT run it without consent" to "runs it automatically after an
  update unless the machine opted out; with the opt-out it offers and
  never runs", with the safeguards the automatic path must keep.

## Commitments

- Privacy: the worker moves data only between the vault, the store and
  device-local state on this machine. Nothing goes to a provider.
- The detection step never blocks a start on a slow worker: the worker is
  detached, its streams are ignored, and the start waits on nothing.
- The opt-out lives in the machine config, never in the synced store or
  vault, so one machine cannot decide for another.
