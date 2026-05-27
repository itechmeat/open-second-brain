/**
 * Tests for `src/core/brain/note.ts` (v0.10.10).
 *
 * Drives §7.1 of `docs/plans/2026-05-20-v0.10.10-design.md` — the
 * shared `appendBrainNote` core that both the MCP `brain_note` tool
 * and the new `o2b brain note` CLI verb delegate to.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { appendBrainNote } from "../../../src/core/brain/note.ts";

function bootstrap(vault: string): void {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
}

describe("appendBrainNote", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-brain-note-core-"));
    bootstrap(vault);
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("writes a one-line note to today's log under kind=note", () => {
    const now = new Date("2026-05-20T12:34:56Z");
    const res = appendBrainNote({
      vault,
      text: "released v0.10.10",
      agent: "tester",
      now,
    });
    expect(res.agent).toBe("tester");
    expect(res.logged_at).toBe("2026-05-20T12:34:56Z");
    expect(res.log_path).toBe("Brain/log/2026-05-20.md");
    expect(res.absolute_log_path).toBe(resolve(vault, "Brain/log/2026-05-20.md"));
    const body = readFileSync(res.absolute_log_path, "utf8");
    expect(body).toContain("## 12:34:56Z — note");
    expect(body).toContain("- text: released v0.10.10");
    expect(body).toContain("- agent: tester");
  });

  test("collapses multi-line text to one space-joined line", () => {
    const res = appendBrainNote({
      vault,
      text: "line one\nline two\r\nline three",
      agent: "tester",
      now: new Date("2026-05-20T00:00:00Z"),
    });
    const body = readFileSync(res.absolute_log_path, "utf8");
    expect(body).toContain("- text: line one line two line three");
  });

  test("writes a sidecar JSONL line alongside the markdown", () => {
    const res = appendBrainNote({
      vault,
      text: "release shipped",
      agent: "tester",
      now: new Date("2026-05-20T01:00:00Z"),
    });
    const jsonlPath = res.absolute_log_path.replace(/\.md$/, ".jsonl");
    const jsonl = readFileSync(jsonlPath, "utf8");
    expect(jsonl).toContain('"kind":"note"');
    expect(jsonl).toContain('"text":"release shipped"');
  });

  test("rejects whitespace-only text", () => {
    expect(() => appendBrainNote({ vault, text: "   ", agent: "tester", now: new Date() })).toThrow(
      /text is required/,
    );
  });

  test("rejects text that becomes empty after sanitising", () => {
    expect(() =>
      appendBrainNote({ vault, text: "\n\t  \n", agent: "tester", now: new Date() }),
    ).toThrow(/text is required/);
  });

  test("explicit agent overrides the resolver default", () => {
    const res = appendBrainNote({
      vault,
      text: "explicit agent path",
      agent: "explicit-name",
      now: new Date("2026-05-20T02:00:00Z"),
    });
    expect(res.agent).toBe("explicit-name");
  });
});
