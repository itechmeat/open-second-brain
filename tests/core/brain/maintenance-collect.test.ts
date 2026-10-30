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

/**
 * A visibility predicate threaded into the collector is applied to the
 * CANDIDATE INPUTS - dedup canonical and secondaries, demotion ids,
 * link paths - before scoring and capping. Ranked post-hoc filtering
 * (what every sink did before) let another owner's rows take ranked
 * slots and then dropped them, so a scoped caller got fewer than the
 * cap - and the shortfall itself hinted that withheld rows exist,
 * against the module's identical-to-absent convention.
 */
describe("collectMaintenanceActions — the visibility predicate applies before the cap", () => {
  test("hidden top-ranked candidates take no slot a visible one could fill", () => {
    // Twelve stale pages owned by another owner, older (so
    // higher-impact) than ten visible ones: post-hoc filtering left the
    // scoped caller with an empty list.
    for (let i = 0; i < 12; i += 1) writeStale(`theirs-${i}`, "2020-01-01T00:00:00Z", "agent-a");
    for (let i = 0; i < 10; i += 1) writeStale(`ours-${i}`, "2024-01-01T00:00:00Z");
    const actions = collectMaintenanceActions(vault, {
      visible: (ref) => !(ref ?? "").includes("theirs"),
    });
    expect(actions).toHaveLength(10);
    for (const action of actions) expect(action.target).not.toContain("theirs");
  });

  test("a dedup candidate counts only the secondaries the caller may see", () => {
    // Canonical is the oldest page; one of its two duplicates belongs to
    // another owner. The row survives with the VISIBLE count - the count
    // is what would disclose the hidden page's existence.
    writeStale("canonical", "2025-01-01T00:00:00Z", undefined, "shared", "the shared principle");
    writeStale("dup-visible", "2025-02-01T00:00:00Z", undefined, "shared", "the shared principle");
    writeStale("dup-hidden", "2025-03-01T00:00:00Z", "agent-a", "shared", "the shared principle");
    const actions = collectMaintenanceActions(vault, {
      visible: (ref) => !(ref ?? "").includes("hidden"),
    });
    const dedup = actions.find((a) => a.category === "dedup");
    expect(dedup).toBeDefined();
    expect(dedup!.title).toBe("Merge 1 duplicate(s) into pref-canonical");
    // The hidden duplicate's own row is gone too: its id would leak.
    expect(actions.some((a) => a.target === "pref-dup-hidden")).toBe(false);
  });

  test("omitting the predicate ranks every candidate, byte-identical to the plain call", () => {
    // The contract every unscoped caller keeps: passing nothing changes
    // nothing. Pinned as a byte comparison over the ranked list.
    writeStale("canonical", "2025-01-01T00:00:00Z");
    writeStale("dup", "2025-02-01T00:00:00Z");
    writeStale("lone", "2020-01-01T00:00:00Z", "agent-a");
    writeStale("other", "2024-01-01T00:00:00Z");

    const plain = collectMaintenanceActions(vault);
    const open = collectMaintenanceActions(vault, { visible: () => true });
    expect(JSON.stringify(open)).toBe(JSON.stringify(plain));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.some((a) => a.target === "pref-lone")).toBe(true);
  });
});

/**
 * A minimal stale-stable page: old enough to be a lint demotion
 * candidate on any run date. Topic and principle default to per-page
 * values so unrelated fixtures never group as dedup candidates.
 */
function writeStale(
  slug: string,
  createdAt: string,
  owner?: string,
  topic?: string,
  principle?: string,
): void {
  const lines = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    "tags: [brain, brain/preference]",
    `topic: ${topic ?? `topic-${slug}`}`,
    `principle: ${principle ?? `principle ${slug}`}`,
    `created_at: ${createdAt}`,
    "---",
    "",
  ];
  if (owner !== undefined) lines.splice(4, 0, `owner: ${owner}`);
  writeFileSync(join(vault, "Brain", "preferences", `pref-${slug}.md`), lines.join("\n"), "utf8");
}

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
