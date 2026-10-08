/**
 * Serve-with-correction coupling across the Brain serving surfaces
 * (truth-correctable-time-aware, Task 19).
 *
 * Every surface that serves a retired-but-serveable record decides
 * through `couplingVerdict`: the record appears only beside its
 * resolved, readable chain-tip correction and is dropped fail-closed
 * otherwise - a withheld correction takes its predecessor with it. The
 * surfaces covered here are recall by topic (`queryByTopic`), the
 * context pack, the active.md digest and the dream scan.
 *
 * Today's exclusion wiring is pinned too: a tombstoned retired record
 * stays hidden everywhere (the status filter's job, before any coupling
 * question arises), a retired record with no successor pointer is not in
 * the predicate's regime and keeps today's behavior, and every surface's
 * non-retired output is unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { queryByTopic } from "../../../src/core/brain/query.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { renderActive } from "../../../src/core/brain/active.ts";
import { scanBrain } from "../../../src/core/brain/dream-scan.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-coupling-surfaces-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-coupling-surfaces-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Frontmatter lines plus body of a retired record, written vault-relative. */
function writeRetired(
  id: string,
  fields: { topic: string; supersededBy?: string; tombstoned?: boolean },
): void {
  const lines = [
    "---",
    "kind: brain-retired",
    `id: ${id}`,
    // Group C fields use the `_`-prefixed shape on disk; a tombstoned
    // record carries the tombstone status in the same field, which is
    // what the shared exclusion predicate reads.
    fields.tombstoned === true ? "_status: tombstoned" : "_status: retired",
    "retired_at: 2026-06-01T00:00:00Z",
    "retired_reason: stale-no-evidence",
    "retired_by: '[[Brain/log/2026-06-01]]'",
    "created_at: 2026-05-01T00:00:00Z",
    "tags: [brain, brain/retired]",
    `topic: ${fields.topic}`,
    `principle: Retired rule for ${fields.topic}.`,
    "pinned: false",
    ...(fields.tombstoned ? ["tombstoned_at: 2026-06-02T00:00:00Z"] : []),
    ...(fields.supersededBy !== undefined ? [`superseded_by: "[[${fields.supersededBy}]]"`] : []),
    "---",
    "",
    "The retired body text.",
    "",
  ].join("\n");
  writeFileSync(join(brainDirs(vault).retired, `${id}.md`), lines);
}

/** A preference page, the usual shape of a correction. */
function writePreferencePage(id: string, topic: string, supersededBy?: string): void {
  const lines = [
    "---",
    "kind: brain-preference",
    `id: ${id}`,
    "_status: confirmed",
    "created_at: 2026-06-02T00:00:00Z",
    "unconfirmed_until: 2026-06-02T00:00:00Z",
    "_confirmed_at: 2026-06-02T00:00:00Z",
    "_evidenced_by: []",
    "tags: [brain, brain/preference]",
    `topic: ${topic}`,
    `principle: Live rule for ${topic}.`,
    "pinned: false",
    ...(supersededBy !== undefined ? [`superseded_by: "[[${supersededBy}]]"`] : []),
    "---",
    "",
    `The live body for ${topic}.`,
    "",
  ].join("\n");
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
  writeFileSync(join(brainDirs(vault).preferences, `${id}.md`), lines);
}

