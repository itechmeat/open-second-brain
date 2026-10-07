import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadInjectContextFailOpen,
  readInjectCache,
  writeInjectCache,
} from "../../../src/core/brain/inject-failopen.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";

let vault: string;
let outside: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-failopen-guard-vault-"));
  outside = mkdtempSync(join(tmpdir(), "osb-failopen-guard-outside-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .toSorted();
}

async function degradedLoad(): Promise<{ context: string; source: string }> {
  const res = await loadInjectContextFailOpen({
    vault,
    key: "active",
    assemble: () => {
      throw new Error("assembly failed");
    },
  });
  return { context: res.context, source: res.source };
}

test("a real inject-cache directory is read and written", async () => {
  writeInjectCache(vault, "active", "last good");
  expect(readInjectCache(vault, "active")).toBe("last good");
  expect(await degradedLoad()).toEqual({ context: "last good", source: "cached" });
});

describe("a symlinked directory on the way to the cache", () => {
  const cases: ReadonlyArray<{ link: string; plant: (outsideDir: string) => void }> = [
    {
      link: ".open-second-brain",
      plant: (dir) => {
        mkdirSync(join(dir, "inject-cache"), { recursive: true });
        writeFileSync(join(dir, "inject-cache", "active.txt"), "planted");
      },
    },
    {
      link: ".open-second-brain/inject-cache",
      plant: (dir) => writeFileSync(join(dir, "active.txt"), "planted"),
    },
  ];
  for (const { link, plant } of cases) {
    test.skipIf(IS_WINDOWS)(`${link} as a link is neither read nor written through`, async () => {
      plant(outside);
      const before = listTree(outside);
      const linkPath = join(vault, ...link.split("/"));
      mkdirSync(join(linkPath, ".."), { recursive: true });
      symlinkSync(outside, linkPath, "dir");

      expect(readInjectCache(vault, "active")).toBeNull();
      expect(await degradedLoad()).toEqual({ context: "", source: "empty" });

      writeInjectCache(vault, "active", "fresh body");
      writeInjectCache(vault, "other", "fresh body");
      await loadInjectContextFailOpen({ vault, key: "third", assemble: () => "fresh body" });
      expect(listTree(outside)).toEqual(before);
    });
  }
});

test.skipIf(IS_WINDOWS)("a cache file that is itself a link is not followed", async () => {
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, "victim text");
  mkdirSync(join(vault, ".open-second-brain", "inject-cache"), { recursive: true });
  symlinkSync(victim, join(vault, ".open-second-brain", "inject-cache", "active.txt"));

  expect(readInjectCache(vault, "active")).toBeNull();
  expect(await degradedLoad()).toEqual({ context: "", source: "empty" });

  writeInjectCache(vault, "active", "fresh body");
  expect(readFileSync(victim, "utf8")).toBe("victim text");
  expect(readInjectCache(vault, "active")).toBe("fresh body");
});
