/**
 * The in-vault state inventory: declaration, measurement, rendering.
 *
 * `STATE_SURFACES` is a declaration, so most of what can go wrong with it
 * is a row that no longer describes the resolver it claims to describe.
 * The binding block below is the guard against exactly that: a row whose
 * owning resolver is EXPORTED is compared against it, so a rename inside
 * `brain/paths.ts` or `search/paths.ts` fails here rather than printing a
 * path nothing writes, and a row whose resolver is PRIVATE is bound by
 * driving the module's own exported writer against a temporary vault and
 * asking whether the artifact landed where the row says it does.
 *
 * Both halves exist because half a guard reads exactly like a whole one.
 * This block bound 26 of the 40 rows and the state-surface census
 * delegated row-path correctness to it in prose, so the other fourteen -
 * the writer lock, the session focus, the protect manifest, the
 * maintenance journal, the watchdog audit fallback, the inject cache, the
 * Aider sidecar, the Brain log, the continuity and lineage ledgers, the
 * anticipatory cache, the metrics tree, the skill accept journal and the
 * Claude memory manifest - were checked by nothing at all: renaming
 * `WATCHDOG_AUDIT_DIR` to a deliberately wrong value left the suite
 * green. Every row is bound now, and the count of deliberate exceptions
 * is itself asserted.
 *
 * The measured half has one rule the whole design turns on: "it is not
 * there" and "I could not look" are different repairs. Both directions
 * are driven below, because a probe that swallows an `EACCES` into
 * `absent` reads exactly like a healthy vault that has not been used yet.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  brainArtifactsDir,
  brainDirs,
  claimGraphPath,
  dreamRunsDir,
  hookAuditDir,
  prefAuditDir,
  proceduralRecurrencePath,
  proposalWatermarkPath,
  queryDemandLogPath,
  rollupLedgerPath,
  skillAcceptJournalPath,
  snapshotsDir,
  brainStateDir,
  captureDecisionLogPath,
  captureWatermarkPath,
} from "../../../src/core/brain/paths.ts";
import { checkpointPath } from "../../../src/core/brain/ingest/checkpoint.ts";
import { manifestPath as ingestManifestPath } from "../../../src/core/brain/ingest/content-manifest.ts";
import { sessionLedgerPath } from "../../../src/core/brain/sessions/discover.ts";
import { secretsDir } from "../../../src/core/brain/secrets/store.ts";
import { manifestPath as installManifestPath } from "../../../src/core/install/manifest.ts";
import { receiptsDir } from "../../../src/core/brain/decisions/receipts.ts";
import { anticipatoryCachePath } from "../../../src/core/brain/anticipatory-cache.ts";
import { continuityLogPath } from "../../../src/core/brain/continuity/store.ts";
import { sessionLineageLedgerPath } from "../../../src/core/brain/lineage/ledger.ts";
import { appendJournal, MAINTENANCE_VERDICT } from "../../../src/core/brain/maintenance/journal.ts";
import { acquireLease, MAINTENANCE_LEASE_NAME } from "../../../src/core/brain/maintenance/lease.ts";
import { appendMetric } from "../../../src/core/brain/metrics.ts";
import { saveManifest as saveClaudeMemoryManifest } from "../../../src/core/brain/claude-memory-manifest.ts";
import { writeInjectCache } from "../../../src/core/brain/inject-failopen.ts";
import { writeManifest as writeProtectManifest } from "../../../src/core/brain/protect.ts";
import { runBrainWatchdog } from "../../../src/core/brain/watchdog.ts";
import { resolveAiderSidecarPath } from "../../../src/core/install/adapters/aider-wrapper.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";
import { feedbackDir, learnedWeightsPath } from "../../../src/core/search/feedback.ts";
import { reinforceDir } from "../../../src/core/search/reinforce.ts";
import { tuningPath } from "../../../src/core/search/tuning-store.ts";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";
import { sessionFocusPath } from "../../../src/core/search/session-focus.ts";
import { acquireWriterLockSync } from "../../../src/core/search/store/writer-lock.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { hookStateFilePath } from "../../../hooks/lib/session-state.ts";
import { CONFIG_ORIGIN } from "../../../src/core/validate.ts";
import {
  inventoryStateSurfaces,
  isStateSurfaceId,
  isStateReachability,
  isStateTier,
  renderStateInventory,
  STATE_REACHABILITIES,
  STATE_REACHABILITY,
  STATE_SURFACE_ID,
  STATE_SURFACE_IDS,
  STATE_SURFACES,
  STATE_TIER,
  STATE_TIERS,
  type StateSurfaceId,
} from "../../../src/core/state/surfaces.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = Object.freeze({});
const EMPTY_CONFIG: Readonly<Record<string, string>> = Object.freeze({});

function tempVault(): string {
  return mkdtempSync(join(tmpdir(), "osb-state-surfaces-"));
}

function row(id: StateSurfaceId) {
  const found = STATE_SURFACES.find((surface) => surface.id === id);
  expect(`${id} is declared: ${found !== undefined}`).toBe(`${id} is declared: true`);
  return found!;
}

function reportFor(vault: string, id: StateSurfaceId) {
  const inventory = inventoryStateSurfaces({ vault, env: EMPTY_ENV, config: EMPTY_CONFIG });
  const found = inventory.surfaces.find((surface) => surface.id === id);
  expect(`${id} is reported: ${found !== undefined}`).toBe(`${id} is reported: true`);
  return found!;
}

describe("the state-surface vocabulary", () => {
  test("the members list and the object agree, and the guard accepts exactly them", () => {
    // `Object.values(STATE_SURFACE_IDS)` compared the array with itself:
    // the array IS `Object.values(STATE_SURFACE_ID)`, so the assertion
    // read `X.toSorted()` against `X.toSorted()` and could not fail. The
    // intended operand is the frozen OBJECT, which is the declaration the
    // list is derived from and the only thing worth comparing it to.
    const values = Object.values(STATE_SURFACE_ID);
    expect([...STATE_SURFACE_IDS].toSorted()).toEqual(values.toSorted());
    for (const id of STATE_SURFACE_IDS) expect(isStateSurfaceId(id)).toBe(true);
    expect(isStateSurfaceId("no_such_surface")).toBe(false);
    expect(isStateSurfaceId(7)).toBe(false);
  });

  test("the tier vocabulary separates rebuildable state from vault content", () => {
    // Two members, and the census below leans on the separation: a
    // derived surface is one an operator may delete, and a vault-content
    // surface is one whose loss is permanent. One bucket would make the
    // inventory unable to say which is which.
    expect([...STATE_TIERS].toSorted()).toEqual([STATE_TIER.derived, STATE_TIER.vaultContent]);
    for (const tier of STATE_TIERS) expect(isStateTier(tier)).toBe(true);
    expect(isStateTier("cache")).toBe(false);
  });

  test("reachability has three members, and unchecked is one of them", () => {
    expect([...STATE_REACHABILITIES].toSorted()).toEqual(
      [
        STATE_REACHABILITY.present,
        STATE_REACHABILITY.absent,
        STATE_REACHABILITY.unchecked,
      ].toSorted(),
    );
    for (const state of STATE_REACHABILITIES) expect(isStateReachability(state)).toBe(true);
    expect(isStateReachability("missing")).toBe(false);
  });

  test("every row is declared once, with a reason a reader can act on", () => {
    const ids = STATE_SURFACES.map((surface) => surface.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids.toSorted()).toEqual([...STATE_SURFACE_IDS].toSorted());
    const thin = STATE_SURFACES.filter((surface) => surface.reason.trim().length < 40).map(
      (surface) => surface.id,
    );
    expect(thin.join("\n")).toBe("");
  });

  test("every declared source exists AND is the kind of thing its spelling claims", () => {
    // An anchor that rots orphans a surface silently; the census attributes
    // swept path builders through this field.
    //
    // The kind check is the second half and it is not decoration: a
    // trailing slash means "the modules in this directory" and a bare
    // name means "this module". `existsSync` alone accepted either
    // spelling for either thing, so `src/core/` and `src/core` were
    // interchangeable to it - and the looser of the two is the one that
    // answers for a whole tree.
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const wrong: string[] = [];
    for (const surface of STATE_SURFACES) {
      expect(`${surface.id} names a source: ${surface.sources.length > 0}`).toBe(
        `${surface.id} names a source: true`,
      );
      for (const source of surface.sources) {
        const directory = source.endsWith("/");
        const abs = join(repoRoot, directory ? source.slice(0, -1) : source);
        if (!existsSync(abs)) {
          wrong.push(`${surface.id}: ${source} does not exist`);
          continue;
        }
        const stat = statSync(abs);
        if (directory && !stat.isDirectory()) {
          wrong.push(`${surface.id}: ${source} ends in a slash but is not a directory`);
        }
        if (!directory && !stat.isFile()) {
          wrong.push(`${surface.id}: ${source} names a module but is not a file`);
        }
      }
    }
    expect(wrong.join("\n")).toBe("");
  });

  test("every derivation stays inside the vault it was handed", () => {
    const vault = "/srv/vaults/example";
    const escaping = STATE_SURFACES.filter(
      (surface) => !surface.derive(vault, null).startsWith(`${vault}/`),
    ).map((surface) => surface.id);
    expect(escaping.join("\n")).toBe("");
  });
});

/**
 * Row id -> the path its owning resolver computes, for every row whose
 * resolver is EXPORTED.
 *
 * A table rather than a list of statements, because the point is no
 * longer only "these rows are right": it is that the set of rows bound
 * here, plus {@link DRIVEN_BINDINGS}, plus {@link UNBOUND_ROWS}, is
 * every row there is. Twenty-six of forty rows were bound when this
 * block was three tests of hand-written expectations, and nothing
 * noticed the other fourteen - renaming `WATCHDOG_AUDIT_DIR` to a
 * deliberately wrong value left the whole suite green, because the
 * census that delegates row-path correctness here only ever checked
 * that a module PATH appeared in some row's `sources`.
 */
