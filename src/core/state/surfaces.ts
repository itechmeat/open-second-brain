/**
 * Every durable state surface this tool keeps INSIDE the vault, declared
 * once and measured on request.
 *
 * This is the missing half of `src/core/install/ownership.ts`. That module
 * enumerates what can live OUTSIDE the vault and measures one thing about
 * it - where the search index resolved. The rest of the machine's state
 * sits inside the vault under two roots, roughly forty locations, each
 * resolved by its own function scattered across the tree, and nothing
 * could answer the three questions an operator actually asks before they
 * copy, migrate or delete a vault:
 *
 *   1. WHERE does each surface live on this machine?
 *   2. Is it REACHABLE - and if not, is that because nothing wrote it, or
 *      because this process could not look?
 *   3. WHICH LAYER put it there - a default, a machine config key, or an
 *      environment variable somebody exported once?
 *
 * The design follows `ownership.ts` deliberately rather than starting a
 * parallel instrument:
 *
 *   - {@link STATE_SURFACES} is a CATALOGUE, printed whole. A row says
 *     what this build can keep at that location, never that this machine
 *     has it. Presence is the measured half.
 *   - {@link StateReachabilityVerdict} is modelled on `SearchIndexVerdict`:
 *     a tri-state carrying its own reason. `absent` and `unchecked` are
 *     separate members because "it is not there" and "I could not look"
 *     are different repairs, and an `EACCES` folded into `absent` tells an
 *     operator to create a file that is already there.
 *   - {@link inventoryStateSurfaces} produces ONE value and
 *     {@link renderStateInventory} is the only place it becomes prose, so
 *     `o2b state status` and the `vault_health` MCP field cannot drift the
 *     way two hand-written copies of a report always do.
 *
 * ## Why the paths are derived here rather than imported
 *
 * Twelve of the resolvers this file describes are module-private
 * (`journalPath`, `leaseDbPath`, the protect manifest, the inject cache),
 * and importing the twenty that are exported would pull the search layer,
 * the install layer and the whole `brain/` tree into what must stay a
 * leaf: the CLI verb and the MCP tool both reach it, and an inventory that
 * imports its subjects is one edge away from a cycle the architecture
 * ratchet gates. So each row DERIVES its path from the same name
 * constants the resolvers use, and `tests/core/state/surfaces.test.ts`
 * binds every row to its real location. A rename in `brain/paths.ts`
 * fails that test rather than printing a path nothing writes.
 *
 * Two kinds of binding, because two kinds of resolver: a row whose
 * resolver is exported is compared against it directly, and a row whose
 * resolver is private is bound by DRIVING the module's exported writer
 * against a temporary vault and asking whether the artifact landed at
 * the row's own path. No row is bound by neither today; the list of
 * deliberate exceptions is empty and its size is asserted, so a new row
 * that binds to nothing is a decision somebody typed rather than one
 * nobody noticed.
 *
 * ## What this module does not claim
 *
 * The `.lock` files `scanStaleLocks` finds are not rows: they are created
 * beside whatever is being written and removed by the writer that made
 * them, so there is no fixed location to report. The one exception is the
 * search writer lock, which has a stable name derived from the index.
 *
 * `CONFIG_ORIGIN.vaultConfig` never appears in a report today. No key in
 * `<vault>/Brain/_brain.yaml` moves a state surface, and
 * {@link resolveWithOrigin} cannot see that tier anyway; the day one does,
 * the caller layers it on the result exactly as `install/settings.ts`
 * already does.
 */

import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BRAIN_ARTIFACTS_REL,
  BRAIN_CAPTURES_REL,
  BRAIN_CLAIM_GRAPH_FILE,
  BRAIN_LOG_REL,
  BRAIN_PROCEDURAL_MEMORY_REL,
  BRAIN_ROLLUP_LEDGER_FILE,
  BRAIN_ROOT_REL,
  BRAIN_SKILL_ACCEPT_JOURNAL_REL,
  BRAIN_SNAPSHOTS_REL,
  BRAIN_STATE_REL,
  DERIVED_STORE_DIR,
  DERIVED_STORE_FILE,
  HOOK_AUDIT_DIR,
} from "../brain/path-constants.ts";
import { CONFIG_ORIGIN, resolveWithOrigin, type ConfigOrigin } from "../validate.ts";

// ----- Vocabularies ---------------------------------------------------------

/**
 * The id of every state surface this build keeps inside a vault.
 *
 * Closed, and spelled as a frozen literal map rather than read back off
 * {@link STATE_SURFACES}, so the ids stay a UNION rather than widening to
 * `string`. It is that union which lets a caller ask for one surface by
 * name and be told at compile time when the name stops existing.
 */
