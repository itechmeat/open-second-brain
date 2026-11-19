# Design

## Context

The migration gate (`src/core/migration-gate.ts`, design D11 step 2 of
`brain-store-and-topics`) is one device-local file naming the vault a run
migrates. The vault write guard (`assertVaultIdentityForWrite`) asked it,
but only for the content lane; the audit lane exists so a freeze does not
silence its own record, and it carried the gate's exemption with it.

## Decisions

### D1. Every write is refused; no lane may write during a run

The alternative was to let some lanes write and rely on the migration's
re-scan, which repeats until a pass imports nothing, and on a switched
machine's transition import, which re-reads changed record files. That
covers record files only. The run copies the device-local surfaces (the
provider registries, the hook state, the procedural counters and the
other surfaces the map sends to `device-local` or `backup`) once, right
after its backups, and a switched machine reads only that copy: a write
into one of them after the copy is lost
(`tests/core/store-migration/gate-window-loss.test.ts` shows it). A rule
that names which lanes may write would have to be kept true for every
future surface; refusal is the rule.

### D2. The check lives in the guard, ahead of the lane split

`assertVaultIdentityForWrite` is the position every vault writer already
passes (its wrappers `brainDirsForWrite`, `assertLaneWrite` and
`assertNoteVaultForWrite` included), so the gate moves above the lane
switch there. Writers that pass no guard by design (the bootstrap, lock
primitives, fail-soft caches and per-vault state outside `src/core/brain/`)
ask `assertNoMigrationInProgress` themselves; the census lists each.

### D3. The run's own writes pass by an explicit scope

`asMigrationGateHolder(vault, fn)` lets the writes inside `fn` pass when
this process is the gate's holder. Only the snapshot uses it. A pid check
alone would also let through every other writer the same process calls,
which a test hook (and a host that runs the migration in-process) does.

### D4. The refusal says what to do

The run kind comes from the run id (`migrate-`, `rollback-`,
`remove-legacy-`). Whether the holder is still there is a signal probe of
its pid only, so a refusal stays cheap on every platform. The progress is
a small device-local file the run writes at its steps and the release
removes; a refusal shows it only when it names the same run. The MCP
dispatch records the first refusal met during a call, so a handler that
caught the error and threw its own still answers with the structured
refusal.

### D5. Hooks and readers degrade

A hook's writes go through the same guards; the hook state, the injection
cache and the session capture already fail soft, and now refuse without a
write. A reader that created its database on the first read (the
maintenance lease) answers without it; the preview budget answers with a
cut preview and no artifact id. A telemetry row a reader records is
dropped.

## Risks

- A refusal costs one gate read per write, as before; the extra facts are
  read only on the refusal path.
- Freeze semantics do not change: the freeze is still checked on the
  content lane only, after the gate.
