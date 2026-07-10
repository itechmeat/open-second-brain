import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadInjectContextFailOpen,
  readInjectCache,
} from "../../../src/core/brain/inject-failopen.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-failopen-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("a fresh non-empty assembly is returned and cached as last-good", async () => {
  const res = await loadInjectContextFailOpen({
    vault,
    key: "active",
    assemble: () => "fresh body",
  });
  expect(res).toEqual({ context: "fresh body", degraded: false, source: "fresh" });
  expect(readInjectCache(vault, "active")).toBe("fresh body");
});

test("a thrown assembly degrades to the last-good cache and audits once", async () => {
  await loadInjectContextFailOpen({ vault, key: "active", assemble: () => "good v1" });

  const audits: Array<{ source: string }> = [];
  const res = await loadInjectContextFailOpen({
    vault,
    key: "active",
    assemble: () => {
      throw new Error("embedding timed out");
    },
    audit: (source) => audits.push({ source }),
  });
  expect(res).toEqual({ context: "good v1", degraded: true, source: "cached" });
  expect(audits).toEqual([{ source: "cached" }]);
});

test("a thrown assembly with no cache degrades to empty, never a partial write", async () => {
  const audits: string[] = [];
  const res = await loadInjectContextFailOpen({
    vault,
    key: "active",
    assemble: () => {
      throw new Error("stat stalled");
    },
    audit: (source) => audits.push(source),
  });
  expect(res).toEqual({ context: "", degraded: true, source: "empty" });
  expect(audits).toEqual(["empty"]);
  expect(existsSync(join(vault, ".open-second-brain", "inject-cache", "active.txt"))).toBe(false);
});

test("a legitimately empty assembly does not clobber the last-good cache", async () => {
  await loadInjectContextFailOpen({ vault, key: "active", assemble: () => "good v1" });
  const res = await loadInjectContextFailOpen({ vault, key: "active", assemble: () => "" });
  expect(res).toEqual({ context: "", degraded: false, source: "fresh" });
  // The prior good body is preserved so a later error can still degrade to it.
  expect(readInjectCache(vault, "active")).toBe("good v1");
  const raw = readFileSync(join(vault, ".open-second-brain", "inject-cache", "active.txt"), "utf8");
  expect(raw).toBe("good v1");
});
