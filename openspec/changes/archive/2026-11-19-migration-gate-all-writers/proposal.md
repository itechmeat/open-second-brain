# Proposal: every writer of a vault stops while its migration holds the gate

## Why

An owner check on a copy of a real vault found `o2b brain note` writing
`Brain/log/<day>.<device>.md` and its `.jsonl` into the legacy tree while
an automatic store migration of that vault held this machine's migration
gate. The requirement "Quiesce and back up before moving" says every write
attempted on the migrating machine is refused. The gate was asked only by
the content lane of the vault write guard: the Brain log, the freeze
marker and attestations write on the audit lane, and a group of writers
(search feedback and provider registries, the maintenance lease, the
vault index page, bridge links, the bootstrap, the state move, the
preview artifacts, the hook state and the injection cache) passed no
guard at all.

## What Changes

- The vault write guard asks the migration gate first, on both lanes. The
  run's own writes into the tree it migrates (its snapshot and the
  snapshot's log line) pass only inside an explicit holder scope.
- Every writer that passes no vault guard asks the gate itself; readers
  that used to create a database or a cache on the way leave the tree
  alone while the gate is held; a hook writes nothing and never fails the
  session.
- The refusal names the run that holds the gate (a migration, its rollback
  or the removal of the legacy tree), since when, how far it is when the
  run reported it, and, for a run whose process is gone, what continues it
  (the next start, or the command). The MCP refusal `migration_in_progress`
  carries `run_kind`, `holder`, `progress` and `retry` (`later` or
  `recover`), also when a tool handler wrapped the refusal in an error of
  its own.
- A census test drives every CLI verb, MCP tool, hook and background
  worker under the gate held for this vault, for another vault and with no
  gate.

## Capabilities

### Modified Capabilities

- `brain-migration`: two requirements beside the quiesce requirement say
  which writes are refused (every lane, every writer, the rollback and the
  removal too, never another vault's) and what the refusal says; a hook
  never fails a session over it.

## Impact

- `src/core/migration-gate.ts`, `src/core/brain/vault-identity.ts`: the
  gate on both lanes, the holder scope, the refusal and its progress.
- The writers that passed no guard (listed in the census), the MCP
  dispatch (`src/mcp/server.ts`), the preview budget.
- `src/core/store-migration/`: the snapshot inside the holder scope, the
  progress the migration, the rollback and the removal report.
- Tests: `tests/core/architecture/migration-gate-census*`.
