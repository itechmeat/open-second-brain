/**
 * Source-freshness substrate
 * (continuity-hygiene-freshness suite, Task 7; kanban t_d9624ef6).
 *
 * Derived pages declare their sources in frontmatter (`source_paths` +
 * parallel `source_hashes`, recorded at derivation). Freshness is
 * computed on demand - no background jobs: `stale` when any recorded
 * source changed, `orphaned` when every source is gone, `fresh`
 * otherwise. Pages without the contract are skipped silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkPageFreshness,
  computeSourceStamp,
  formatSourceStampFrontmatter,
  scanFreshness,
} from "../../../src/core/brain/freshness.ts";
import { writeHandoffNote } from "../../../src/core/brain/handoff.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-freshness-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeSource(rel: string, content: string): string {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function writeDerivedPage(rel: string, sourceRels: ReadonlyArray<string>): string {
  const stamp = computeSourceStamp(vault, sourceRels);
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `---\n${formatSourceStampFrontmatter(stamp)}\n---\n\nDerived content.\n`,
    "utf8",
  );
  return path;
}

describe("computeSourceStamp", () => {
  test("records vault-relative paths with sha256 hashes", () => {
    writeSource("notes/source-a.md", "alpha");
    const stamp = computeSourceStamp(vault, ["notes/source-a.md"]);
    expect(stamp.source_paths).toEqual(["notes/source-a.md"]);
    expect(stamp.source_hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("missing sources stamp an empty-hash marker instead of throwing", () => {
    const stamp = computeSourceStamp(vault, ["notes/never-existed.md"]);
    expect(stamp.source_hashes[0]).toBe("missing");
  });
});

describe("checkPageFreshness", () => {
  test("fresh while sources are unchanged", () => {
    writeSource("notes/src.md", "alpha");
    const page = writeDerivedPage("Brain/derived/page.md", ["notes/src.md"]);
    expect(checkPageFreshness(vault, page)?.status).toBe("fresh");
  });

  test("stale once a source changes", () => {
    writeSource("notes/src.md", "alpha");
    const page = writeDerivedPage("Brain/derived/page.md", ["notes/src.md"]);
    writeSource("notes/src.md", "alpha CHANGED");
    const freshness = checkPageFreshness(vault, page);
    expect(freshness?.status).toBe("stale");
    expect(freshness?.changed_sources).toEqual(["notes/src.md"]);
  });

  test("orphaned once every source is gone", () => {
    writeSource("notes/src.md", "alpha");
    const page = writeDerivedPage("Brain/derived/page.md", ["notes/src.md"]);
    rmSync(join(vault, "notes/src.md"));
    expect(checkPageFreshness(vault, page)?.status).toBe("orphaned");
  });

  test("one missing source among living ones is stale, not orphaned", () => {
    writeSource("notes/a.md", "alpha");
    writeSource("notes/b.md", "beta");
    const page = writeDerivedPage("Brain/derived/page.md", ["notes/a.md", "notes/b.md"]);
    rmSync(join(vault, "notes/b.md"));
    const freshness = checkPageFreshness(vault, page);
    expect(freshness?.status).toBe("stale");
    expect(freshness?.missing_sources).toEqual(["notes/b.md"]);
  });

  test("an unreadable source is stale, never orphaned", () => {
    const src = writeSource("notes/locked.md", "alpha");
    const page = writeDerivedPage("Brain/derived/page.md", ["notes/locked.md"]);
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(src, 0o000);
    try {
      const freshness = checkPageFreshness(vault, page);
      expect(freshness?.status).toBe("stale");
      expect(freshness?.unreadable_sources).toEqual(["notes/locked.md"]);
      expect(freshness?.missing_sources).toEqual([]);
    } finally {
      chmodSync(src, 0o644);
    }
  });

  test("returns null for a page without the contract", () => {
    const page = writeSource("Brain/plain.md", "---\ntitle: x\n---\nNo sources here.");
    expect(checkPageFreshness(vault, page)).toBeNull();
  });
});

describe("scanFreshness", () => {
  test("classifies all contract pages and skips the rest silently", () => {
    writeSource("notes/live.md", "alpha");
    writeSource("notes/edited.md", "beta");
    writeDerivedPage("Brain/derived/fresh-page.md", ["notes/live.md"]);
    writeDerivedPage("Brain/derived/stale-page.md", ["notes/edited.md"]);
    writeDerivedPage("Brain/derived/orphan-page.md", ["notes/gone.md"]);
    writeSource("notes/edited.md", "beta CHANGED");
    writeSource("Brain/no-contract.md", "plain page");

    const report = scanFreshness(vault);
    expect(report.with_contract).toBe(3);
    expect(report.fresh).toBe(1);
    expect(report.stale.map((s) => s.page.endsWith("stale-page.md"))).toEqual([true]);
    expect(report.orphaned.map((o) => o.endsWith("orphan-page.md"))).toEqual([true]);
  });

  test("a malformed contract is reported, not thrown", () => {
    const page = join(vault, "Brain/bad.md");
    writeFileSync(
      page,
      "---\nsource_paths: [a.md, b.md]\nsource_hashes: [deadbeef]\n---\nbody",
      "utf8",
    );
    const report = scanFreshness(vault);
    expect(report.invalid_contract.map((p) => p.endsWith("bad.md"))).toEqual([true]);
  });
});

describe("handoff notes carry the contract", () => {
  test("writeHandoffNote stamps source_paths and source_hashes when given a transcript", () => {
    const transcript = writeSource("transcripts/session.jsonl", '{"turn":1}\n');
    const result = writeHandoffNote(vault, {
      sessionId: "sess-1",
      agent: "tester",
      now: new Date("2026-06-10T12:00:00Z"),
      turns: [
        { turnId: "t1", role: "user", text: "do the thing", timestamp: "2026-06-10T11:00:00Z" },
      ],
      sourcePaths: [transcript],
    });
    expect(result.content).toContain("source_paths:");
    expect(result.content).toContain("source_hashes:");
    expect(checkPageFreshness(vault, result.path)?.status).toBe("fresh");
  });
});
