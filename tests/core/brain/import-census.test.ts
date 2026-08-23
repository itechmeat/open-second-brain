/**
 * Post-import read-back census (nothing-writes-silently, Unit F).
 *
 * The claims this suite pins:
 *
 *   1. A census NAMES the keys it could not read back. `attempted: 2,
 *      found: 1` with nothing else is the misleading no-op this unit
 *      removes, so the shared reconciliation vocabulary is the only
 *      constructor and a bare count cannot be built.
 *   2. A clean import reports `complete`; one whose items no longer read
 *      back reports `partial` with the losses named.
 *   3. The sessions lane reads back over the dedup hashes the import
 *      already keys its signals on - no second index, no second hash.
 *   4. The ingest lane reads back over the content manifest, and a claimed
 *      path whose recorded hash no longer matches the bytes on disk is not
 *      counted as found. A recorded claim nobody can reproduce is exactly
 *      the gap the census exists to name.
 *   5. A key claimed twice is one claim: the census cannot inflate
 *      `attempted` by repeating itself.
 *   6. The serialized payload both lanes emit is one shape, so a CLI and an
 *      MCP reading of the same census cannot drift.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { computeDedupHash } from "../../../src/core/brain/dedup-hash.ts";
import { updateManifest } from "../../../src/core/brain/ingest/content-manifest.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";
import {
  buildReadBackCensus,
  censusIngestedPaths,
  censusSessionSignals,
  serializeImportCensus,
} from "../../../src/core/brain/import-census.ts";
import { RECONCILIATION_OUTCOME } from "../../../src/core/reconciliation-report.ts";

let vault: string;

const NOW = new Date("2026-08-15T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-import-census-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "config.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** One Claude-format transcript carrying the given turn texts. */
function writeSessionFile(name: string, texts: readonly string[]): string {
  const path = join(vault, name);
  const lines = texts.map((text, index) =>
    JSON.stringify({
      type: "user",
      parentUuid: null,
      entrypoint: "cli",
      uuid: `u${index}`,
      timestamp: "2026-08-15T09:00:00.000Z",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function marker(topic: string, principle: string): string {
  return `@osb feedback positive topic=${topic} principle="${principle}"`;
}

function hashOf(topic: string, principle: string): string {
  return computeDedupHash({ topic, signal: "positive", principle });
}

function inboxFiles(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter((n) => n.endsWith(".md"));
}

function writeVaultFile(rel: string, content: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("buildReadBackCensus", () => {
  test("names every key the read-back could not find and calls the run partial", () => {
    const present = new Set(["a", "c"]);
    const census = buildReadBackCensus(["a", "b", "c", "d"], (key) => present.has(key));
    expect(census.attempted).toBe(4);
    expect(census.found).toBe(2);
    expect([...census.missing]).toEqual(["b", "d"]);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.partial);
  });

  test("a clean read-back is complete with an empty missing list", () => {
    const census = buildReadBackCensus(["a", "b"], () => true);
    expect(census.attempted).toBe(2);
    expect(census.found).toBe(2);
    expect([...census.missing]).toEqual([]);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("a key claimed twice is one claim, so attempted cannot be inflated", () => {
    const census = buildReadBackCensus(["a", "a", "b"], (key) => key === "a");
    expect(census.attempted).toBe(2);
    expect(census.found).toBe(1);
    expect([...census.missing]).toEqual(["b"]);
  });

  test("claiming nothing is complete, not an error", () => {
    const census = buildReadBackCensus([], () => false);
    expect(census.attempted).toBe(0);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("the serialized payload carries the named keys, never a bare count", () => {
    const wire = serializeImportCensus(buildReadBackCensus(["a", "b"], (k) => k === "a"));
    expect(wire).toEqual({
      attempted: 2,
      found: 1,
      missing: ["b"],
      outcome: RECONCILIATION_OUTCOME.partial,
    });
  });
});

describe("censusSessionSignals - the sessions lane reads back its dedup hashes", () => {
  test("every signal the import wrote reads back, and the run is complete", async () => {
    const path = writeSessionFile("s.jsonl", [
      marker("census-one", "Keep the first rule"),
      marker("census-two", "Keep the second rule"),
    ]);
    const result = await importSession(vault, path, { agent: "@t", now: NOW });
    expect(result.signals_created).toBe(2);

    const claimed = [
      hashOf("census-one", "Keep the first rule"),
      hashOf("census-two", "Keep the second rule"),
    ];
    const census = censusSessionSignals(vault, claimed);
    expect(census.attempted).toBe(2);
    expect(census.found).toBe(2);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("a signal removed after the write is named by its hash, not merely counted", async () => {
    const path = writeSessionFile("s.jsonl", [
      marker("census-one", "Keep the first rule"),
      marker("census-two", "Keep the second rule"),
    ]);
    await importSession(vault, path, { agent: "@t", now: NOW });

    // The synthetic loss: one signal disappears between the write and the
    // read-back, which is precisely the case a bare counter reports as fine.
    const victim = inboxFiles().find((n) => n.includes("census-two"));
    expect(victim).toBeDefined();
    unlinkSync(join(brainDirs(vault).inbox, victim!));

    const lost = hashOf("census-two", "Keep the second rule");
    const census = censusSessionSignals(vault, [hashOf("census-one", "Keep the first rule"), lost]);
    expect(census.attempted).toBe(2);
    expect(census.found).toBe(1);
    expect([...census.missing]).toEqual([lost]);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.partial);
  });

  test("the import result carries the census of what it claims to have written", async () => {
    const path = writeSessionFile("s.jsonl", [marker("census-rides", "Ride the result")]);
    const result = await importSession(vault, path, { agent: "@t", now: NOW });
    expect(result.census.attempted).toBe(result.signals_created);
    expect(result.census.found).toBe(1);
    expect([...result.census.missing]).toEqual([]);
    expect(result.census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("a dry run claims nothing, so its census is complete over zero", async () => {
    const path = writeSessionFile("s.jsonl", [marker("census-dry", "Rehearse only")]);
    const result = await importSession(vault, path, { agent: "@t", dryRun: true, now: NOW });
    expect(result.signals_created).toBe(0);
    expect(result.census.attempted).toBe(0);
    expect(result.census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });
});

describe("censusIngestedPaths - the ingest lane reads back its content hashes", () => {
  test("paths the manifest still confirms are found", () => {
    writeVaultFile("Docs/a.md", "alpha\n");
    writeVaultFile("Docs/b.md", "beta\n");
    updateManifest(vault, ["Docs/a.md", "Docs/b.md"]);

    const census = censusIngestedPaths(vault, ["Docs/a.md", "Docs/b.md"]);
    expect(census.attempted).toBe(2);
    expect(census.found).toBe(2);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("a claimed path deleted after the write is named", () => {
    writeVaultFile("Docs/a.md", "alpha\n");
    writeVaultFile("Docs/b.md", "beta\n");
    updateManifest(vault, ["Docs/a.md", "Docs/b.md"]);
    unlinkSync(join(vault, "Docs/b.md"));

    const census = censusIngestedPaths(vault, ["Docs/a.md", "Docs/b.md"]);
    expect(census.found).toBe(1);
    expect([...census.missing]).toEqual(["Docs/b.md"]);
    expect(census.outcome).toBe(RECONCILIATION_OUTCOME.partial);
  });

  test("a claimed path the manifest never recorded is missing, not silently fine", () => {
    writeVaultFile("Docs/a.md", "alpha\n");
    writeVaultFile("Docs/b.md", "beta\n");
    updateManifest(vault, ["Docs/a.md"]);

    const census = censusIngestedPaths(vault, ["Docs/a.md", "Docs/b.md"]);
    expect([...census.missing]).toEqual(["Docs/b.md"]);
  });

  test("a claimed path whose bytes no longer match the recorded hash is missing", () => {
    writeVaultFile("Docs/a.md", "alpha\n");
    updateManifest(vault, ["Docs/a.md"]);
    writeVaultFile("Docs/a.md", "alpha rewritten\n");

    const census = censusIngestedPaths(vault, ["Docs/a.md"]);
    expect(census.found).toBe(0);
    expect([...census.missing]).toEqual(["Docs/a.md"]);
  });
});