const RESOLVER_BINDINGS: ReadonlyArray<readonly [StateSurfaceId, (vault: string) => string]> =
  Object.freeze([
    // --- Under `<vault>/.open-second-brain/` -------------------------------
    ["search_index", (v) => resolveIndexPath(v, null)],
    [
      "search_session_focus",
      // `sessionFocusPath` reads two fields of the resolved search config
      // and nothing else, so the cast supplies exactly those. Building a
      // whole `ResolvedSearchConfig` here would bind this row to the
      // config loader rather than to the resolver that owns its path.
      (v) => dirname(sessionFocusPath({ vault: v, dbPath: "" } as ResolvedSearchConfig, "scope")),
    ],
    ["secret_custody", (v) => secretsDir(v)],
    ["ingest_content_manifest", (v) => ingestManifestPath(v)],
    ["ingest_checkpoints", (v) => dirname(checkpointPath(v, "0f1e2d3c"))],
    ["session_import_ledger", (v) => sessionLedgerPath(v)],
    ["install_manifest", (v) => installManifestPath(v)],
    ["hook_audit", (v) => hookAuditDir(v)],
    ["hook_session_state", (v) => dirname(hookStateFilePath(v, null))],
    ["aider_context_artifact", (v) => resolveAiderSidecarPath({ vault: v } as InstallEnv, {})],
    // --- Under `<vault>/Brain/` --------------------------------------------
    ["brain_log", (v) => brainDirs(v).log],
    ["continuity_ledger", (v) => dirname(continuityLogPath(v, "2026-08"))],
    ["dream_runs", (v) => dreamRunsDir(v)],
    ["pref_audit", (v) => prefAuditDir(v)],
    ["recurrence_ledger", (v) => proceduralRecurrencePath(v)],
    ["query_demand_ledger", (v) => queryDemandLogPath(v)],
    ["capture_decision_log", (v) => captureDecisionLogPath(v)],
    ["capture_watermark", (v) => captureWatermarkPath(v)],
    ["proposal_watermark", (v) => proposalWatermarkPath(v)],
    ["decision_receipts", (v) => receiptsDir(v)],
    ["lineage_ledger", (v) => sessionLineageLedgerPath(v)],
    ["anticipatory_cache", (v) => dirname(anticipatoryCachePath(v, "root-session"))],
    ["exact_state", (v) => brainStateDir(v)],
    ["search_feedback", (v) => feedbackDir(v)],
    ["search_learned_weights", (v) => learnedWeightsPath(v)],
    ["search_reinforce", (v) => reinforceDir(v)],
    ["search_tuning", (v) => tuningPath(v)],
    ["snapshots", (v) => snapshotsDir(v)],
    ["mcp_artifacts", (v) => brainArtifactsDir(v)],
    ["skill_accept_journal", (v) => dirname(skillAcceptJournalPath(v, "probe"))],
    ["claim_graph", (v) => claimGraphPath(v)],
    ["rollup_ledger", (v) => rollupLedgerPath(v)],
  ]);

