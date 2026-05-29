/**
 * Sources dashboard projection (Vault portability suite, Feature 2).
 *
 * `aggregateSources` is a pure read-only projection over the brain's
 * signals (inbox + processed), grouped by (agent, source_type) with
 * active/processed and distinct-topic counts. Deterministic ordering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregateSources } from "../../../../src/core/brain/portability/sources.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sources-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-sources-cfg-"));
  const cfg = join(configHome, "config.yaml");
  atomicWriteFileSync(cfg, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: cfg });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function sig(opts: {
  topic: string;
  slug: string;
  agent: string;
  date: string;
  source_type?: "live" | "inline" | "session";
}): string {
  const r = writeSignal(vault, {
    topic: opts.topic,
    signal: "positive",
    agent: opts.agent,
    principle: `Rule for ${opts.topic}`,
    created_at: `${opts.date}T10:00:00Z`,
    date: opts.date,
    slug: opts.slug,
    ...(opts.source_type ? { source_type: opts.source_type } : {}),
  });
  return r.path;
}

describe("aggregateSources", () => {
  test("returns no rows for a fresh vault", () => {
    expect(aggregateSources(vault).sources).toHaveLength(0);
  });

  test("groups signals by (agent, source_type) with active + distinct-topic counts", () => {
    sig({ topic: "a", slug: "a1", agent: "claude", date: "2026-05-20" });
    sig({ topic: "b", slug: "b1", agent: "claude", date: "2026-05-21" });
    sig({ topic: "a", slug: "a2", agent: "claude", date: "2026-05-22" }); // dup topic
    sig({ topic: "c", slug: "c1", agent: "codex", date: "2026-05-22", source_type: "session" });

    const { sources } = aggregateSources(vault);
    const claude = sources.find((s) => s.agent === "claude")!;
    expect(claude.active).toBe(3);
    expect(claude.distinct_topics).toBe(2);
    expect(claude.source_type).toBe("live"); // absent source_type buckets as live
    const codex = sources.find((s) => s.agent === "codex")!;
    expect(codex.active).toBe(1);
    expect(codex.source_type).toBe("session");
  });

  test("counts processed signals separately from active", () => {
    const p = sig({ topic: "x", slug: "x1", agent: "claude", date: "2026-05-20" });
    renameSync(p, join(brainDirs(vault).processed, "sig-2026-05-20-x1.md"));
    sig({ topic: "y", slug: "y1", agent: "claude", date: "2026-05-21" });

    const claude = aggregateSources(vault).sources.find((s) => s.agent === "claude")!;
    expect(claude.active).toBe(1);
    expect(claude.processed).toBe(1);
  });

  test("is deterministic and sorted by (agent, source_type)", () => {
    sig({ topic: "a", slug: "a1", agent: "zeta", date: "2026-05-20" });
    sig({ topic: "b", slug: "b1", agent: "alpha", date: "2026-05-20" });
    const a = aggregateSources(vault);
    const b = aggregateSources(vault);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.sources.map((s) => s.agent)).toEqual(["alpha", "zeta"]);
  });
});
