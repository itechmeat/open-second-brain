/**
 * The `_brain.yaml` a fresh vault gets, and the schema versions this
 * build can read.
 *
 * One reason to change: a shipped default value. Per-block defaults that
 * only exist on the READ side (a block absent from the file) live next to
 * their block parser in `./blocks/`; this table is the subset that is
 * WRITTEN by `brain init` and merged onto field-by-field at load time.
 */

import type { BrainConfig } from "../types.ts";
// Imported from `defaults.ts` (not from `vault-scope/index.ts`) to
// break the module-init cycle: the resolver lives in `index.ts` and
// itself imports `loadBrainConfig` from this file. See the
// `defaults.ts` header for the rationale.
import { DEFAULT_VAULT_IGNORE_PATHS } from "../../vault-scope/defaults.ts";

/** Schema versions this build understands. Bump on incompatible changes. */
export const BRAIN_CONFIG_SUPPORTED_VERSIONS: ReadonlyArray<number> = [1];

/**
 * Default ceiling on the derived store a snapshot will archive: 256 MiB.
 *
 * Chosen against the two numbers that actually bound the cost. Retention
 * keeps ten archives, and `.snapshots/` is replicated peer-to-peer, so
 * the default ceiling admits at most ten compressed copies of a 256 MiB
 * database on every device. Larger stores are a deliberate decision the
 * operator makes by raising this number, which is why the ceiling
 * refuses and names the measured size instead of silently truncating or
 * silently skipping.
 */
export const DERIVED_STORE_MAX_BYTES_DEFAULT = 256 * 1024 * 1024;

/**
 * Default `_brain.yaml` content. Mirrors §10 of the design doc. Used by
 * `brain init` and as the fallback inside `loadBrainConfig` when callers
 * opt into permissive mode (the current API is strict — absent file
 * throws).
 */
export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  schema_version: 1,
  primary_agent: null,
  dream: Object.freeze({
    candidate_threshold: 3,
    unconfirmed_window_days: 14,
    contradiction_window_days: 14,
    heal_enrich_enabled: false,
  }),
  retire: Object.freeze({
    stale_evidence_days: 90,
  }),
  confidence: Object.freeze({
    low_max_applied: 2,
    medium_min: 0.4,
    high_min: 0.75,
  }),
  snapshots: Object.freeze({
    retention_count: 10,
    include_derived_store: false,
    derived_store_max_bytes: DERIVED_STORE_MAX_BYTES_DEFAULT,
  }),
  vault: Object.freeze({
    ignore_paths: DEFAULT_VAULT_IGNORE_PATHS,
  }),
}) as BrainConfig;

// The serialised default `_brain.yaml` (`DEFAULT_BRAIN_CONFIG_YAML`) is
// GENERATED from the default tables above and lives in
// `config-template.ts`. It cannot live here: the generator reads these
// tables, so importing it back would make the config layer and
// `config-template.ts` mutually dependent at module-evaluation time.
