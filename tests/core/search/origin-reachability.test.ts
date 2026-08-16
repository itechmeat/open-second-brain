/**
 * An unreachable origin is reported, never dropped (a-label-is-not-a-boundary,
 * U5; t_a160764a, t_77efc212).
 *
 * `listSearchOrigins` used to remove a broken recall source from the fan-out
 * before `cross-vault.ts` could see it, so a union over three origins with one
 * dead origin came back as though that origin had honestly contributed
 * nothing. `warnings` was maintained one layer down and could not be
 * populated, because the information was destroyed upstream.
 *
 * The three verdicts are distinct on purpose: `reachable` was read,
 * `unreachable` was looked at and is not there, `unknown` could not be looked
 * at at all. None of the three is a count of zero.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_REACH,
  ORIGIN_REACHES,
  ORIGIN_REACH_REASON,
  ORIGIN_REACH_REASONS,
  isOriginReach,
  isOriginReachReason,
  probeOriginReach,
} from "../../../src/core/brain/portability/origin-reach.ts";
import { listSearchOrigins } from "../../../src/core/brain/portability/origins.ts";
import { addRecallSource } from "../../../src/core/brain/portability/recall-sources.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { searchAcrossVaults } from "../../../src/core/search/cross-vault.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { writeMd } from "../../helpers/search-fixtures.ts";

let tmp: string;
let active: string;
let external: string;
let configPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-origin-reach-"));
  active = join(tmp, "active-vault");
  external = join(tmp, "external-vault");
  mkdirSync(join(active, "Brain"), { recursive: true });
  mkdirSync(join(external, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${active}"\n`);

  writeMd(active, "Brain/notes/local-note.md", "# Local\n\nThe griffin nests in the local vault.");
  writeMd(
    external,
    "Brain/notes/external-note.md",
    "# External\n\nThe griffin also visits the external vault aviary.",
  );
  await indexVault(resolveSearchConfig({ vault: active, configPath }));
  await indexVault(resolveSearchConfig({ vault: external, configPath }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Register a source that existed at registration time and then vanished. */
function registerVanishedSource(alias: string): string {
  const vault = join(tmp, `${alias}-vault`);
  mkdirSync(join(vault, "Brain"), { recursive: true });
  addRecallSource(configPath, active, alias, vault);
  rmSync(vault, { recursive: true, force: true });
  return vault;
}

test("a union across three origins with one unreachable warns by name", async () => {
  addRecallSource(configPath, active, "team", external);
  const gone = registerVanishedSource("gone");

  const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });

  // The two origins that could be read still answer.
  expect(new Set(outcome.results.map((r) => r.origin))).toEqual(new Set(["local", "source/team"]));
  // And the third is NAMED rather than silently absent.
  const warning = outcome.warnings.find((w) => w.includes("source/gone"));
  expect(warning).toBeDefined();
  expect(warning).toContain(ORIGIN_REACH_REASON.vaultMissing);
  // The origin's path never crosses this boundary - the label is the
  // actionable part, and warnings travel verbatim into MCP payloads.
  expect(outcome.warnings.some((w) => w.includes(gone))).toBe(false);
  // The same fact as a code, so a caller does not have to read prose.
  const entry = outcome.retrievalTrail?.degraded.find(
    (d) => d.code === RETRIEVAL_DEGRADATION.crossVaultOriginFailed,
  );
  expect(entry?.detail).toEqual({
    origin: "source/gone",
    cause: ORIGIN_REACH_REASON.vaultMissing,
  });
});

test("listSearchOrigins reports an unreachable origin rather than dropping it", () => {
  addRecallSource(configPath, active, "team", external);
  registerVanishedSource("gone");

  const origins = listSearchOrigins(configPath, active);
  expect(origins.map((o) => o.label)).toEqual(["local", "source/gone", "source/team"]);

  const dead = origins.find((o) => o.label === "source/gone");
  expect(dead?.reach).toBe(ORIGIN_REACH.unreachable);
  expect(dead?.reason).toBe(ORIGIN_REACH_REASON.vaultMissing);
  expect(origins.find((o) => o.label === "local")?.reach).toBe(ORIGIN_REACH.reachable);
  expect(origins.find((o) => o.label === "source/team")?.reason).toBeUndefined();
});

