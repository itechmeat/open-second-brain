import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadManifest,
  saveManifest,
  type ClaudeMemoryManifest,
} from "../../../src/core/brain/claude-memory-manifest.ts";

describe("claude-memory manifest", () => {
  test("missing file → empty manifest", () => {
    const v = mkdtempSync(join(tmpdir(), "o2b-cm-m1-"));
    expect(loadManifest(v)).toEqual({ version: 1, imports: {} });
    rmSync(v, { recursive: true });
  });

  test("round-trip", () => {
    const v = mkdtempSync(join(tmpdir(), "o2b-cm-m2-"));
    const m: ClaudeMemoryManifest = {
      version: 1,
      imports: {
        "no-em-dashes.md": {
          pref_id: "pref-no-em-dashes",
          sha256: "a".repeat(64),
          imported_at: "2026-05-18T10:00:00Z",
        },
      },
    };
    saveManifest(v, m);
    expect(loadManifest(v)).toEqual(m);
    rmSync(v, { recursive: true });
  });
});
