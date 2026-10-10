/**
 * The consent-off import reports what it withheld (Task 11 / L8).
 *
 * `routeExtractedFacts` counts and logs every capture its ambient consent
 * boundary suppresses, but the sessions import result used to drop that
 * count: with `guardrails.ambient_writeback: false` in force, an import
 * reported `facts_extracted: 0` and no reason - a number that reads
 * exactly like "nothing durable in this transcript". The result now
 * carries `facts_ambient_withheld`, beside the sibling fact counters, so
 * the operator sees the lane was closed rather than quiet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let tmp: string;
let vault: string;

const NOW = new Date("2026-08-15T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ambient-import-"));
  vault = join(tmp, "vault");
  const configHome = join(tmp, "config");
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Overwrite the vault `_brain.yaml` with a minimal config carrying the
 * given guardrails sub-key lines (`key: value` shape, unprefixed).
 */
function writeVaultGuardrails(...subKeys: string[]): void {
  const lines = ["schema_version: 1", ""];
  if (subKeys.length > 0) {
    lines.push("guardrails:", ...subKeys.map((k) => `  ${k}`), "");
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), lines.join("\n"), "utf8");
}

/** One Claude-format transcript file with the given user texts. */
function writeSessionFile(name: string, texts: readonly string[]): string {
  const path = join(tmp, name);
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

function inboxSignalCount(): number {
  return readdirSync(brainDirs(vault).inbox).filter((n) => n.startsWith("sig-")).length;
}

describe("importSession - the ambient withheld count", () => {
  test("a consent-off import reports 0 facts written and the withheld count", async () => {
    writeVaultGuardrails("ambient_writeback: false");
    const path = writeSessionFile("consent-off.jsonl", [
      "pin the staging URL https://osb.example/run",
    ]);

    const result = await importSession(vault, path, { agent: "claude", now: NOW });

    expect(result.facts_extracted).toBe(0);
    expect(result.facts_ambient_withheld).toBe(1);
    expect(result.facts_withheld).toBe(0);
    expect(inboxSignalCount()).toBe(0);
  });

  test("the count accumulates across every suppressed capture in the file", async () => {
    writeVaultGuardrails("ambient_writeback: false");
    const path = writeSessionFile("two-turns.jsonl", [
      "pin the staging URL https://osb.example/run",
      "mail the report to qa@example.com or ops@example.com",
    ]);

    const result = await importSession(vault, path, { agent: "claude", now: NOW });

    // One capture per USER turn: 1 fact + 2 facts, each withheld whole.
    expect(result.facts_ambient_withheld).toBe(3);
    expect(result.facts_extracted).toBe(0);
  });

  test("a consent-off dry run forecasts the withheld count too", async () => {
    writeVaultGuardrails("ambient_writeback: false");
    const path = writeSessionFile("rehearsal.jsonl", [
      "pin the staging URL https://osb.example/run",
    ]);

    const result = await importSession(vault, path, { agent: "claude", now: NOW, dryRun: true });

    expect(result.facts_ambient_withheld).toBe(1);
    expect(result.facts_withheld).toBe(0);
  });

  test("with consent on the count is 0 and the facts land", async () => {
    const path = writeSessionFile("consent-on.jsonl", [
      "pin the staging URL https://osb.example/run",
    ]);

    const result = await importSession(vault, path, { agent: "claude", now: NOW });

    expect(result.facts_extracted).toBe(1);
    expect(result.facts_ambient_withheld).toBe(0);
    expect(inboxSignalCount()).toBe(1);
  });
});
