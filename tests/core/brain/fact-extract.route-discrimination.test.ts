/**
 * Route discrimination inside the write router (signals-that-survive, unit 3).
 *
 * `routeExtractedFacts` scores its candidate routes before it writes. When
 * the top two are within the margin the rule ladder separates them and the
 * decision is emitted as a gated `route_discrimination` continuity record.
 * With the gate key absent the routing is byte-identical and nothing is
 * recorded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { routeExtractedFacts, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import { ROUTE_DISCRIMINATION_RECORD_KIND } from "../../../src/core/brain/routing/route-discriminator.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

const NOW = new Date("2026-07-18T12:00:00Z");

/**
 * A span two routes claim over the same number of characters: the `email`
 * pattern covers `a@b.co`, the `quantity` pattern covers `50 USD`, neither
 * range contains the other. Every ladder rule above the terminal one ties.
 */
const AMBIGUOUS_FACT: ExtractedFact = { family: "email", text: "a@b.co 50 USD", line: 1 };
/** A span only one route claims - no discrimination can fire. */
const UNAMBIGUOUS_FACT: ExtractedFact = { family: "url", text: "https://techmeat.dev", line: 1 };

const temps: string[] = [];
const savedConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];

function makeVault(configBody = ""): string {
  const vault = mkdtempSync(join(tmpdir(), "o2b-route-disc-vault-"));
  const configHome = mkdtempSync(join(tmpdir(), "o2b-route-disc-cfg-"));
  temps.push(vault, configHome);
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n${configBody}`);
  bootstrapBrain(vault, { configPath });
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  return vault;
}

function inboxDocs(vault: string): Array<{ name: string; body: string }> {
  const dir = brainDirs(vault).inbox;
  return readdirSync(dir)
    .filter((f) => f.startsWith("sig-") && f.endsWith(".md"))
    .toSorted()
    .map((name) => ({ name, body: readFileSync(join(dir, name), "utf8") }));
}

function route(vault: string, facts: ReadonlyArray<ExtractedFact>, dryRun = false) {
  return routeExtractedFacts(vault, {
    facts,
    agent: "claude-dev-agent",
    now: NOW,
    sessionRef: "session#turn-1",
    dedup: new Map<string, DedupIndexEntry>(),
    ...(dryRun ? { dryRun: true } : {}),
  });
}

function discriminationRecords(vault: string) {
  return listContinuityRecords(vault, { kind: ROUTE_DISCRIMINATION_RECORD_KIND });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfigEnv;
});

describe("routeExtractedFacts route discrimination - gate absent", () => {
  test("writes no record and routes exactly as the family table does", () => {
    const vault = makeVault();
    const result = route(vault, [AMBIGUOUS_FACT]);
    expect(result.created).toBe(1);
    expect(discriminationRecords(vault)).toHaveLength(0);
    expect(inboxDocs(vault)[0]!.body).toContain("topic: fact-email");
  });

  test("the written signal is byte-identical with the gate on", () => {
    const off = makeVault();
    route(off, [AMBIGUOUS_FACT]);
    const offDoc = inboxDocs(off)[0]!;

    const on = makeVault("route_discrimination_enabled: true\n");
    route(on, [AMBIGUOUS_FACT]);
    const onDoc = inboxDocs(on)[0]!;

    expect(onDoc.name).toBe(offDoc.name);
    expect(onDoc.body).toBe(offDoc.body);
    expect(discriminationRecords(on)).toHaveLength(1);
  });
});

describe("routeExtractedFacts route discrimination - gate set", () => {
  test("one record per discrimination, carrying the decision and no fact text", () => {
    const vault = makeVault("route_discrimination_enabled: true\n");
    route(vault, [AMBIGUOUS_FACT]);

    const records = discriminationRecords(vault);
    expect(records).toHaveLength(1);
    const payload = records[0]!.payload;
    expect(payload["origin"]).toBe("email");
    expect(payload["route"]).toBe("email");
    expect(payload["rule"]).toBe("family-table-order");
    expect(payload["margin"]).toBe(0);
    expect(payload["candidates"]).toEqual([
      { route: "email", score: expect.any(Number) },
      { route: "quantity", score: expect.any(Number) },
    ]);

    const serialised = JSON.stringify(payload);
    for (const fragment of ["a@b.co", "50 USD", "USD", "@"]) {
      expect(serialised).not.toContain(fragment);
    }
  });

  test("an unambiguous span produces no record", () => {
    const vault = makeVault("route_discrimination_enabled: true\n");
    const result = route(vault, [UNAMBIGUOUS_FACT]);
    expect(result.created).toBe(1);
    expect(discriminationRecords(vault)).toHaveLength(0);
  });

  test("a dry run records nothing", () => {
    const vault = makeVault("route_discrimination_enabled: true\n");
    const result = route(vault, [AMBIGUOUS_FACT], true);
    expect(result.created).toBe(0);
    expect(discriminationRecords(vault)).toHaveLength(0);
  });

  test("an injected gate wins over the config", () => {
    const vault = makeVault();
    routeExtractedFacts(vault, {
      facts: [AMBIGUOUS_FACT],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-1",
      dedup: new Map<string, DedupIndexEntry>(),
      routeDiscriminationEnabled: true,
    });
    expect(discriminationRecords(vault)).toHaveLength(1);
  });

  test("a failing record never aborts the capture", () => {
    // The continuity append is fail-open: a vault whose Brain log directory
    // cannot be written must still capture the fact.
    const vault = makeVault("route_discrimination_enabled: true\n");
    rmSync(join(vault, "Brain", "log"), { recursive: true, force: true });
    atomicWriteFileSync(join(vault, "Brain", "log"), "not a directory\n");
    const result = route(vault, [AMBIGUOUS_FACT]);
    expect(result.created).toBe(1);
  });
});
