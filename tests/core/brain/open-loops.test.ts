/**
 * Tests for `open-loops.ts` - the read-only live scan that derives the
 * open-loop set from `@osb loop` markers across the configured note
 * paths. Mirrors the tmp-vault + config fixture pattern used by
 * `tests/core/brain.inline-scan.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { scanOpenLoops } from "../../../src/core/brain/open-loops.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-open-loops-"));
  mkdirSync(brainDirs(vault).brain, { recursive: true });
  // Default fixture: a single Daily/ read path. Tests that need a
  // different shape override this.
  writeConfig("\nnotes:\n  read_paths:\n    - Daily\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfig(extra: string): void {
  atomicWriteFileSync(
    join(brainDirs(vault).brain, "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}${extra}`,
  );
}

function writeMd(rel: string, content: string): string {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function derivedId(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(/\s+/g, " "), "utf8")
    .digest("hex")
    .slice(0, 8);
}

describe("scanOpenLoops - discovery forms", () => {
  test("discovers an open loop in inline form", () => {
    writeMd("Daily/2026-07-17.md", "@osb loop review the security posture\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]).toEqual({
      id: derivedId("review the security posture"),
      text: "review the security posture",
      path: "Daily/2026-07-17.md",
      line: 1,
    });
    expect(scan.counts.openCount).toBe(1);
    expect(scan.counts.scannedFiles).toBe(1);
  });

  test("discovers an open loop in fenced block form", () => {
    writeMd(
      "Daily/block.md",
      ["```osb", "kind: loop", "text: ship the release", "```", ""].join("\n"),
    );
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.text).toBe("ship the release");
    expect(scan.openLoops[0]?.id).toBe(derivedId("ship the release"));
  });
});

describe("scanOpenLoops - id derivation", () => {
  test("explicit id= wins over the derived hash", () => {
    writeMd("Daily/a.md", "@osb loop follow up on the vendor id=vendor-42\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops[0]?.id).toBe("vendor-42");
  });

  test("derived id is the first 8 hex chars of sha256(normalized text)", () => {
    // Pinned known value - guards the id derivation against drift.
    writeMd("Daily/a.md", "@osb loop review    the   security posture\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops[0]?.id).toBe("8496c464");
    expect(scan.openLoops[0]?.id).toBe(derivedId("review the security posture"));
  });
});

describe("scanOpenLoops - open-set computation", () => {
  test("a close token removes the loop from the open set", () => {
    writeMd(
      "Daily/a.md",
      ["@osb loop follow up on the vendor id=vendor", "@osb loop close id=vendor", ""].join("\n"),
    );
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(0);
    expect(scan.counts.openCount).toBe(0);
    expect(scan.counts.closedCount).toBe(1);
    expect(scan.orphanCloses).toHaveLength(0);
  });

  test("a close token in a different file still closes the loop", () => {
    writeConfig("\nnotes:\n  read_paths:\n    - Daily\n    - Journal\n");
    writeMd("Daily/a.md", "@osb loop follow up on the vendor id=vendor\n");
    writeMd("Journal/b.md", "@osb loop close id=vendor\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(0);
    expect(scan.counts.closedCount).toBe(1);
  });

  test("a close token with no matching open marker is reported as an orphan", () => {
    writeMd("Daily/a.md", "@osb loop close id=ghost\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(0);
    expect(scan.counts.closedCount).toBe(0);
    expect(scan.orphanCloses).toEqual([{ id: "ghost", path: "Daily/a.md", line: 1 }]);
  });

  test("duplicate ids collapse to the first occurrence and list the extras", () => {
    writeMd(
      "Daily/a.md",
      ["@osb loop chase the invoice id=inv", "@osb loop chase the invoice again id=inv", ""].join(
        "\n",
      ),
    );
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.line).toBe(1);
    expect(scan.openLoops[0]?.text).toBe("chase the invoice");
    expect(scan.duplicates).toEqual([
      { id: "inv", text: "chase the invoice again", path: "Daily/a.md", line: 2 },
    ]);
  });
});

describe("scanOpenLoops - inertness and scope", () => {
  test("feedback and set markers in the same files are ignored", () => {
    const notePath = writeMd(
      "Daily/a.md",
      [
        "@osb feedback negative topic=mocking principle=p",
        "@osb loop keep this open",
        "@osb set note=Roadmap field=completion value=65",
        "",
      ].join("\n"),
    );
    const before = readFileSync(notePath, "utf8");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.text).toBe("keep this open");
    // Read-only: the source file is never rewritten or annotated.
    expect(readFileSync(notePath, "utf8")).toBe(before);
  });

  test("markers inside a non-osb fenced code block are skipped", () => {
    writeMd(
      "Daily/a.md",
      [
        "@osb loop real live loop",
        "```ts",
        "// @osb loop this is documentation not a marker",
        "```",
        "",
      ].join("\n"),
    );
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.text).toBe("real live loop");
  });

  test("loops under an ignore_paths subtree are not scanned", () => {
    atomicWriteFileSync(
      join(brainDirs(vault).brain, "_brain.yaml"),
      "schema_version: 1\nnotes:\n  read_paths:\n    - Daily\nvault:\n  ignore_paths:\n    - Daily/Archive\n",
    );
    writeMd("Daily/live.md", "@osb loop live one\n");
    writeMd("Daily/Archive/old.md", "@osb loop archived one\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.text).toBe("live one");
  });

  test("loops planted inside Brain/ are never scanned", () => {
    writeFileSync(
      join(brainDirs(vault).brain, "stray.md"),
      "@osb loop should be invisible\n",
      "utf8",
    );
    writeMd("Daily/keep.md", "@osb loop visible one\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(1);
    expect(scan.openLoops[0]?.text).toBe("visible one");
  });
});

describe("scanOpenLoops - determinism", () => {
  test("two runs over the same vault produce identical envelopes", () => {
    writeMd("Daily/a.md", "@osb loop alpha loop id=one\n");
    writeMd("Daily/b.md", "@osb loop beta loop id=two\n");
    writeMd("Daily/c.md", "@osb loop gamma loop id=three\n");
    const first = scanOpenLoops(vault);
    const second = scanOpenLoops(vault);
    expect(second).toEqual(first);
    // Deterministic order: sorted by vault-relative path.
    expect(first.openLoops.map((l) => l.path)).toEqual(["Daily/a.md", "Daily/b.md", "Daily/c.md"]);
  });

  test("the returned envelope is frozen", () => {
    writeMd("Daily/a.md", "@osb loop frozen check\n");
    const scan = scanOpenLoops(vault);
    expect(Object.isFrozen(scan)).toBe(true);
    expect(Object.isFrozen(scan.openLoops)).toBe(true);
    expect(Object.isFrozen(scan.counts)).toBe(true);
  });
});

describe("scanOpenLoops - empty configuration", () => {
  test("no configured read paths yields a well-formed empty scan", () => {
    writeConfig("");
    writeMd("Daily/a.md", "@osb loop orphaned by config\n");
    const scan = scanOpenLoops(vault);
    expect(scan.openLoops).toHaveLength(0);
    expect(scan.counts).toEqual({ openCount: 0, closedCount: 0, scannedFiles: 0 });
  });
});