/**
 * A row whose resolver is module-private, bound by DRIVING the module's
 * own exported writer against a real temporary vault.
 *
 * The comparison is not "something appeared under the vault": that would
 * pass for a row naming any ancestor of the real location. Each entry
 * names the concrete artifact the write produces AS A FUNCTION OF THE
 * ROW'S OWN PATH, so a row pointing one directory up, or at a sibling,
 * has nowhere for that artifact to be.
 */
interface DrivenBinding {
  readonly id: StateSurfaceId;
  /**
   * Make the owning module write, through its exported surface only.
   * Return the path the writer REPORTS having written when it reports
   * one - a report is a stronger binding than "something appeared" -
   * and `null` when it reports nothing.
   */
  readonly drive: (vault: string) => string | null;
  /** The artifact the drive creates, expressed from the row's own path. */
  readonly artifact: (derived: string) => string;
}

const DRIVEN_BINDINGS: ReadonlyArray<DrivenBinding> = Object.freeze([
  {
    // `leaseDbPath` is private; `acquireLease` creates the database.
    id: STATE_SURFACE_ID.maintenanceLease,
    drive: (vault) => {
      acquireLease(vault, {
        name: MAINTENANCE_LEASE_NAME,
        holder: "state-surface-binding",
        ttlMs: 60_000,
        now: new Date("2026-08-16T10:00:00.000Z"),
      });
      return null;
    },
    artifact: (derived) => derived,
  },
  {
    // `journalPath` is private; `appendJournal` writes the JSONL.
    id: STATE_SURFACE_ID.maintenanceJournal,
    drive: (vault) => {
      appendJournal(vault, {
        ts: "2026-08-16T10:00:00.000Z",
        holder: "state-surface-binding",
        verdict: MAINTENANCE_VERDICT.run,
      });
      return null;
    },
    artifact: (derived) => derived,
  },
  {
    // The protect manifest path is private; `writeManifest` is not.
    id: STATE_SURFACE_ID.protectManifest,
    drive: (vault) => {
      writeProtectManifest(vault, {
        schema_version: 1,
        target: "claudecode",
        vault,
        owned_deny: [],
        owned_allow: [],
      });
      return null;
    },
    artifact: (derived) => derived,
  },
  {
    // `cachePath` is private; the row is the DIRECTORY, so the artifact
    // is the cache file the write puts inside it.
    id: STATE_SURFACE_ID.injectFailopenCache,
    drive: (vault) => {
      writeInjectCache(vault, "state-surface-binding", "cached body");
      return null;
    },
    artifact: (derived) => join(derived, "state-surface-binding.txt"),
  },
  {
    // `metricsDir` is private; same directory-plus-artifact shape.
    id: STATE_SURFACE_ID.metrics,
    drive: (vault) => {
      appendMetric(vault, {
        surface: "state_surface_binding",
        runAt: "2026-08-16T10:00:00Z",
        payload: {},
      });
      return null;
    },
    artifact: (derived) => join(derived, "state_surface_binding.jsonl"),
  },
  {
    // `manifestPath` is private; `saveManifest` writes the row's file.
    id: STATE_SURFACE_ID.claudeMemoryManifest,
    drive: (vault) => {
      saveClaudeMemoryManifest(vault, { version: 1, imports: {} });
      return null;
    },
    artifact: (derived) => derived,
  },
  {
    // The FALLBACK the watchdog uses when its configured audit directory
    // refuses the write, so the drive has to make that directory refuse:
    // `Brain/log/watchdog` is pre-created as a FILE, and `mkdirSync` on
    // it throws. `runBrainWatchdog` reports the path it landed on, which
    // is what makes this a comparison and not a sighting.
    id: STATE_SURFACE_ID.watchdogAudit,
    drive: (vault) => {
      const log = brainDirs(vault).log;
      mkdirSync(log, { recursive: true });
      writeFileSync(join(log, "watchdog"), "not a directory", "utf8");
      return runBrainWatchdog(vault).audit_path;
    },
    artifact: (derived) => derived,
  },
  {
    // No resolver at all: the `.lock` suffix is `proper-lockfile`'s, and
    // the only honest way to bind it is to take the lock and look.
    id: STATE_SURFACE_ID.searchWriterLock,
    drive: (vault) => {
      const index = row(STATE_SURFACE_ID.searchIndex).derive(vault, null);
      mkdirSync(dirname(index), { recursive: true });
      acquireWriterLockSync(index);
      return null;
    },
    artifact: (derived) => derived,
  },
]);