describe("recall by topic", () => {
  test("a retired record with a resolved, readable correction stays recallable", () => {
    writePreferencePage("pref-new", "alpha-v2");
    writeRetired("ret-old", { topic: "alpha", supersededBy: "pref-new" });

    const out = queryByTopic(vault, "alpha");
    expect(out.preference?.id).toBe("ret-old");
  });

  test("a retired record whose correction is unresolved is dropped fail-closed", () => {
    writeRetired("ret-dangling", { topic: "beta", supersededBy: "pref-ghost" });

    const out = queryByTopic(vault, "beta");
    expect(out.preference).toBeNull();
  });

  test("a retired record with no successor pointer keeps today's behavior", () => {
    writeRetired("ret-plain", { topic: "gamma" });

    const out = queryByTopic(vault, "gamma");
    expect(out.preference?.id).toBe("ret-plain");
  });

  test("a tombstoned retired record stays hidden even with a resolved correction", () => {
    writePreferencePage("pref-new", "delta-v2");
    writeRetired("ret-dead", { topic: "delta", supersededBy: "pref-new", tombstoned: true });

    const out = queryByTopic(vault, "delta");
    expect(out.preference).toBeNull();
  });

  test("non-retired output is unchanged: the correction itself still resolves", () => {
    writePreferencePage("pref-new", "alpha-v2");
    writeRetired("ret-old", { topic: "alpha", supersededBy: "pref-new" });

    const out = queryByTopic(vault, "alpha-v2");
    expect(out.preference?.id).toBe("pref-new");
  });
});

describe("context pack", () => {
  test("historical injection keeps a superseded ancestor beside its resolved correction", () => {
    writePreferencePage("pref-tip", "tip topic");
    writePreferencePage("pref-anc", "ancestor topic", "pref-tip");

    const historical = packContext(vault, { maxTokens: 4000, includeHistorical: true });
    const ids = historical.items.map((i) => i.id).toSorted();
    expect(ids).toEqual(["pref-anc", "pref-tip"]);
  });

  test("historical injection drops an ancestor whose correction is unresolved", () => {
    writePreferencePage("pref-anc-dangling", "dangling topic", "pref-ghost");

    const historical = packContext(vault, { maxTokens: 4000, includeHistorical: true });
    expect(historical.items.map((i) => i.id)).not.toContain("pref-anc-dangling");
  });

  test("default injection still serves only chain tips, unchanged", () => {
    writePreferencePage("pref-tip", "tip topic");
    writePreferencePage("pref-anc", "ancestor topic", "pref-tip");
    writePreferencePage("pref-plain", "plain topic");

    const out = packContext(vault, { maxTokens: 4000 });
    const ids = out.items.map((i) => i.id).toSorted();
    expect(ids).toEqual(["pref-plain", "pref-tip"]);
  });
});

describe("active.md digest", () => {
  test("the digest keeps a retired record whose correction resolves", () => {
    writePreferencePage("pref-new", "epsilon-v2");
    writeRetired("ret-old", { topic: "epsilon", supersededBy: "pref-new" });

    const body = renderActive(vault).body;
    expect(body).toContain("ret-old");
  });

  test("the digest drops a retired record whose correction is unresolved", () => {
    writeRetired("ret-dangling", { topic: "zeta", supersededBy: "pref-ghost" });

    const body = renderActive(vault).body;
    expect(body).not.toContain("ret-dangling");
  });

  test("a retired record with no successor pointer keeps today's rendering", () => {
    writeRetired("ret-plain", { topic: "eta" });

    const body = renderActive(vault).body;
    expect(body).toContain("ret-plain");
  });
});

describe("dream scan", () => {
  test("the scan keeps a retired record whose correction resolves", () => {
    writePreferencePage("pref-new", "theta-v2");
    writeRetired("ret-old", { topic: "theta", supersededBy: "pref-new" });

    const scan = scanBrain(vault);
    expect(scan.retired.map((r) => r.id)).toContain("ret-old");
  });

  test("the scan drops a retired record whose correction is unresolved", () => {
    writeRetired("ret-dangling", { topic: "iota", supersededBy: "pref-ghost" });

    const scan = scanBrain(vault);
    expect(scan.retired.map((r) => r.id)).not.toContain("ret-dangling");
  });

  test("a retired record with no successor pointer is scanned as before", () => {
    writeRetired("ret-plain", { topic: "kappa" });

    const scan = scanBrain(vault);
    expect(scan.retired.map((r) => r.id)).toContain("ret-plain");
  });
});
