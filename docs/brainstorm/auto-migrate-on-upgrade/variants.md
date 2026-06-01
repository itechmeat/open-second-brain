# Variants and rationale

Orchestrator-decided (constrained robustness fix, not an open design space). The
investigation (manual-step audit + entry-point map) closed the space.

Approaches considered:

- **A. Version stamp in the vault** (e.g. `Brain/.osb-state.json` or a
  `_brain.yaml cli_version` key), compared to `SERVER_VERSION`. **Rejected as the
  correctness mechanism:** the vault is Syncthing-synced across devices, so a
  device that migrated would mark the work done for every device and make others
  skip their own per-device steps (search reindex lives in a per-device index).
- **B. Per-device stamp** in `~/.config/open-second-brain/`. Workable, but a stamp
  can drift from reality (interrupted migration, downgrade, manual index delete).
- **C. State-driven checks (chosen).** Each step keys off actual state - index
  `schema_version` (per-device), `_brain.yaml` pending-changes plan (idempotent),
  dir existence. Cheap reads on boot; only real migrations do work. Strictly more
  correct than a stamp and immune to the synced-vault hazard. A per-device stamp
  may still be written for logs only, never for gating.

- **Reindex timing:** at-boot-blocking (rejected: delays MCP readiness on large
  vaults) vs lazy-only (rejected alone: first search is slow and nothing is
  proactive) vs **background kick + lazy self-heal safety net (chosen).**

- **Auto-apply brain upgrade vs warn-only:** operator chose full hands-off, so
  auto-apply with snapshot + log (additive, user content untouched).