/**
 * Rows deliberately left unbound, each with the reason no binding is
 * reachable. An entry here is a decision; the absence of one is not.
 *
 * EMPTY today, and that is the finding: of the fourteen rows nothing
 * bound, every one turned out to have either an exported resolver or an
 * exported writer that reports where it wrote. The map and its count
 * stay because the next row added to the catalogue is the one that will
 * want an excuse, and an excuse should have to be typed.
 */
const UNBOUND_ROWS: ReadonlyMap<StateSurfaceId, string> = new Map();

/** How many rows are deliberately unbound. An equality, so a new one is a decision. */
const UNBOUND_ROW_COUNT = 0;

/** An unbound reason has to be an argument, at the bar the censuses use. */
const MIN_UNBOUND_REASON_LENGTH = 80;

describe("each row is bound to the resolver that owns it", () => {
  const vault = "/srv/vaults/example";

  for (const [id, resolver] of RESOLVER_BINDINGS) {
    test(`${id} derives what its resolver returns`, () => {
      expect(row(id).derive(vault, null)).toBe(resolver(vault));
    });
  }

  test("the search index follows its override, and so does everything derived from it", () => {
    const elsewhere = "/elsewhere/brain.sqlite";
    expect(row("search_index").derive(vault, elsewhere)).toBe(resolveIndexPath(vault, elsewhere));
    expect(row("search_writer_lock").derive(vault, elsewhere)).toBe(`${elsewhere}.lock`);
    expect(row("search_session_focus").derive(vault, elsewhere)).toBe(
      dirname(sessionFocusPath({ vault, dbPath: elsewhere } as ResolvedSearchConfig, "scope")),
    );
  });

  for (const binding of DRIVEN_BINDINGS) {
    test(`${binding.id} is where its own writer puts bytes`, () => {
      const temp = tempVault();
      const derived = row(binding.id).derive(temp, null);
      const artifact = binding.artifact(derived);
      expect(existsSync(artifact)).toBe(false);
      const reported = binding.drive(temp);
      expect(existsSync(artifact)).toBe(true);
      // A writer that names the path it wrote is held to it exactly:
      // either it IS the artifact, or it sits directly in the directory
      // the row declares. Anything else means the row and the writer
      // disagree about where this surface lives.
      if (reported !== null) {
        expect(reported === artifact || dirname(reported) === artifact).toBe(true);
      }
    });
  }

  test("every declared row is bound, or is one of the counted exceptions", () => {
    // The assertion the fourteen unbound rows needed. Without it a new
    // row joins the catalogue bound to nothing, and the census that
    // delegates path correctness to this block keeps saying it is
    // covered here.
    const bound = new Set<string>([
      ...RESOLVER_BINDINGS.map(([id]) => id),
      ...DRIVEN_BINDINGS.map((binding) => binding.id),
    ]);
    const overlap = [...UNBOUND_ROWS.keys()].filter((id) => bound.has(id));
    expect(overlap.join("\n")).toBe("");
    const unaccounted = STATE_SURFACE_IDS.filter((id) => !bound.has(id) && !UNBOUND_ROWS.has(id));
    expect(unaccounted.toSorted().join("\n")).toBe("");
    const stale = [...UNBOUND_ROWS.keys()].filter((id) => !isStateSurfaceId(id));
    expect(stale.join("\n")).toBe("");
    expect(UNBOUND_ROWS.size).toBe(UNBOUND_ROW_COUNT);
  });

  test("every deliberately unbound row says why, at the bar the censuses use", () => {
    const thin = [...UNBOUND_ROWS.entries()]
      .filter(
        ([, reason]) =>
          reason.trim().length < MIN_UNBOUND_REASON_LENGTH ||
          /\bTODO\b|\bfor now\b|\blater\b/i.test(reason),
      )
      .map(([id]) => id);
    expect(thin.join("\n")).toBe("");
  });
});

