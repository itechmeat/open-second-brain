# Updating Open Second Brain safely

Open Second Brain installs into version-rotating plugin caches (Claude Code:
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; Codex: a local or
git marketplace snapshot). **An update must never break an existing install or
the agent.** This document is the contract that guarantees it, for both
operators and any agent that edits the plugin.

## For operators

Normal updates need no manual steps:

```bash
# Claude Code
claude plugin update open-second-brain@open-second-brain   # restart to apply

# Codex
codex plugin marketplace upgrade        # git marketplaces
codex plugin add open-second-brain@open-second-brain   # re-stage local marketplace

# Hermes (server: the plugin dir is a symlink to the checkout)
hermes plugins update open-second-brain
```

You do **not** need to delete or re-create any `~/.local/bin` symlink by hand.
The hooks resolve the current version on their own, and the global
`o2b`/`o2b-hook`/`vault-log` symlinks self-heal on the next session start. If
you ever want to force a re-point explicitly:

```bash
o2b install-cli      # idempotent: re-points dangling or stale OSB symlinks
```

`o2b install-cli` only touches its own (Open Second Brain) symlinks or dangling
links; it never overwrites a real file or a symlink owned by another tool.

### Vault state migrates itself

You also do **not** need to run `o2b search reindex` or `o2b brain upgrade`
after an update. On the next start of any runtime (the `o2b mcp` server boot,
which Hermes/Claude Code/Codex all spawn, and the Claude Code SessionStart
hook), `ensureVaultCurrent` brings an already-initialised vault current,
hands-off:

- a stale `_brain.yaml` / `_BRAIN.md` is migrated (snapshot-backed, additive;
  user content untouched);
- a stale-schema or missing search index is rebuilt in the **background** (a
  detached reindex), so startup never blocks; and as a safety net the search
  read path self-heals a stale/missing index on first query.

It is **state-driven, not version-stamped.** Each step keys off actual on-disk
state - the search index `schema_version`, the `_brain.yaml` pending-changes
plan, directory existence - rather than a "last version" marker. This is
deliberate: a vault is often synced across devices (Syncthing), so a stamp
written into the vault would let one device mark the work done and make another
skip its own per-device step (the search index is per-device). State checks are
cheap reads on every start; only a real migration does work, and the approach
also handles interrupted migrations and downgrades. Any per-device version note
lives outside the vault and is for logging only, never for gating.

The manual `o2b search reindex` / `o2b brain upgrade` commands still exist for
explicit use; auto-migration just reuses their logic.

## Why updates used to break (and no longer do)

`hooks/hooks.json` previously invoked the bare `o2b-hook` launcher through a
`~/.local/bin` symlink that `o2b install-cli` pinned to a *versioned* cache
directory. When Claude Code rotated that directory on update, the symlink
dangled, the launcher resolved an old checkout, and it `exit 2`-ed — the one
hook exit code that blocks the agent. Every prompt was rejected until the user
deleted the symlink by hand. That manual step is exactly what this design
removes.

## Invariants — REQUIRED for any change to hooks, the launcher, or install-cli

If you are an agent (or human) editing `hooks/`, `scripts/o2b-hook`,
`scripts/o2b`, or `src/cli/install-cli.ts`, you MUST preserve all of these.
**A later update must always be able to repair an install made by an earlier
version — never assume a clean prior state.**

1. **Resolve version-currently, never version-pinned.** Resolve the launcher
   via `$CLAUDE_PLUGIN_ROOT` first (Claude Code sets it to the active version
   and re-reads `hooks.json` from that version every session — so a correct
   command shape here repairs an already-broken install on the next update),
   then the script's own realpath, then `$OSB_PLUGIN_ROOT`. Never hard-code a
   version, a cache path, or a stored absolute path that a future update will
   orphan.
2. **Hooks fail soft — never block.** `scripts/o2b-hook` and every
   `hooks.json` command must `exit 0` on any internal error (unresolved hook,
   missing Bun, missing launcher). Never `exit 2`; never let a hard
   `command not found` be the only outcome. A broken hook must degrade to a
   no-op, not a bricked agent.
3. **Self-heal conservatively.** Symlink repair (`healCliSymlinks`, and
   `install-cli`'s reclaim path) may re-point only dangling links or stale
   Open Second Brain `scripts/<name>` links; it must never touch a real file,
   a foreign tool's symlink, or a stable-directory install (e.g. a server
   checkout under `/srv/...` shared by Hermes/Codex).
4. **Codex has no plugin-root env var.** Keep the PATH `o2b-hook` fallback so
   Codex (and any runtime without `CLAUDE_PLUGIN_ROOT`) still works.
5. **Post-upgrade migration is state-driven and best-effort.** `ensureVaultCurrent`
   must key off actual on-disk state (index `schema_version`, `_brain.yaml`
   pending plan, dir existence), never a stamp written into the (possibly synced)
   vault. It must never throw and never block startup - slow work (reindex) runs
   detached in the background. Any new manual-after-upgrade step a future change
   introduces must be folded into `ensureVaultCurrent` so the user never runs it.

These properties are locked by tests; do not weaken them:

- `tests/hooks/o2b-hook.test.ts` — fail-soft + `$CLAUDE_PLUGIN_ROOT`-first resolution.
- `tests/hooks/hooks-json-shape.test.ts` — every command is version-current, has a PATH fallback, and ends with `exit 0`.
- `tests/cli/install-cli.test.ts` — idempotent reclaim and conservative self-heal.
- `tests/core/search/self-heal.test.ts` — search rebuilds a stale/missing index on read.
- `tests/core/maintenance/ensure-current.test.ts` — state-driven migration, idempotent, never throws.
