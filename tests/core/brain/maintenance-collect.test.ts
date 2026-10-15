/**
 * The maintenance signal collection is fail-soft per signal, and the
 * failures it absorbs are NAMED (Lane 5, Task 5.2): each failed scan is
 * reported to the `onError` observer as {signal, message} while the
 * remaining signals still collect and the actions still return. Before the
 * decomposition a failed signal was swallowed by a bare catch that said
 * nothing, so a thin maintenance report looked exactly like a healthy one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectMaintenanceActions,
  type MaintenanceCollectError,
} from "../../../src/core/brain/maintenance/collect.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-maintenance-collect-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("collectMaintenanceActions", () => {
  test("a healthy vault collects actions and observes no errors", () => {
    writePref("a", "the rule", "see also [[pref-b]]");
    writePref("b", "the rule", "duplicate of the rule");

    const errors: MaintenanceCollectError[] = [];
    const actions = collectMaintenanceActions(vault, { onError: (e) => errors.push(e) });

    expect(errors).toEqual([]);
    expect(actions.some((a) => a.category === "dedup")).toBe(true);
  });

  test("a failed dedup scan is observed by name; the run still completes", () => {
    // The dedup scan walks Brain/preferences; a FILE at that path makes the
    // readdir refuse on every platform, no chmod needed.
    rmSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(join(vault, "Brain", "preferences"), "not a directory", "utf8");

    const errors: MaintenanceCollectError[] = [];
    const actions = collectMaintenanceActions(vault, { onError: (e) => errors.push(e) });

    const dedup = errors.find((e) => e.signal === "dedup");
    expect(dedup).toBeDefined();
    // Windows error text carries the path with the platform separator.
    expect(dedup!.message.replace(/\\/g, "/")).toContain("Brain/preferences");
    // The run completes and still answers with the actions array.
    expect(Array.isArray(actions)).toBe(true);
  });

  test("each failed signal is observed separately", () => {
    rmSync(join(vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(join(vault, "Brain", "preferences"), "not a directory", "utf8");
    // The lint pass reads the inbox; a file at that path fails it too.
    rmSync(join(vault, "Brain", "inbox"), { recursive: true });
    writeFileSync(join(vault, "Brain", "inbox"), "not a directory", "utf8");

    const errors: MaintenanceCollectError[] = [];
    collectMaintenanceActions(vault, { onError: (e) => errors.push(e) });

    const signals = errors.map((e) => e.signal).toSorted();
    expect(signals).toContain("dedup");
    expect(signals).toContain("lint");
    // Every observed failure carries a message.
    for (const e of errors) expect(e.message.length).toBeGreaterThan(0);
  });
});

function writePref(slug: string, principle: string, body: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      "topic: em-dashes",
      "_status: confirmed",
      `principle: ${principle}`,
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "created_at: 2026-01-01T00:00:00Z",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
}
