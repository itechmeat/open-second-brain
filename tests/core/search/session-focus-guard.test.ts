import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearSessionFocus,
  normalizeSessionFocus,
  readSessionFocus,
  sessionFocusPath,
  writeSessionFocus,
} from "../../../src/core/search/session-focus.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

const NOW = 1_750_000_000_000;

let temp: ReturnType<typeof createTempVault>;
let outside: string;

beforeEach(() => {
  temp = createTempVault("session-focus-guard");
  outside = mkdtempSync(join(tmpdir(), "osb-focus-guard-outside-"));
});

afterEach(() => {
  temp.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

function config() {
  return makeConfig({ vault: temp.vault, dbPath: temp.dbPath });
}

function focus() {
  return normalizeSessionFocus({ query: "release", ttlMinutes: 30 }, NOW);
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .toSorted();
}

const PLANTED = JSON.stringify({ query: "planted", pathPrefix: null, expiresAt: NOW + 60_000 });

describe.each([undefined, "sess-1"])("session focus (scope %p)", (scope) => {
  test("a real directory is written and read back", () => {
    writeSessionFocus(config(), focus(), scope);
    expect(readSessionFocus(config(), NOW, scope)?.query).toBe("release");
    if (!IS_WINDOWS) {
      expect(statSync(sessionFocusPath(config(), scope)).mode & 0o777).toBe(0o600);
    }
  });

  test.skipIf(IS_WINDOWS)(
    "a symlinked .open-second-brain is neither read, written nor cleared",
    () => {
      const plantedPath =
        scope === undefined
          ? join(outside, "search-focus.json")
          : join(outside, "search-focus", `${scope}.json`);
      mkdirSync(join(plantedPath, ".."), { recursive: true });
      writeFileSync(plantedPath, PLANTED);
      const before = listTree(outside);
      symlinkSync(outside, join(temp.vault, ".open-second-brain"), "dir");

      expect(readSessionFocus(config(), NOW, scope)).toBeNull();
      expect(() => writeSessionFocus(config(), focus(), scope)).toThrow();
      clearSessionFocus(config(), scope);
      expect(listTree(outside)).toEqual(before);
      expect(readFileSync(plantedPath, "utf8")).toBe(PLANTED);
    },
  );

  test.skipIf(IS_WINDOWS)("a focus file that is itself a link is not followed", () => {
    const victim = join(outside, "victim.json");
    writeFileSync(victim, PLANTED);
    const path = sessionFocusPath(config(), scope);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(victim, path);

    expect(readSessionFocus(config(), NOW, scope)).toBeNull();
    writeSessionFocus(config(), focus(), scope);
    expect(readFileSync(victim, "utf8")).toBe(PLANTED);
    expect(readSessionFocus(config(), NOW, scope)?.query).toBe("release");
  });
});

test.skipIf(IS_WINDOWS)("a symlinked search-focus directory is neither read nor written", () => {
  mkdirSync(join(temp.vault, ".open-second-brain"), { recursive: true });
  writeFileSync(join(outside, "sess-1.json"), PLANTED);
  const before = listTree(outside);
  symlinkSync(outside, join(temp.vault, ".open-second-brain", "search-focus"), "dir");

  expect(readSessionFocus(config(), NOW, "sess-1")).toBeNull();
  expect(() => writeSessionFocus(config(), focus(), "sess-1")).toThrow();
  clearSessionFocus(config(), "sess-1");
  expect(listTree(outside)).toEqual(before);
});
