/**
 * The fixture every file of the migration-gate census shares
 * (`table.ts` holds the census itself).
 *
 * One template is built per test file: the legacy fixture vault of the
 * migration benches with nothing unmapped, a created brain store, the
 * two-owner pages the MCP probe catalogue drives, and an index. Every
 * driven call then runs on a fresh copy of that template (vault, store,
 * state, config and home under one directory), in one of three gate
 * conditions:
 *
 *  - `this-vault`: the migration gate names the copy's vault and is held by
 *    this test process, a live holder;
 *  - `stopped-holder`: the gate names the copy's vault and its holder is a
 *    process that no longer exists (a run that stopped with the gate closed);
 *  - `other-vault`: the gate names another vault (also live);
 *  - `none`: no gate.
 *
 * What a run reports is what the call returned and every entry of the vault
 * (the legacy tree, the per-vault state and the user's own files) that is
 * not byte-identical afterwards.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { regenerateActive } from "../../../../src/core/brain/active.ts";
import { resetFreezeMarkerCache } from "../../../../src/core/brain/freeze-marker.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { migrationGatePath } from "../../../../src/core/migration-gate.ts";
import { processStartIdentity } from "../../../../src/core/store-migration/process-identity.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../../store-migration/fixtures/migration-env.ts";
import { treeEntries } from "../../../helpers/vault-digest.ts";
import {
  HUB_ID,
  NEUTRAL_SIGNAL_SLUG,
  OWNER_A,
  OWNER_B,
  PROBE_TERMS,
  QUERY,
  SHARED_ID,
  SHARED_TITLE,
  SHARED_TOPIC,
} from "../../../helpers/tool-probe-catalogue.ts";

/** The three gate conditions every writer is driven under. */
export const GATE_CONDITION = Object.freeze({
  thisVault: "this-vault",
  /** The gate names the copy's vault and its holder's process is gone. */
  stoppedHolder: "stopped-holder",
  otherVault: "other-vault",
  none: "none",
} as const);

export type GateCondition = (typeof GATE_CONDITION)[keyof typeof GATE_CONDITION];

/** The run id the census gates carry: a migration run's. */
export const CENSUS_RUN_ID = "migrate-20261119T120000000Z";

/** One fresh copy of the template. */
export interface CensusRun {
  readonly dir: string;
  readonly vault: string;
  readonly configPath: string;
  /** The environment the run's commands see (store, state, config, home). */
  readonly env: Readonly<Record<string, string>>;
}

/** What one driven call did. */
export interface RunOutcome<T> {
  readonly value: T;
  /** Vault entries added, removed or changed by the call, sorted. */
  readonly changed: ReadonlyArray<string>;
}

export interface CensusTemplate {
  readonly bench: MigrationBench;
  /**
   * Whether `run` swaps the run's environment into this process (calls made
   * in-process: MCP tools, workers) or leaves `process.env` alone (calls
   * made in child processes, which may then run concurrently).
   */
  readonly inProcess: boolean;
  /** Run `fn` on a fresh copy of the template under `condition`. */
  run<T, S = undefined>(
    condition: GateCondition,
    fn: (run: CensusRun, prepared: S) => Promise<T> | T,
    /** Seeds the copy before the gate is taken and before the "before" listing. */
    prepare?: (run: CensusRun) => S | Promise<S>,
  ): Promise<RunOutcome<T>>;
  cleanup(): void;
}

