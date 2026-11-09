/**
 * The memory pages the readers walk (task 2.10): on a switched machine
 * the pages rebuilt from the folds equal the legacy pages the same
 * writers leave on an unswitched one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import {
  legacyMemoryPage,
  MEMORY_FOLDERS,
  storeMemoryPages,
  type MemoryFolder,
  type MemoryPage,
} from "../../../../src/core/brain/memory-pages.ts";
import { storeLogDays } from "../../../../src/core/brain/log-days.ts";
import { listLogDates, readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { makeMemoryTwins, normalized, useEnv, type MemoryTwins } from "../fixtures/memory-twins.ts";

let twins: MemoryTwins;
beforeAll(() => {
  twins = makeMemoryTwins("osb-wp2a-pages-");
});
afterAll(() => twins.cleanup());

function legacyPages(vault: string, folder: MemoryFolder): MemoryPage[] {
  const dir = brainDirs(vault)[folder];
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .toSorted()
    .map((n) => legacyMemoryPage(vault, folder, n));
}

function view(pages: ReadonlyArray<MemoryPage>, vault: string) {
  return pages.map((p) => {
    const [meta] = p.read();
    const { _raw_codec: _c, ...rest } = meta as Record<string, unknown>;
    return { name: p.name, rel: p.rel, path: p.path.slice(vault.length), meta: rest };
  });
}

describe("storeMemoryPages", () => {
  test("is null on an unswitched machine", () => {
    useEnv(twins.legacy);
    expect(storeMemoryPages(twins.legacy.vault, "preferences")).toBeNull();
    expect(storeLogDays(twins.legacy.vault)).toBeNull();
  });

  test("the switched machine has no memory pages on disk", () => {
    useEnv(twins.switched);
    for (const folder of MEMORY_FOLDERS) {
      expect(legacyPages(twins.switched.vault, folder)).toEqual([]);
    }
  });

  for (const folder of ["inbox", "processed", "archived", "preferences", "retired"] as const) {
    test(`${folder}: rebuilt pages equal the legacy pages`, () => {
      useEnv(twins.legacy);
      const legacy = view(legacyPages(twins.legacy.vault, folder), twins.legacy.vault);
      useEnv(twins.switched);
      const stored = storeMemoryPages(twins.switched.vault, folder) ?? [];
      expect(stored.every((p) => p.stored)).toBe(true);
      // The switched twin's ids carry its mint tag; the pages are compared without it.
      expect(normalized(view(stored, twins.switched.vault), twins.switched)).toEqual(legacy);
    });
  }

  test("log days from the store hold the events of the day files", () => {
    useEnv(twins.legacy);
    const vault = twins.legacy.vault;
    const legacy = listLogDates(vault).map((date) => ({
      date,
      kinds: readLogDay(vault, date)
        .entries.map((e) => e.eventType)
        .toSorted(),
    }));
    useEnv(twins.switched);
    const stored = (storeLogDays(twins.switched.vault) ?? []).map((d) => ({
      date: d.date,
      kinds: d.entries.map((e) => e.eventType).toSorted(),
    }));
    expect(stored).toEqual(legacy);
    expect(stored.length).toBeGreaterThan(0);
  });
});

describe("rebuilt pages kept for the fold", () => {
  test("a caller editing a page's frontmatter does not change the next reader's page", () => {
    useEnv(twins.switched);
    const [first] = storeMemoryPages(twins.switched.vault, "preferences") ?? [];
    expect(first).toBeDefined();
    const original = JSON.stringify(first!.read()[0]);
    (first!.meta as Record<string, unknown>)["topic"] = "edited";
    (first!.read()[0] as Record<string, unknown>)["topic"] = "edited";
    const [again] = storeMemoryPages(twins.switched.vault, "preferences") ?? [];
    expect(JSON.stringify(again!.read()[0])).toBe(original);
    expect(again!.meta["topic"]).not.toBe("edited");
  });
});
