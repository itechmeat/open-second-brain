/**
 * `o2b brain co-occurrence` (Recall & Working-Memory Quality Suite,
 * t_7a632707): structural co-occurrence suggestions over the wikilink
 * graph, read-only by default, optionally persisted with --write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cooccurrence-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  writeNote("notes/m1.md", "# M1\n\nSee [[alpha]] and [[beta]].\n");
  writeNote("notes/m2.md", "# M2\n\nAlso [[alpha]] with [[beta]].\n");
  writeNote("notes/m3.md", "# M3\n\nDifferent [[gamma]] and [[delta]].\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain co-occurrence", () => {
  test("suggests the co-referenced pair as JSON", async () => {
    const out = await runCli(["brain", "co-occurrence", "--min-co", "2", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      suggestions: Array<{ left: string; right: string; coDocumentCount: number }>;
    };
    const pair = parsed.suggestions.find((s) => s.left === "alpha" && s.right === "beta");
    expect(pair).toBeDefined();
    expect(pair!.coDocumentCount).toBe(2);
  });

  test("--write persists the suggestions artifact", async () => {
    const out = await runCli(["brain", "co-occurrence", "--min-co", "2", "--write", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(existsSync(join(vault, "Brain", "link-graph", "co-occurrence.json"))).toBe(true);
  });

  test("a bad --min-co fails with a usage error", async () => {
    const bad = await runCli(["brain", "co-occurrence", "--min-co", "-1"], { env: env() });
    expect(bad.returncode).not.toBe(0);
  });
});
