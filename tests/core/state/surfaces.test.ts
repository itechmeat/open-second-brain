/**
 * The in-vault state inventory: declaration, measurement, rendering.
 *
 * `STATE_SURFACES` is a declaration, so most of what can go wrong with it
 * is a row that no longer describes the resolver it claims to describe.
 * The binding block below is the guard against exactly that: every row
 * whose owning resolver is exported is compared against it, so a rename
 * inside `brain/paths.ts` or `search/paths.ts` fails here rather than
 * printing a path nothing writes.
 *
 * The measured half has one rule the whole design turns on: "it is not
 * there" and "I could not look" are different repairs. Both directions
 * are driven below, because a probe that swallows an `EACCES` into
 * `absent` reads exactly like a healthy vault that has not been used yet.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  brainArtifactsDir,
  claimGraphPath,
  dreamRunsDir,
  hookAuditDir,
  prefAuditDir,
  proceduralRecurrencePath,
  proposalWatermarkPath,
  queryDemandLogPath,
  rollupLedgerPath,
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
import { feedbackDir, learnedWeightsPath } from "../../../src/core/search/feedback.ts";
import { reinforceDir } from "../../../src/core/search/reinforce.ts";
import { tuningPath } from "../../../src/core/search/tuning-store.ts";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";
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
    const values = Object.values(STATE_SURFACE_IDS);
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

  test("every declared source module exists", () => {
    // An anchor that rots orphans a surface silently; the census attributes
    // swept path builders through this field.
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const missing: string[] = [];
    for (const surface of STATE_SURFACES) {
      expect(`${surface.id} names a source: ${surface.sources.length > 0}`).toBe(
        `${surface.id} names a source: true`,
      );
      for (const source of surface.sources) {
        const abs = join(repoRoot, source.endsWith("/") ? source.slice(0, -1) : source);
        if (!existsSync(abs)) missing.push(`${surface.id}: ${source}`);
      }
    }
    expect(missing.join("\n")).toBe("");
  });

  test("every derivation stays inside the vault it was handed", () => {
    const vault = "/srv/vaults/example";
    const escaping = STATE_SURFACES.filter(
      (surface) => !surface.derive(vault, null).startsWith(`${vault}/`),
    ).map((surface) => surface.id);
    expect(escaping.join("\n")).toBe("");
  });
});

describe("each row is bound to the resolver that owns it", () => {
  const vault = "/srv/vaults/example";

  test("the derived-store rows match their resolvers", () => {
    expect(row("search_index").derive(vault, null)).toBe(resolveIndexPath(vault, null));
    expect(row("search_index").derive(vault, "/elsewhere/brain.sqlite")).toBe(
      resolveIndexPath(vault, "/elsewhere/brain.sqlite"),
    );
    expect(row("secret_custody").derive(vault, null)).toBe(secretsDir(vault));
    expect(row("ingest_content_manifest").derive(vault, null)).toBe(ingestManifestPath(vault));
    expect(row("ingest_checkpoints").derive(vault, null)).toBe(
      dirname(checkpointPath(vault, "0f1e2d3c")),
    );
    expect(row("session_import_ledger").derive(vault, null)).toBe(sessionLedgerPath(vault));
    expect(row("install_manifest").derive(vault, null)).toBe(installManifestPath(vault));
    expect(row("hook_audit").derive(vault, null)).toBe(hookAuditDir(vault));
    expect(row("hook_session_state").derive(vault, null)).toBe(
      dirname(hookStateFilePath(vault, null)),
    );
  });

  test("the Brain rows match their resolvers", () => {
    expect(row("dream_runs").derive(vault, null)).toBe(dreamRunsDir(vault));
    expect(row("pref_audit").derive(vault, null)).toBe(prefAuditDir(vault));
    expect(row("recurrence_ledger").derive(vault, null)).toBe(proceduralRecurrencePath(vault));
    expect(row("query_demand_ledger").derive(vault, null)).toBe(queryDemandLogPath(vault));
    expect(row("capture_decision_log").derive(vault, null)).toBe(captureDecisionLogPath(vault));
    expect(row("capture_watermark").derive(vault, null)).toBe(captureWatermarkPath(vault));
    expect(row("proposal_watermark").derive(vault, null)).toBe(proposalWatermarkPath(vault));
    expect(row("decision_receipts").derive(vault, null)).toBe(receiptsDir(vault));
    expect(row("exact_state").derive(vault, null)).toBe(brainStateDir(vault));
    expect(row("snapshots").derive(vault, null)).toBe(snapshotsDir(vault));
    expect(row("mcp_artifacts").derive(vault, null)).toBe(brainArtifactsDir(vault));
    expect(row("claim_graph").derive(vault, null)).toBe(claimGraphPath(vault));
    expect(row("rollup_ledger").derive(vault, null)).toBe(rollupLedgerPath(vault));
    expect(row("search_feedback").derive(vault, null)).toBe(feedbackDir(vault));
    expect(row("search_learned_weights").derive(vault, null)).toBe(learnedWeightsPath(vault));
    expect(row("search_reinforce").derive(vault, null)).toBe(reinforceDir(vault));
    expect(row("search_tuning").derive(vault, null)).toBe(tuningPath(vault));
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