export const STATE_SURFACE_ID = Object.freeze({
  searchIndex: "search_index",
  searchWriterLock: "search_writer_lock",
  searchSessionFocus: "search_session_focus",
  secretCustody: "secret_custody",
  ingestContentManifest: "ingest_content_manifest",
  ingestCheckpoints: "ingest_checkpoints",
  sessionImportLedger: "session_import_ledger",
  installManifest: "install_manifest",
  protectManifest: "protect_manifest",
  maintenanceLease: "maintenance_lease",
  maintenanceJournal: "maintenance_journal",
  hookAudit: "hook_audit",
  hookSessionState: "hook_session_state",
  watchdogAudit: "watchdog_audit",
  injectFailopenCache: "inject_failopen_cache",
  aiderContext: "aider_context_artifact",
  brainLog: "brain_log",
  continuityLedger: "continuity_ledger",
  dreamRuns: "dream_runs",
  prefAudit: "pref_audit",
  recurrenceLedger: "recurrence_ledger",
  queryDemandLedger: "query_demand_ledger",
  captureDecisionLog: "capture_decision_log",
  decisionReceipts: "decision_receipts",
  lineageLedger: "lineage_ledger",
  anticipatoryCache: "anticipatory_cache",
  exactState: "exact_state",
  searchFeedback: "search_feedback",
  searchLearnedWeights: "search_learned_weights",
  searchReinforce: "search_reinforce",
  searchTuning: "search_tuning",
  snapshots: "snapshots",
  mcpArtifacts: "mcp_artifacts",
  metrics: "metrics",
  skillAcceptJournal: "skill_accept_journal",
  claudeMemoryManifest: "claude_memory_manifest",
  claimGraph: "claim_graph",
  rollupLedger: "rollup_ledger",
  proposalWatermark: "proposal_watermark",
  captureWatermark: "capture_watermark",
} as const);

export type StateSurfaceId = (typeof STATE_SURFACE_ID)[keyof typeof STATE_SURFACE_ID];

/** The declared surface ids, in catalogue order. */
export const STATE_SURFACE_IDS: ReadonlyArray<StateSurfaceId> = Object.freeze(
  Object.values(STATE_SURFACE_ID),
);

export function isStateSurfaceId(value: unknown): value is StateSurfaceId {
  return typeof value === "string" && (STATE_SURFACE_IDS as ReadonlyArray<string>).includes(value);
}

/**
 * What losing a surface costs.
 *
 * Two members rather than one bucket because the recovery stories are
 * genuinely different, and the difference is the first thing an operator
 * needs before a migration: a `derived` surface can be deleted and rebuilt
 * from the vault, while `vault-content` is the memory itself and its loss
 * is permanent without a backup.
 *
 * It is a RECOVERY story, not a location. `Brain/.state/anticipatory/` is
 * inside the Markdown tree and is still `derived`, because deleting it
 * costs a recomputation and nothing else; the search index is outside that
 * tree and is `derived` for the same reason. Whether a surface can hold
 * memory CONTENT is the separate {@link StateSurface.carries_memory} axis,
 * as it is in `ownership.ts`.
 */
export const STATE_TIER = Object.freeze({
  derived: "derived",
  vaultContent: "vault-content",
} as const);

export type StateTier = (typeof STATE_TIER)[keyof typeof STATE_TIER];

/** The tiers, most-recoverable first. */
export const STATE_TIERS: ReadonlyArray<StateTier> = Object.freeze([
  STATE_TIER.derived,
  STATE_TIER.vaultContent,
]);

export function isStateTier(value: unknown): value is StateTier {
  return typeof value === "string" && (STATE_TIERS as ReadonlyArray<string>).includes(value);
}

/**
 * What this run could establish about one surface.
 *
 * Modelled on `SearchIndexVerdict`, and for the same reason: a boolean
 * would have to spell "I could not look" as `false`, which reads as "it is
 * not there" at every call site and sends the operator to create something
 * that already exists under a mode they cannot read.
 */
export const STATE_REACHABILITY = Object.freeze({
  present: "present",
  absent: "absent",
  unchecked: "unchecked",
} as const);

export type StateReachability = (typeof STATE_REACHABILITY)[keyof typeof STATE_REACHABILITY];

/** The reachability states, in the order the summary counts them. */
export const STATE_REACHABILITIES: ReadonlyArray<StateReachability> = Object.freeze([
  STATE_REACHABILITY.present,
  STATE_REACHABILITY.absent,
  STATE_REACHABILITY.unchecked,
]);

export function isStateReachability(value: unknown): value is StateReachability {
  return (
    typeof value === "string" && (STATE_REACHABILITIES as ReadonlyArray<string>).includes(value)
  );
}

// ----- The enumeration ------------------------------------------------------

/** One durable location this tool keeps inside a vault. */
export interface StateSurface {
  readonly id: StateSurfaceId;
  /** What it is, as a noun phrase the statement can print. */
  readonly label: string;
  readonly tier: StateTier;
  /**
   * The location, as a pure function of the vault and the resolved
   * override value. Reads nothing; the second argument is `null` when no
   * layer supplied one, exactly as `resolveIndexPath` takes it.
   */
  readonly derive: (vault: string, override: string | null) => string;
  /** The environment variable that MOVES it, or null when nothing can. */
  readonly override_env: string | null;
  /** The machine-config key that MOVES it, or null when nothing can. */
  readonly override_config_key: string | null;
  /** True when this location can hold memory CONTENT rather than plumbing. */
  readonly carries_memory: boolean;
  /** What it holds, and what its absence or loss costs. */
  readonly reason: string;
  /**
   * Repo-relative modules that own this path. A trailing `/` names the
   * modules DIRECTLY IN that directory and not the tree beneath it -
   * unbounded, one such entry would answer for every module under it.
   * `tests/core/architecture/state-surface-census.test.ts` attributes
   * swept path builders through this field, so an anchor that rots fails
   * a test rather than silently orphaning a location.
   */
  readonly sources: ReadonlyArray<string>;
}