test("unreachable and unknown are different values, and neither reads as zero", async () => {
  const holder = join(tmp, "holder");
  const shielded = join(holder, "shielded-vault");
  mkdirSync(join(shielded, "Brain"), { recursive: true });
  addRecallSource(configPath, active, "shielded", shielded);
  registerVanishedSource("gone");
  // An unreadable parent makes the probe fail with something other than
  // ENOENT: the origin may well be there, and nothing was learned about it.
  chmodSync(holder, 0o000);
  try {
    const origins = listSearchOrigins(configPath, active);
    const unknown = origins.find((o) => o.label === "source/shielded");
    const missing = origins.find((o) => o.label === "source/gone");
    expect(unknown?.reach).toBe(ORIGIN_REACH.unknown);
    expect(missing?.reach).toBe(ORIGIN_REACH.unreachable);
    expect(unknown?.reach).not.toBe(missing?.reach);
    expect(unknown?.reason).toBe(ORIGIN_REACH_REASON.vaultUnreadable);

    const outcome = await searchAcrossVaults(configPath, active, { query: "griffin", limit: 10 });
    // Neither origin contributed a result, and neither is reported as a
    // zero contribution: both are named, each with its own reason.
    expect(outcome.warnings.some((w) => w.includes("source/shielded"))).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("source/gone"))).toBe(true);
    const causes = (outcome.retrievalTrail?.degraded ?? [])
      .filter((d) => d.code === RETRIEVAL_DEGRADATION.crossVaultOriginFailed)
      .map((d) => d.detail?.["cause"]);
    expect(causes).toContain(ORIGIN_REACH_REASON.vaultUnreadable);
  } finally {
    chmodSync(holder, 0o755);
  }
});

test("the shared namespace is enumerable as a read origin", () => {
  const shared = join(tmp, "shared-vault");
  mkdirSync(join(shared, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: "${active}"\nshared_namespace: "${shared}"\n`);

  const origins = listSearchOrigins(configPath, active);
  const sharedOrigin = origins.find((o) => o.kind === "shared");
  expect(sharedOrigin?.label).toBe("shared");
  expect(sharedOrigin?.vault).toBe(shared);
  expect(sharedOrigin?.reach).toBe(ORIGIN_REACH.reachable);
});

test("a shared namespace pointing at the active vault is deduped, not listed twice", () => {
  writeFileSync(configPath, `vault: "${active}"\nshared_namespace: "${active}"\n`);
  expect(listSearchOrigins(configPath, active).map((o) => o.label)).toEqual(["local"]);
});

test("probeOriginReach splits absent, not-a-directory, and could-not-look", () => {
  expect(probeOriginReach(active).reach).toBe(ORIGIN_REACH.reachable);
  expect(probeOriginReach(join(tmp, "never-existed"))).toEqual({
    reach: ORIGIN_REACH.unreachable,
    reason: ORIGIN_REACH_REASON.vaultMissing,
  });
  const file = join(tmp, "a-file");
  writeFileSync(file, "not a vault");
  expect(probeOriginReach(file)).toEqual({
    reach: ORIGIN_REACH.unreachable,
    reason: ORIGIN_REACH_REASON.vaultNotDirectory,
  });
  expect(probeOriginReach(join(file, "under-a-file"))).toEqual({
    reach: ORIGIN_REACH.unreachable,
    reason: ORIGIN_REACH_REASON.vaultNotDirectory,
  });
});

test("the reachability vocabulary is closed in both directions", () => {
  expect([...ORIGIN_REACHES]).toEqual([
    ORIGIN_REACH.reachable,
    ORIGIN_REACH.unreachable,
    ORIGIN_REACH.unknown,
  ]);
  for (const member of ORIGIN_REACHES) expect(isOriginReach(member)).toBe(true);
  for (const member of ORIGIN_REACH_REASONS) expect(isOriginReachReason(member)).toBe(true);
  expect(isOriginReach("reachable-ish")).toBe(false);
  expect(isOriginReach(0)).toBe(false);
  expect(isOriginReachReason(null)).toBe(false);
});