function makePref(vault: string, slug: string, owner?: string, topic?: string): void {
  writePreference(vault, {
    slug,
    topic: topic ?? (slug === "shared" ? SHARED_TOPIC : slug),
    principle: slug === "shared" ? SHARED_TITLE : `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
  });
}

/** Seed the template vault through the real writers, with no gate. */
function seed(vault: string): void {
  // The legacy fixture carries no settings file and two preference pages in
  // a shape the readers reject; the census needs a vault every verb can open.
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  writeFileSync(join(vault, "AGENTS.md"), "# Agent rules\n\nUse the brain.\n");
  writeFileSync(join(vault, ".open-second-brain", "secrets", "keyfile"), Buffer.alloc(32, 7));
  for (const slug of ["open", "secret"]) {
    rmSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), { force: true });
    makePref(vault, slug);
  }
  makePref(vault, "shared-twin", undefined, SHARED_TOPIC);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "typed.md"),
    "---\ntype: note\nstatus: draft\n---\n\n# Typed\n\nA typed census note.\n",
  );
  writeFileSync(
    join(vault, "notes", "owned-a.md"),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} owned by a\n`,
  );
  writeFileSync(join(vault, "notes", "shared.md"), `# Shared\n\n${QUERY} ${PROBE_TERMS} shared\n`);
  makePref(vault, "shared");
  makePref(vault, "owned-by-a", OWNER_A);
  makePref(vault, HUB_ID.replace(/^pref-/, ""));
  writeSignal(vault, {
    topic: SHARED_TOPIC,
    signal: "positive",
    agent: OWNER_B,
    principle: "A neutral probe signal",
    created_at: "2026-05-03T10:00:00Z",
    date: "2026-05-03",
    slug: NEUTRAL_SIGNAL_SLUG,
  });
  regenerateActive(vault);
  void SHARED_ID;
}

/**
 * Hold the gate for `vault` in the state directory `env` names, with this
 * test process as its live holder. Written directly rather than through
 * `holdMigrationGate`, which reads `process.env`, so runs whose commands
 * are child processes can hold gates side by side.
 */
function holdGateIn(
  env: Readonly<Record<string, string>>,
  vault: string,
  stopped: boolean,
): string {
  const path = migrationGatePath({ platform: process.platform, home: env["HOME"]!, env });
  mkdirSync(join(path, ".."), { recursive: true });
  const holder = stopped
    ? { pid: GONE_PID, started: "census-stopped-holder" }
    : { pid: process.pid, ...(OWN_IDENTITY === null ? {} : { started: OWN_IDENTITY }) };
  const gate = { vault, run_id: CENSUS_RUN_ID, since: new Date().toISOString(), ...holder };
  atomicWriteFileSync(path, `${JSON.stringify(gate, null, 2)}\n`);
  return path;
}

/** A pid no process carries: the holder of a gate whose run stopped. */
const GONE_PID = 2147483646;

/** This process's start identity, recorded in a live gate as a run records its own. */
const OWN_IDENTITY = processStartIdentity(process.pid);

/** Every vault entry whose kind or bytes differ between two listings. */
function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) out.push(key);
  for (const key of before.keys()) if (!after.has(key)) out.push(`-${key}`);
  return out.toSorted();
}

/** Build the template for one test file; `cleanup` removes everything. */
export function makeCensusTemplate(
  prefix: string,
  options: { readonly inProcess?: boolean } = {},
): CensusTemplate {
  const inProcess = options.inProcess !== false;
  const bench = makeMigrationBench(prefix);
  try {
    seed(bench.vault);
  } catch (error) {
    // The bench changed process.env and made a temp tree: undone before the
    // failure goes up, since no caller holds a cleanup handle yet.
    bench.cleanup();
    throw error;
  }
  let next = 0;
  const runsRoot = join(bench.fx.parent, "runs");
  const run = async <T, S = undefined>(
    condition: GateCondition,
    fn: (r: CensusRun, prepared: S) => Promise<T> | T,
    prepare?: (r: CensusRun) => S | Promise<S>,
  ): Promise<RunOutcome<T>> => {
    const dir = join(runsRoot, String(next++));
    const vault = join(dir, "vault");
    const store = join(dir, "store");
    const other = join(dir, "other-vault");
    mkdirSync(join(other, "Brain"), { recursive: true });
    cpSync(bench.vault, vault, { recursive: true });
    cpSync(bench.storeRoot, store, { recursive: true });
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nagent_name: ${OWNER_B}\n`);
    const env: Record<string, string> = {
      ...bench.env,
      [STORE_ROOT_ENV]: store,
      HOME: join(dir, "home"),
      USERPROFILE: join(dir, "home"),
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      LOCALAPPDATA: join(dir, "state"),
      APPDATA: join(dir, "data"),
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      VAULT_DIR: vault,
      // No background worker may outlive a run: the automatic migration and
      // the freshen-on-read indexer stay off, and a captured session event is
      // written inline rather than by a detached worker.
      OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "false",
      OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S: "0",
      OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER: "0",
      // The value `brain secret set --from-env` stores in the census.
      CENSUS_SEALED_VALUE: "census-sealed",
    };
    mkdirSync(env["HOME"]!, { recursive: true });
    const saved = new Map<string, string | undefined>();
    if (inProcess) {
      for (const key of Object.keys(env)) saved.set(key, process.env[key]);
      Object.assign(process.env, env);
    }
    resetFreezeMarkerCache();
    resetVaultIdentityPins();
    const gated = condition === GATE_CONDITION.otherVault ? other : vault;
    const handle: CensusRun = { dir, vault, configPath, env };
    try {
      const prepared = prepare === undefined ? (undefined as S) : await prepare(handle);
      resetVaultIdentityPins();
      if (condition !== GATE_CONDITION.none) {
        holdGateIn(env, gated, condition === GATE_CONDITION.stoppedHolder);
      }
      const before = treeEntries(vault);
      const value = await fn(handle, prepared);
      return { value, changed: diff(before, treeEntries(vault)) };
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetFreezeMarkerCache();
      resetVaultIdentityPins();
      // Retried, and left to the template's own cleanup when it still fails:
      // on Windows a detached child a hook started (a self-heal reindex)
      // can hold a file of the run open for a moment after the hook exits.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // the bench's cleanup removes the whole parent
      }
    }
  };
  return { bench, inProcess, run, cleanup: () => bench.cleanup() };
}
