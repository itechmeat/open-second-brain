/**
 * The hook launcher stays out of a dream session (change
 * `dream-launched-agent`, design D2; spec "The session is kept apart",
 * task 1.1): with the marker in its environment, `scripts/o2b-hook`
 * exits 0 before it runs any hook file. One row per hook name of
 * `hooks/hooks.json`, each against a temp home and a temp plugin root
 * whose hook file would write a sentinel.
 *
 * `bin/o2b-hook.js` (the registry launcher) is not in this branch.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDirs } from "../helpers/temp-dir.ts";

const mkTemp = tempDirs();
const ROOT = join(import.meta.dir, "..", "..");
const LAUNCHER = join(ROOT, "scripts", "o2b-hook");

function hookNames(): string[] {
  const text = readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8");
  return [...new Set([...text.matchAll(/o2b-hook\\?" ([a-z-]+);/g)].map((m) => m[1]!))].toSorted();
}

function runHook(name: string, marker: boolean): boolean {
  const home = mkTemp("o2b-marker-home-");
  const plugin = mkTemp("o2b-marker-plugin-");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  const sentinel = join(home, "ran");
  writeFileSync(
    join(plugin, "hooks", `${name}.ts`),
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "x");\n`,
  );
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    CLAUDE_PLUGIN_ROOT: plugin,
    ...(marker ? { OPEN_SECOND_BRAIN_DREAM_RUN: "0b0c3a2e-1111-4222-8333-444455556666" } : {}),
  };
  const result = Bun.spawnSync(["bash", LAUNCHER, name], { env, stdin: "ignore" });
  expect(result.exitCode).toBe(0);
  return existsSync(sentinel);
}

describe.skipIf(process.platform === "win32")("o2b-hook with the dream marker", () => {
  const names = hookNames();
  test("hooks.json names hooks", () => {
    expect(names.length).toBeGreaterThan(5);
  });
  for (const name of names) {
    test(`${name}: nothing runs with the marker, the hook runs without it`, () => {
      expect(runHook(name, true)).toBe(false);
      expect(runHook(name, false)).toBe(true);
    });
  }
});