// Names the resolvers spell privately. Declared here so the derivations
// below are pure joins; the binding test compares each against the real
// resolver, which is what keeps a copied literal from drifting.
const SEARCH_FOCUS_DIR = "search-focus";
const WRITER_LOCK_SUFFIX = ".lock";
const SECRETS_DIR = "secrets";
const INGEST_MANIFEST_FILE = "ingest-manifest.json";
const INGEST_CHECKPOINT_DIR = "ingest-checkpoints";
const SESSION_LEDGER_FILE = "session-import-ledger.json";
const INSTALL_MANIFEST_FILE = "install.lock.json";
const PROTECT_MANIFEST_FILE = "protect.lock.json";
const MAINTENANCE_LEASE_FILE = "maintenance.sqlite";
const MAINTENANCE_JOURNAL_FILE = "maintenance-runs.jsonl";
const HOOK_STATE_DIR = "hook-state";
const WATCHDOG_AUDIT_DIR = "watchdog-audit";
const INJECT_CACHE_DIR = "inject-cache";
const AIDER_CONTEXT_FILE = "aider-context.md";
const DREAM_RUNS_DIR = "dream-runs";
const PREF_AUDIT_DIR = "pref-audit";
const CONTINUITY_DIR = "continuity";
const RECURRENCE_FILE = "recurrence-support.jsonl";
const QUERY_DEMAND_FILE = "query-demand.jsonl";
const CAPTURE_DECISIONS_FILE = "capture-decisions.jsonl";
const CAPTURE_WATERMARK_FILE = ".catchup-watermark.json";
const PROPOSAL_WATERMARK_FILE = "proposal-watermark.json";
const TRUTH_DIR = "truth";
const BRAIN_INTERNAL_STATE_DIR = ".state";
const LINEAGE_LEDGER_FILE = "session-lineage.jsonl";
const ANTICIPATORY_DIR = "anticipatory";
const SEARCH_STATE_DIR = "search";
const SEARCH_FEEDBACK_DIR = "feedback";
const SEARCH_LEARNED_WEIGHTS_FILE = "learned-weights.json";
const SEARCH_REINFORCE_DIR = "reinforce";
const SEARCH_TUNING_FILE = "tuning.json";
const METRICS_DIR = "metrics";
const IMPORTS_DIR = ".imports";
const CLAUDE_MEMORY_MANIFEST_FILE = "claude-memory.json";

/** Environment variable and config key that move the search store. */
const SEARCH_DB_ENV = "OPEN_SECOND_BRAIN_SEARCH_DB";
const SEARCH_DB_CONFIG_KEY = "search_db_path";

/**
 * Environment variable and config key that select this device's log
 * shard. They do not move a directory; they choose which FILE inside one
 * this machine appends to, which is the same question for an operator
 * looking for their own writes.
 */
const DEVICE_ID_ENV = "O2B_DEVICE_ID";
const DEVICE_ID_CONFIG_KEY = "device_id";

/** The default search store, before any override. */
const defaultIndexPath = (vault: string): string =>
  join(vault, DERIVED_STORE_DIR, DERIVED_STORE_FILE);

/** The resolved search store: the override when there is one. */
function indexPath(vault: string, override: string | null): string {
  if (override !== null) {
    const trimmed = override.trim();
    if (trimmed !== "") return trimmed;
  }
  return defaultIndexPath(vault);
}

/** A location under `<vault>/.open-second-brain/`. */
const derivedStore =
  (...parts: ReadonlyArray<string>) =>
  (vault: string): string =>
    join(vault, DERIVED_STORE_DIR, ...parts);

/** A location under `<vault>/Brain/`. */
const brainTree =
  (...parts: ReadonlyArray<string>) =>
  (vault: string): string =>
    join(vault, BRAIN_ROOT_REL, ...parts);

/** A location under `<vault>/Brain/log/`. */
const brainLog =
  (...parts: ReadonlyArray<string>) =>
  (vault: string): string =>
    join(vault, BRAIN_LOG_REL, ...parts);

/**
 * Every durable location this tool keeps inside a vault.
 *
 * Ordered by root - the derived store first, then the Markdown tree -
 * because that is the order a migration touches them and the order the
 * rendering groups them in.
 */
