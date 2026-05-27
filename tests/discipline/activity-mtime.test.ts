import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mtimeActivity } from "../../src/core/discipline/activity-mtime.ts";

function touch(path: string, isoUtc: string): void {
  const ts = new Date(isoUtc).getTime() / 1000;
  utimesSync(path, ts, ts);
}

describe("mtimeActivity", () => {
  test("counts files mtime'd inside the window; excludes noise dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "o2b-disc-mtime-"));
    writeFileSync(join(root, "in1.txt"), "x");
    touch(join(root, "in1.txt"), "2026-05-17T10:00:00Z");
    writeFileSync(join(root, "in2.md"), "x");
    touch(join(root, "in2.md"), "2026-05-17T20:00:00Z");
    writeFileSync(join(root, "out.txt"), "x");
    touch(join(root, "out.txt"), "2026-05-18T10:00:00Z");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "noise.js"), "x");
    touch(join(root, "node_modules", "noise.js"), "2026-05-17T15:00:00Z");
    mkdirSync(join(root, "subdir"));
    writeFileSync(join(root, "subdir", "in3.md"), "x");
    touch(join(root, "subdir", "in3.md"), "2026-05-17T15:00:00Z");

    const out = mtimeActivity(root, {
      startUtc: new Date("2026-05-17T00:00:00Z"),
      endUtc: new Date("2026-05-18T00:00:00Z"),
    });
    expect(out.modifiedFiles).toBe(3);
    rmSync(root, { recursive: true });
  });
});