describe("the measured half", () => {
  test("a surface nothing has written reports absent, with the reason it is absent", () => {
    const report = reportFor(tempVault(), "maintenance_lease");
    expect(report.reachability.state).toBe(STATE_REACHABILITY.absent);
    expect(report.reachability.reason).not.toBeNull();
    expect(report.reachability.path).toBe(report.path);
  });

  test("a surface that exists reports present, with no reason to give", () => {
    const vault = tempVault();
    const path = row("maintenance_lease").derive(vault, null);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", "utf8");
    const report = reportFor(vault, "maintenance_lease");
    expect(report.reachability.state).toBe(STATE_REACHABILITY.present);
    expect(report.reachability.reason).toBeNull();
  });

  test("a dangling symlink is present: something IS there, and it needs a decision", () => {
    // `statSync` follows the link and reports the missing TARGET as
    // ENOENT, so a surface whose root is a broken link read as `absent`
    // and `state migrate` skipped it in silence. Reporting it present is
    // what carries it to the `symlink` refusal, which is the one place
    // that knows what to tell the operator about a link.
    const vault = tempVault();
    const path = row("maintenance_lease").derive(vault, null);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(vault, "nowhere"), path);

    const report = reportFor(vault, "maintenance_lease");
    expect(report.reachability.state).toBe(STATE_REACHABILITY.present);
    expect(report.reachability.reason).toBeNull();
  });

  test("a probe that cannot look reports unchecked, never absent", () => {
    // The whole point of the tri-state. A permission error folded into
    // `absent` tells the operator to create a file that is already there.
    const denied = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    const inventory = inventoryStateSurfaces({
      vault: tempVault(),
      env: EMPTY_ENV,
      config: EMPTY_CONFIG,
      statAt: () => {
        throw denied;
      },
    });
    const states = new Set(inventory.surfaces.map((s) => s.reachability.state));
    expect([...states]).toEqual([STATE_REACHABILITY.unchecked]);
    const sample = inventory.surfaces[0]!;
    expect(sample.reachability.reason).toContain("EACCES");
  });

  test("the inventory reports one row per declared surface, in declaration order", () => {
    const inventory = inventoryStateSurfaces({
      vault: tempVault(),
      env: EMPTY_ENV,
      config: EMPTY_CONFIG,
    });
    expect(inventory.surfaces.map((s) => s.id)).toEqual(STATE_SURFACES.map((s) => s.id));
  });
});