export const STATE_SURFACES: ReadonlyArray<StateSurface> = Object.freeze([
  {
    id: STATE_SURFACE_ID.searchIndex,
    label: "search index",
    tier: STATE_TIER.derived,
    derive: indexPath,
    override_env: SEARCH_DB_ENV,
    override_config_key: SEARCH_DB_CONFIG_KEY,
    carries_memory: true,
    reason:
      "The SQLite store holding a copy of every indexed chunk, plus the query cache table. " +
      "Rebuildable with `o2b search index`, so nothing is lost by deleting it - but the " +
      "override can put that copy of your vault text anywhere on the machine.",
    sources: ["src/core/search/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchWriterLock,
    label: "search writer lock",
    tier: STATE_TIER.derived,
    derive: (vault, override) => `${indexPath(vault, override)}${WRITER_LOCK_SUFFIX}`,
    override_env: SEARCH_DB_ENV,
    override_config_key: SEARCH_DB_CONFIG_KEY,
    carries_memory: false,
    reason:
      "Held for the duration of an index write and taken over after sixty seconds of silence, " +
      "so a killed writer never wedges the index. It follows the store, because a lock beside " +
      "a database nobody opens guards nothing.",
    sources: ["src/core/search/store/writer-lock.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchSessionFocus,
    label: "per-session search focus",
    tier: STATE_TIER.derived,
    derive: (vault, override) => join(dirname(indexPath(vault, override)), SEARCH_FOCUS_DIR),
    override_env: SEARCH_DB_ENV,
    override_config_key: SEARCH_DB_CONFIG_KEY,
    carries_memory: false,
    reason:
      "One JSON file per session scope pinning a standing query and path prefix, so concurrent " +
      "sessions never clobber each other's focus. Each entry expires on its own; deleting the " +
      "directory only clears whatever focus is currently set.",
    sources: ["src/core/search/session-focus.ts"],
  },
  {
    id: STATE_SURFACE_ID.secretCustody,
    label: "encrypted secret custody",
    tier: STATE_TIER.vaultContent,
    derive: derivedStore(SECRETS_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The encrypted secret store and the keyfile that opens it. Nothing rebuilds this: a vault " +
      "copied without it keeps every memory and loses every secret reference the config resolves " +
      "through it.",
    sources: ["src/core/brain/secrets/store.ts"],
  },
  {
    id: STATE_SURFACE_ID.ingestContentManifest,
    label: "ingest content manifest",
    tier: STATE_TIER.derived,
    derive: derivedStore(INGEST_MANIFEST_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Per-path content digests deciding what an ingest run treats as new, modified, unchanged " +
      "or missing. Deleting it makes the next run re-ingest everything it can still see.",
    sources: ["src/core/brain/ingest/content-manifest.ts"],
  },
  {
    id: STATE_SURFACE_ID.ingestCheckpoints,
    label: "ingest checkpoints",
    tier: STATE_TIER.derived,
    derive: derivedStore(INGEST_CHECKPOINT_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One resume point per ingest plan, so an interrupted batch continues rather than restarts. " +
      "`OSB_INGEST_NO_CHECKPOINT` suppresses writing them; it does not move them.",
    sources: ["src/core/brain/ingest/checkpoint.ts"],
  },
  {
    id: STATE_SURFACE_ID.sessionImportLedger,
    label: "session import ledger",
    tier: STATE_TIER.derived,
    derive: derivedStore(SESSION_LEDGER_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One content digest per agent session log this vault has imported, keyed by its absolute " +
      "path on this machine, so `o2b brain import-session --status` can say what was found and " +
      "what is outstanding without re-parsing anything. Deleting it reports every already- " +
      "imported log as a gap; re-importing them is safe but pays the full parse again.",
    sources: ["src/core/brain/sessions/discover.ts"],
  },
  {
    id: STATE_SURFACE_ID.installManifest,
    label: "install manifest",
    tier: STATE_TIER.derived,
    derive: derivedStore(INSTALL_MANIFEST_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "What each install target wrote and where, so `o2b uninstall --target` removes exactly " +
      "that. Losing it does not break an install; it makes the uninstall unable to prove what " +
      "belongs to this tool.",
    sources: ["src/core/install/manifest.ts"],
  },
  {
    id: STATE_SURFACE_ID.protectManifest,
    label: "protect manifest",
    tier: STATE_TIER.derived,
    derive: derivedStore(PROTECT_MANIFEST_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The managed instruction fences `o2b brain protect` owns, per target. Same shape as the " +
      "install manifest and the same cost: without it `brain unprotect` cannot tell a fence it " +
      "wrote from one an operator typed.",
    sources: ["src/core/brain/protect.ts"],
  },
  {
    id: STATE_SURFACE_ID.maintenanceLease,
    label: "maintenance lease database",
    tier: STATE_TIER.derived,
    derive: derivedStore(MAINTENANCE_LEASE_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "A second SQLite file holding the lease that keeps two maintenance runs off the same vault. " +
      "Deleting it while a run is live removes that guarantee for the length of that run.",
    sources: ["src/core/brain/maintenance/lease.ts"],
  },
  {
    id: STATE_SURFACE_ID.maintenanceJournal,
    label: "maintenance journal",
    tier: STATE_TIER.derived,
    derive: derivedStore(MAINTENANCE_JOURNAL_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The last few hundred maintenance verdicts, capped and rolled. It is the only record of " +
      "why a lane skipped, so deleting it costs the explanation rather than the work.",
    sources: ["src/core/brain/maintenance/journal.ts"],
  },
  {
    id: STATE_SURFACE_ID.hookAudit,
    label: "hook audit trail",
    tier: STATE_TIER.derived,
    derive: derivedStore(HOOK_AUDIT_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One line per hook decision, sharded by ISO week. It is what the doctor check asking " +
      "whether an enabled hook ever ran actually reads, so an empty directory is a real answer " +
      "rather than a missing file.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.hookSessionState,
    label: "per-session hook state",
    tier: STATE_TIER.derived,
    derive: derivedStore(HOOK_STATE_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One JSON file per session scope recording what a hook has already done this session. It " +
      "is scoped to a session by construction, so deleting it re-runs at most one session's " +
      "worth of once-per-session work.",
    sources: ["hooks/lib/session-state.ts"],
  },
  {
    id: STATE_SURFACE_ID.watchdogAudit,
    label: "watchdog audit fallback",
    tier: STATE_TIER.derived,
    derive: derivedStore(WATCHDOG_AUDIT_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Where a watchdog record lands when its configured audit directory refuses the write. It " +
      "exists precisely so a failed audit is still audited; its presence is a signal that the " +
      "primary location could not be written.",
    sources: ["src/core/brain/watchdog.ts"],
  },
  {
    id: STATE_SURFACE_ID.injectFailopenCache,
    label: "injection fail-open cache",
    tier: STATE_TIER.derived,
    derive: derivedStore(INJECT_CACHE_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "The last body each session-start injection successfully rendered, replayed when a live " +
      "render fails. It is a copy of injected vault text, so it holds memory content even " +
      "though nothing is lost by deleting it.",
    sources: ["src/core/brain/inject-failopen.ts"],
  },
  {
    id: STATE_SURFACE_ID.aiderContext,
    label: "Aider context sidecar",
    tier: STATE_TIER.derived,
    derive: derivedStore(AIDER_CONTEXT_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "The Markdown context file the Aider wrapper regenerates before each session and hands to " +
      "the editor. It is a rendered copy of vault text and is rewritten on the next run.",
    sources: ["src/core/install/adapters/aider-wrapper.ts"],
  },
  {
    id: STATE_SURFACE_ID.brainLog,
    label: "Brain event log",
    tier: STATE_TIER.vaultContent,
    derive: (vault) => join(vault, BRAIN_LOG_REL),
    override_env: DEVICE_ID_ENV,
    override_config_key: DEVICE_ID_CONFIG_KEY,
    carries_memory: true,
    reason:
      "The append-only record of everything the agents observed, one page and one JSONL shard " +
      "per day, sharded again per device so two machines syncing one vault never write the same " +
      "file. The device id selects THIS machine's shard; it is memory, and it does not rebuild.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.continuityLedger,
    label: "continuity ledger",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(CONTINUITY_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "One JSONL shard per month recording session handovers, so a new session can pick up what " +
      "the previous one left unfinished. Nothing recomputes a handover that was never written.",
    sources: ["src/core/brain/continuity/store.ts"],
  },
  {
    id: STATE_SURFACE_ID.dreamRuns,
    label: "dream workrun checkpoints",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(DREAM_RUNS_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One durable JSONL per dream invocation, so an interrupted pass resumes at the step it " +
      "reached. Under the log directory on purpose: a backup that covers the log covers these.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.prefAudit,
    label: "preference mutation audit",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(PREF_AUDIT_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "One append-only JSONL per preference recording every promotion, edit and retirement. It " +
      "is the provenance behind a rule the agents follow, and it cannot be reconstructed from " +
      "the preference file it describes.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.recurrenceLedger,
    label: "procedural recurrence ledger",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(RECURRENCE_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Support counts for candidate procedures: how often a sequence recurred before it was " +
      "worth proposing. Deleting it resets the evidence, and the counts only accrue again as " +
      "the work happens again.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.queryDemandLedger,
    label: "query demand ledger",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(QUERY_DEMAND_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "A byte-capped rolling log of recall queries with their coverage, aggregated to surface " +
      "what the vault answers poorly. It carries the queries themselves, which are memory " +
      "content by any reading.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.captureDecisionLog,
    label: "inbound capture decision log",
    tier: STATE_TIER.vaultContent,
    derive: brainLog(CAPTURE_DECISIONS_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "One line per inbound update the capture bot handled - accepted, rejected or malformed - " +
      "so no update is ever silently dropped. It is the only place a rejected capture is " +
      "recorded at all.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.decisionReceipts,
    label: "decision receipts",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(TRUTH_DIR),
    override_env: DEVICE_ID_ENV,
    override_config_key: DEVICE_ID_CONFIG_KEY,
    carries_memory: true,
    reason:
      "Per-device JSONL shards recording every change to a decision, beside the truth ledger " +
      "they belong to. The device id names this machine's shard, and the resolver refuses " +
      "rather than falling back when it cannot be read.",
    sources: ["src/core/brain/decisions/receipts.ts"],
  },
  {
    id: STATE_SURFACE_ID.lineageLedger,
    label: "session lineage ledger",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(BRAIN_INTERNAL_STATE_DIR, LINEAGE_LEDGER_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Which session followed which, plus a companion gap file naming the observations that " +
      "never reached it. It is how a broken chain is detectable at all, so deleting it hides " +
      "gaps rather than closing them.",
    sources: ["src/core/brain/lineage/ledger.ts"],
  },
  {
    id: STATE_SURFACE_ID.anticipatoryCache,
    label: "anticipatory context cache",
    tier: STATE_TIER.derived,
    derive: brainTree(BRAIN_INTERNAL_STATE_DIR, ANTICIPATORY_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Pre-rendered context packs keyed by root and agent scope. Inside the Markdown tree and " +
      "still derived: deleting it costs one recomputation, and every byte in it came from the " +
      "vault it sits in.",
    sources: ["src/core/brain/anticipatory-cache.ts"],
  },
  {
    id: STATE_SURFACE_ID.exactState,
    label: "exact-state lane",
    tier: STATE_TIER.vaultContent,
    derive: (vault) => join(vault, BRAIN_STATE_REL),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Overwrite-only pages holding the current value of one aspect each, where the newest write " +
      "is the whole truth. There is no history behind them, so a lost page is a lost fact.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchFeedback,
    label: "search feedback events",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(SEARCH_STATE_DIR, SEARCH_FEEDBACK_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Which results an agent actually used, recorded per query. It is the observation the " +
      "learned weights are computed FROM, so it is the half of the pair that cannot be " +
      "regenerated.",
    sources: ["src/core/search/feedback.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchLearnedWeights,
    label: "learned ranking weights",
    tier: STATE_TIER.derived,
    derive: brainTree(SEARCH_STATE_DIR, SEARCH_LEARNED_WEIGHTS_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Four multipliers folded out of the feedback events. Deleting it returns ranking to the " +
      "neutral weights and the next feedback pass recomputes it.",
    sources: ["src/core/search/feedback.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchReinforce,
    label: "search reinforcement events",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(SEARCH_STATE_DIR, SEARCH_REINFORCE_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Which vault paths were reinforced by use, per event. Like the feedback lane it is an " +
      "observation of what happened, and nothing replays the sessions that produced it.",
    sources: ["src/core/search/reinforce.ts"],
  },
  {
    id: STATE_SURFACE_ID.searchTuning,
    label: "tuned search parameters",
    tier: STATE_TIER.derived,
    derive: brainTree(SEARCH_STATE_DIR, SEARCH_TUNING_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The parameter point the self-tuning pass selected, re-validated against its grid on every " +
      "read. Deleting it returns search to the shipped defaults until the next tuning run.",
    sources: ["src/core/search/tuning-store.ts"],
  },
  {
    id: STATE_SURFACE_ID.snapshots,
    label: "pre-dream snapshots",
    tier: STATE_TIER.vaultContent,
    derive: (vault) => join(vault, BRAIN_SNAPSHOTS_REL),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Archives of the Markdown tree taken before a destructive pass, and the only thing a " +
      "rollback restores from. They ARE vault content, copied: deleting them removes the " +
      "recovery point, not the current vault.",
    sources: ["src/core/brain/paths.ts", "src/core/brain/snapshot.ts"],
  },
  {
    id: STATE_SURFACE_ID.mcpArtifacts,
    label: "MCP overflow artifacts",
    tier: STATE_TIER.derived,
    derive: (vault) => join(vault, BRAIN_ARTIFACTS_REL),
    override_env: null,
    override_config_key: null,
    carries_memory: true,
    reason:
      "Full payloads of tool results too large for one response, fetched back by artifact id. " +
      "They are copies of what a tool already computed, so deleting them costs a re-run and " +
      "invalidates any id already handed out.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.metrics,
    label: "per-surface metrics",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(METRICS_DIR),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "One append-only JSONL per instrumented surface, timestamped per run. They are " +
      "observations of runs that already finished, so nothing regenerates them.",
    sources: ["src/core/brain/metrics.ts"],
  },
  {
    id: STATE_SURFACE_ID.skillAcceptJournal,
    label: "skill proposal accept journal",
    tier: STATE_TIER.vaultContent,
    derive: (vault) => join(vault, BRAIN_SKILL_ACCEPT_JOURNAL_REL),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "What happened to each skill proposal after review, beside the pending, accepted and " +
      "rejected directories it describes. It is the record of a human decision and has no other " +
      "source.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.claudeMemoryManifest,
    label: "Claude memory import manifest",
    tier: STATE_TIER.derived,
    derive: brainTree(IMPORTS_DIR, CLAUDE_MEMORY_MANIFEST_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "Content digests of everything already imported from the host runtime's own memory " +
      "directory, so an unchanged file is skipped. Deleting it makes the next import re-read " +
      "and re-write what it already has.",
    sources: ["src/core/brain/claude-memory-manifest.ts"],
  },
  {
    id: STATE_SURFACE_ID.claimGraph,
    label: "claim graph projection",
    tier: STATE_TIER.derived,
    derive: brainTree(BRAIN_CLAIM_GRAPH_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "A projection of the claims asserted across the vault's pages, persisted so belief queries " +
      "do not re-walk the tree. It is recomputed from those pages, which are the source of truth.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.rollupLedger,
    label: "rollup ladder ledger",
    tier: STATE_TIER.vaultContent,
    derive: brainTree(BRAIN_ROLLUP_LEDGER_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The counters deciding when accumulated material is consolidated one rung up the ladder. " +
      "They accrue with the work rather than from it, so a reset delays consolidation instead of " +
      "recomputing it.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.proposalWatermark,
    label: "proposal scan watermark",
    tier: STATE_TIER.derived,
    derive: (vault) => join(vault, BRAIN_PROCEDURAL_MEMORY_REL, PROPOSAL_WATERMARK_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "How far the procedural proposal scan has read. Deleting it makes the next scan re-read " +
      "from the beginning, which costs time and re-proposes nothing already accepted.",
    sources: ["src/core/brain/paths.ts"],
  },
  {
    id: STATE_SURFACE_ID.captureWatermark,
    label: "capture catchup watermark",
    tier: STATE_TIER.derived,
    derive: (vault) => join(vault, BRAIN_CAPTURES_REL, CAPTURE_WATERMARK_FILE),
    override_env: null,
    override_config_key: null,
    carries_memory: false,
    reason:
      "The id of the last capture a `/catchup` reply acknowledged. A dot-file so the vault " +
      "walker never indexes it; deleting it replays the acknowledgement, not the captures.",
    sources: ["src/core/brain/paths.ts"],
  },
]);

/**
 * Modules the derived-store sweep finds that leave no surface behind,
 * each with the reason it is not a place an operator will ever find state.
 *
 * The sweep enrols every module under `src/` that NAMES the derived-store
 * directory, so this map is wider than a write-call rule would be and
 * covers three shapes: a module that declares the name, a module that
 * names it only to REFUSE to descend into it, and a module whose path
 * under it is rooted somewhere other than a vault. Anything an operator
 * could still discover inside their vault afterwards belongs in
 * {@link STATE_SURFACES} instead, no matter how small.
 */
export const STATE_SURFACE_SWEEP_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "src/core/brain/path-constants.ts",
    "it DECLARES the directory name and every other vault-relative name in this project. It " +
      "builds no path at all - each constant is a name, and the resolvers that join them are " +
      "the modules attributed above",
  ],
  [
    "src/core/state/surfaces.ts",
    "this module IS the enumeration: the store-directory joins in it are the derivations the " +
      "inventory reports, and it creates nothing - it takes the vault, the environment and the " +
      "config as parameters and returns a value",
  ],
  [
    "src/core/brain/sync-lockfile.ts",
    "it names the store directory only as one of the two roots `scanStaleLocks` WALKS looking " +
      "for abandoned `.lock` files. The locks it finds are created beside whatever is being " +
      "written and removed by the writer that made them, so there is no fixed location for a " +
      "row to name; this module adds none of its own",
  ],
  [
    "src/core/graph/mcp-config.ts",
    "the directory appears in `SKIP_DIRS`, a REFUSAL list: config discovery matches candidate " +
      "directories against it so the derived store is never descended into. A module that " +
      "declines to read a directory creates nothing in it",
  ],
  [
    "src/core/vault-scope/defaults.ts",
    "same shape as the discovery skip list: the directory is a member of " +
      "`DEFAULT_VAULT_IGNORE_PATHS`, so the vault walker never indexes derived state as though " +
      "it were a note. It builds no path and writes nothing anywhere",
  ],
  [
    "src/core/brain/temporal/weekly-brief.ts",
    "the directory is a member of its `SKIPPED_DIR_NAMES` set, beside `.git` and `node_modules`, " +
      "so the weekly walk does not read derived state as vault content. A skipped directory is " +
      "not a surface this module owns",
  ],
  [
    "src/cli/brain/verbs/bench.ts",
    "its `.open-second-brain/bench-runs` default is resolved against the WORKING DIRECTORY, not " +
      "against a vault, so it is not an in-vault surface at all. It is already enumerated as the " +
      "`bench_run_artifacts` row of `OUT_OF_VAULT_STATE`, which is the population that owns " +
      "locations outside the vault",
  ],
]);

// ----- The measured half ----------------------------------------------------

/** What this run established about one surface. */
export interface StateReachabilityVerdict {
  readonly state: StateReachability;
  /** The resolved path the probe was run against. Never null. */
  readonly path: string;
  /** Why it is not present; null exactly when the state is `present`. */
  readonly reason: string | null;
}

/** One catalogue row plus everything this run measured about it. */
export interface StateSurfaceReport {
  readonly id: StateSurfaceId;
  readonly label: string;
  readonly tier: StateTier;
  /** Where it resolved on this machine, after any override. */
  readonly path: string;
  readonly override_env: string | null;
  readonly override_config_key: string | null;
  readonly carries_memory: boolean;
  readonly reason: string;
  readonly reachability: StateReachabilityVerdict;
  /** Which configuration layer produced {@link path}. */
  readonly origin: ConfigOrigin;
}

/** The machine-readable half, and the only input {@link renderStateInventory} takes. */
export interface StateInventory {
  readonly vault: string;
  readonly surfaces: ReadonlyArray<StateSurfaceReport>;
  /** One count per {@link STATE_REACHABILITIES} member, in that order. */
  readonly summary: Readonly<Record<StateReachability, number>>;
}

/** What a probe reports about one path. `undefined` means "not there". */
export interface StatLike {
  readonly isDirectory: () => boolean;
}

export interface StateInventoryInput {
  /** The vault as the canonical resolver answered it, never a raw config key. */
  readonly vault: string;
  /** The environment the overrides are read from. */
  readonly env: NodeJS.ProcessEnv;
  /** The machine config the overrides are read from. */
  readonly config: Readonly<Record<string, string>>;
  /**
   * The filesystem probe. Injected only by tests, which need an `EACCES`
   * they cannot reliably produce as the user running them; every caller
   * in the product uses the default, so the classification below is the
   * one the product runs.
   */
  readonly statAt?: (path: string) => StatLike | undefined;
}

/**
 * The default probe: `undefined` for a missing path, a throw for anything
 * else.
 *
 * The `lstat` fallback is not a detail. `statSync` FOLLOWS a symlink and
 * reports a missing target as ENOENT, so a surface whose root is a
 * dangling link answered `absent` - and `state migrate`, which only walks
 * what is present, skipped it in silence and never reached the `symlink`
 * refusal that knows what to tell the operator about a link. Something IS
 * at that path; saying so is what carries it to the check that can
 * explain it.
 */
function statOrAbsent(path: string): StatLike | undefined {
  return statSync(path, { throwIfNoEntry: false }) ?? lstatSync(path, { throwIfNoEntry: false });
}

/** What an absent surface says. Absent is a state, not a failure. */
const ABSENT_REASON = "nothing has created it in this vault yet";

function probe(
  path: string,
  statAt: (path: string) => StatLike | undefined,
): StateReachabilityVerdict {
  try {
    const stat = statAt(path);
    if (stat === undefined) {
      return { state: STATE_REACHABILITY.absent, path, reason: ABSENT_REASON };
    }
    return { state: STATE_REACHABILITY.present, path, reason: null };
  } catch (error) {
    // The one branch the tri-state exists for. An EACCES on the parent
    // directory, an ELOOP, an EIO from a dying disk: none of them is
    // evidence that the surface is missing, and reporting them as
    // `absent` sends an operator to recreate what is already there.
    const err = error as NodeJS.ErrnoException;
    const code = err.code ?? "unknown error";
    return {
      state: STATE_REACHABILITY.unchecked,
      path,
      reason: `could not be probed (${code}): ${err.message ?? String(error)}`,
    };
  }
}

/**
 * Measure every {@link STATE_SURFACES} row against one vault.
 *
 * One row per declared surface, in catalogue order, always - a surface
 * that could not be probed is reported with an `unchecked` verdict rather
 * than dropped, because a shorter list is the one failure mode an
 * inventory must never have.
 */
export function inventoryStateSurfaces(input: StateInventoryInput): StateInventory {
  const statAt = input.statAt ?? statOrAbsent;
  const surfaces = STATE_SURFACES.map((surface): StateSurfaceReport => {
    const resolved =
      surface.override_env === null || surface.override_config_key === null
        ? { value: null, origin: CONFIG_ORIGIN.default }
        : resolveWithOrigin(
            input.env,
            input.config,
            surface.override_env,
            surface.override_config_key,
          );
    const path = surface.derive(input.vault, movesPath(surface) ? resolved.value : null);
    return {
      id: surface.id,
      label: surface.label,
      tier: surface.tier,
      path,
      override_env: surface.override_env,
      override_config_key: surface.override_config_key,
      carries_memory: surface.carries_memory,
      reason: surface.reason,
      reachability: probe(path, statAt),
      origin: resolved.origin,
    };
  });
  const summary = Object.fromEntries(
    STATE_REACHABILITIES.map((state) => [
      state,
      surfaces.filter((s) => s.reachability.state === state).length,
    ]),
  ) as Record<StateReachability, number>;
  return { vault: input.vault, surfaces, summary: Object.freeze(summary) };
}

/**
 * Whether the override value is a PATH the derivation should use.
 *
 * The device-id override selects a shard filename inside a directory this
 * inventory reports at directory granularity, so feeding it to the
 * derivation would build `<vault>/Brain/<device-id>`. The origin is still
 * reported, because "your log shard is named by an environment variable"
 * is exactly the provenance an operator looking for their own writes
 * needs; only the path substitution is withheld.
 */
function movesPath(surface: StateSurface): boolean {
  return surface.override_env !== DEVICE_ID_ENV;
}

// ----- The rendering --------------------------------------------------------

/** What one tier heading says about the recovery story below it. */
function tierHeading(tier: StateTier): string {
  switch (tier) {
    case STATE_TIER.derived:
      return "derived state - rebuildable from the vault, so deleting it costs time and not memory";
    case STATE_TIER.vaultContent:
      return "vault content - the memory itself, so a loss here is permanent without a backup";
  }
}

/** What one reachability verdict says, with no arm that can read as another. */
function reachabilityLine(verdict: StateReachabilityVerdict): string {
  switch (verdict.state) {
    case STATE_REACHABILITY.present:
      return "present";
    case STATE_REACHABILITY.absent:
      return `absent - ${verdict.reason}`;
    case STATE_REACHABILITY.unchecked:
      return `NOT CHECKED - ${verdict.reason}`;
  }
}

/** What one row says about the layer that placed it. */
function originLine(report: StateSurfaceReport): string {
  switch (report.origin) {
    case CONFIG_ORIGIN.env:
      return `placed by the environment (${report.override_env})`;
    case CONFIG_ORIGIN.userConfig:
      return `placed by the machine config (${report.override_config_key})`;
    case CONFIG_ORIGIN.vaultConfig:
      return `placed by the vault config (${report.override_config_key})`;
    case CONFIG_ORIGIN.default:
      return report.override_env === null
        ? "at its only location - nothing can move it"
        : `at its default location (${report.override_env} / ${report.override_config_key} would move it)`;
  }
}

/**
 * Render the inventory an operator reads.
 *
 * The ONE place the structured value becomes prose, following
 * `renderDataOwnership`: the `vault_health` field and the sentence a
 * person reads are two views of one record rather than two hand-written
 * copies, which is how the install verb's JSON and human outputs drifted
 * before anything tested either.
 */
export function renderStateInventory(inventory: StateInventory): string {
  const carriers = inventory.surfaces.filter((s) => s.carries_memory).length;
  const lines: string[] = [
    `State surfaces in ${inventory.vault}:`,
    `  ${inventory.surfaces.length} declared - ` +
      `${inventory.summary[STATE_REACHABILITY.present]} present, ` +
      `${inventory.summary[STATE_REACHABILITY.absent]} absent, ` +
      `${inventory.summary[STATE_REACHABILITY.unchecked]} not checked. ` +
      `${carriers} of them can hold memory content rather than plumbing.`,
  ];
  for (const tier of STATE_TIERS) {
    const rows = inventory.surfaces.filter((s) => s.tier === tier);
    if (rows.length === 0) continue;
    lines.push("", `  ${tierHeading(tier)}:`);
    for (const row of rows) {
      lines.push(`    - ${row.label} — ${row.path}`);
      lines.push(`      ${reachabilityLine(row.reachability)}; ${originLine(row)}`);
      lines.push(`      ${row.reason}`);
    }
  }
  lines.push(
    "",
    "  This is the catalogue of what this build keeps INSIDE a vault, measured against this one. " +
      "What it can leave outside the vault is a separate question, answered by the ownership " +
      "statement `o2b install --target <t> --apply` prints.",
    "",
  );
  return lines.join("\n");
}
