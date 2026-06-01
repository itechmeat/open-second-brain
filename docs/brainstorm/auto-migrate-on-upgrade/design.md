# Auto-migrate on upgrade - hands-off self-healing after a version bump

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

After upgrading the plugin, a user currently has to run manual commands before
Open Second Brain works correctly again. v0.31.1 fixed the hook/symlink class;
this completes the job for the rest. A user should never run a maintenance
command after an update - the plugin must detect that its state is behind the
running version and bring itself current automatically.

## Manual-after-upgrade steps to eliminate (audited)

- **Search index schema mismatch.** `store.ts` read path throws
  `SCHEMA_MISMATCH ... Run: o2b search reindex` (and `not initialised ... Run: o2b
  search index`). Write opens auto-migrate additively, but reads error and an
  additive migration does not re-chunk content (e.g. the CJK column).
- **Brain release-owned files.** `_brain.yaml` / `_BRAIN.md` only migrate via the
  manual `o2b brain upgrade --apply` (additive, snapshot-backed).
- **Embeddings on model/dimension change.** `ensureEmbeddingModel` auto-clears
  vectors (lossy); repopulation needs `o2b search reindex --embeddings`.
- **Missing Brain subdirectories** on vaults created by older versions.

Root cause: no upgrade detection. `SERVER_VERSION` is never compared to any
persisted state; auto-migration exists only on the search WRITE path.

## Chosen approach

Two complementary, idempotent, best-effort parts.

### A. Lazy search self-heal (removes the user-facing error directly)

In the search read path, on `SCHEMA_MISMATCH` or `not initialised`, transparently
rebuild the index once and retry instead of throwing. Search then never requires
a manual `reindex`. First search after an upgrade is slower; subsequent ones are
normal.

### B. State-driven `ensureVaultCurrent(vault)` at startup

Run a best-effort maintenance pass at a universal entry point (MCP server boot -
Hermes/Claude Code/Codex all spawn `o2b mcp`; also wired into the SessionStart
hook). It NEVER throws and NEVER blocks startup on slow work:

1. Ensure required Brain directories exist (idempotent).
2. Brain managed-file upgrade: if `planUpgrade(vault)` reports pending changes,
   `applyUpgrade` (snapshot + log; additive; user content untouched). No-op when
   nothing is pending.
3. Search: if the index is missing-but-vault-has-content, or its
   `schema_version` != `LATEST_SCHEMA_VERSION`, trigger a reindex in the
   BACKGROUND (does not block boot). Embeddings repopulate in the same reindex
   when semantic search is configured.

### Why state-driven, not a version stamp

The vault is Syncthing-synced across devices, so a stamp written into the vault
would let one device mark a migration "done" and make another device skip its own
(per-device) work - most importantly the per-device search reindex. So each step
keys off ACTUAL state instead:
- search reindex <- per-device index `index_state.schema_version` (authoritative,
  per-device);
- brain upgrade <- `_brain.yaml` pending-changes plan (idempotent across synced
  devices);
- dirs <- existence.

These checks are cheap reads (single-digit ms), safe to run on every boot; only a
real migration does work. This is strictly more correct than a version stamp: it
also handles interrupted migrations and downgrades. An OPTIONAL per-device version
note (in `~/.config/open-second-brain/`, never in the vault) may be written for
logging/telemetry only - never for correctness gating.

## Scope

- `src/core/maintenance/ensure-current.ts` (new): `ensureVaultCurrent(vault, opts)`.
- Search read path: lazy rebuild-and-retry on `SCHEMA_MISMATCH` / not-initialised.
- Background reindex helper (non-blocking, single-flight via the existing index lock).
- Wire `ensureVaultCurrent` into MCP boot (`src/mcp/server.ts`) and the
  SessionStart hook (`hooks/active-inject.ts`).
- Docs: `docs/updating.md` - "updates are automatic; no manual reindex/brain upgrade".

## Out of scope

- First-time `o2b init` / plugin config bootstrap (that is install, not upgrade).
- Changing the manual `o2b brain upgrade` / `o2b search reindex` commands (kept for
  explicit use); auto-migration reuses their logic.

## Design decisions

- **Never throw, never block.** All maintenance is best-effort; failures log to
  stderr and the runtime proceeds. Slow work (reindex) runs in the background.
- **Single-flight.** Concurrent runtimes booting at once must not double-migrate;
  rely on the search index lock and brain snapshot/upgrade idempotency; skip if a
  lock is held.
- **Reuse existing machinery** (`planUpgrade`/`applyUpgrade`, `reindexVault`,
  `bootstrapBrain` dir creation) rather than reimplementing.

## Risks and open questions

- Auto-applying the brain managed-file upgrade writes to the user's vault on boot.
  Mitigated by snapshot + log + additive-only merge; matches the chosen hands-off
  behavior.
- Background reindex must be fire-and-forget without leaving a half-written index;
  `reindexVault` already builds atomically (temp + rename) under a lock.
- MCP boot must not be delayed; the reindex is detached, the cheap checks are sync.