describe("the origin names the layer that placed the path", () => {
  test("an environment override moves the path and is reported as env", () => {
    const vault = tempVault();
    const inventory = inventoryStateSurfaces({
      vault,
      env: { OPEN_SECOND_BRAIN_SEARCH_DB: "/elsewhere/brain.sqlite" },
      config: EMPTY_CONFIG,
    });
    const index = inventory.surfaces.find((s) => s.id === "search_index")!;
    expect(index.path).toBe("/elsewhere/brain.sqlite");
    expect(index.origin).toBe(CONFIG_ORIGIN.env);
    // Everything derived from the index follows it, or the inventory
    // would print a lock file beside a database nobody opens.
    const lock = inventory.surfaces.find((s) => s.id === "search_writer_lock")!;
    expect(lock.path).toBe("/elsewhere/brain.sqlite.lock");
    expect(lock.origin).toBe(CONFIG_ORIGIN.env);
  });

  test("a machine-config key moves the path and is reported as user-config", () => {
    const vault = tempVault();
    const inventory = inventoryStateSurfaces({
      vault,
      env: EMPTY_ENV,
      config: { search_db_path: "/elsewhere/brain.sqlite" },
    });
    const index = inventory.surfaces.find((s) => s.id === "search_index")!;
    expect(index.path).toBe("/elsewhere/brain.sqlite");
    expect(index.origin).toBe(CONFIG_ORIGIN.userConfig);
  });

  test("a row nothing can move reports default, whatever the environment holds", () => {
    const vault = tempVault();
    const inventory = inventoryStateSurfaces({
      vault,
      env: { OPEN_SECOND_BRAIN_SEARCH_DB: "/elsewhere/brain.sqlite" },
      config: { search_db_path: "/elsewhere/brain.sqlite" },
    });
    const drifted = inventory.surfaces
      .filter((s) => s.override_env === null && s.override_config_key === null)
      .filter((s) => s.origin !== CONFIG_ORIGIN.default)
      .map((s) => s.id);
    expect(drifted.join("\n")).toBe("");
  });
});

describe("one value, two renderings", () => {
  test("the rendered statement names every surface it was built from", () => {
    const inventory = inventoryStateSurfaces({
      vault: tempVault(),
      env: EMPTY_ENV,
      config: EMPTY_CONFIG,
    });
    const text = renderStateInventory(inventory);
    const unnamed = inventory.surfaces
      .filter((s) => !text.includes(s.label) || !text.includes(s.path))
      .map((s) => s.id);
    expect(unnamed.join("\n")).toBe("");
  });

  test("the rendering states the vault and the count it measured", () => {
    const vault = tempVault();
    const inventory = inventoryStateSurfaces({ vault, env: EMPTY_ENV, config: EMPTY_CONFIG });
    const text = renderStateInventory(inventory);
    expect(text).toContain(vault);
    expect(text).toContain(String(inventory.surfaces.length));
  });

  test("an unchecked surface is never rendered as an absent one", () => {
    const denied = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    const inventory = inventoryStateSurfaces({
      vault: tempVault(),
      env: EMPTY_ENV,
      config: EMPTY_CONFIG,
      statAt: () => {
        throw denied;
      },
    });
    const text = renderStateInventory(inventory);
    expect(text).toContain("EACCES");
    expect(text).not.toContain("nothing has created it");
  });
});
