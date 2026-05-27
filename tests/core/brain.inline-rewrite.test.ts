/**
 * Tests for `inline-rewrite.ts` — atomic in-place annotation of
 * `@osb` markers with `@osb✓ [[sig-...]]` (inline form) and info-string
 * flip from `osb` → `osb-checked` (block form).
 */

import { afterEach, beforeEach, expect, describe, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteMarkers } from "../../src/core/brain/inline-rewrite.ts";
import { discoverMarkers } from "../../src/core/brain/inline.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-inline-rewrite-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("rewriteMarkers (inline form)", () => {
  test("rewrites '@osb ' to '@osb✓ [[sig-...]] '", async () => {
    const path = writeTmp(
      "note.md",
      "Some text\n@osb feedback negative topic=t principle=p\nMore text\n",
    );
    const markers = discoverMarkers(readFileSync(path, "utf8"));
    expect(markers.length).toBe(1);

    await rewriteMarkers(path, [{ marker: markers[0]!, signalId: "sig-2026-05-16-t" }]);

    const after = readFileSync(path, "utf8");
    expect(after).toMatch(
      /^@osb✓ \[\[sig-2026-05-16-t\]\] feedback negative topic=t principle=p$/m,
    );
    expect(after).toMatch(/^Some text$/m);
    expect(after).toMatch(/^More text$/m);
  });

  test("re-running discoverMarkers after rewrite returns zero matches", async () => {
    const path = writeTmp("note.md", "@osb feedback negative topic=t principle=p\n");
    const first = discoverMarkers(readFileSync(path, "utf8"));
    await rewriteMarkers(path, [{ marker: first[0]!, signalId: "sig-x" }]);
    const second = discoverMarkers(readFileSync(path, "utf8"));
    expect(second.length).toBe(0);
  });
});

describe("rewriteMarkers (block form)", () => {
  test("flips info-string osb → osb-checked and prepends '<!-- @osb✓ [[id]] -->'", async () => {
    const path = writeTmp(
      "note.md",
      [
        "Before",
        "```osb",
        "kind: feedback",
        "signal: positive",
        "topic: t",
        "principle: p",
        "```",
        "After",
        "",
      ].join("\n"),
    );
    const markers = discoverMarkers(readFileSync(path, "utf8"));
    expect(markers.length).toBe(1);

    await rewriteMarkers(path, [{ marker: markers[0]!, signalId: "sig-2026-05-16-t" }]);

    const after = readFileSync(path, "utf8");
    expect(after).toMatch(/^```osb-checked$/m);
    expect(after).toMatch(/^<!-- @osb✓ \[\[sig-2026-05-16-t\]\] -->$/m);
    // Body preserved.
    expect(after).toMatch(/^kind: feedback$/m);
    expect(after).toMatch(/^principle: p$/m);
    // Closing fence unchanged.
    expect(after).toMatch(/^```$/m);
  });

  test("block rewrite is idempotent (re-run yields no new markers)", async () => {
    const path = writeTmp(
      "note.md",
      ["```osb", "kind: feedback", "signal: positive", "topic: t", "principle: p", "```", ""].join(
        "\n",
      ),
    );
    const first = discoverMarkers(readFileSync(path, "utf8"));
    await rewriteMarkers(path, [{ marker: first[0]!, signalId: "sig-x" }]);
    const second = discoverMarkers(readFileSync(path, "utf8"));
    expect(second.length).toBe(0);
  });
});

describe("rewriteMarkers — mixed and multiple", () => {
  test("processes multiple inline markers in order", async () => {
    const path = writeTmp(
      "note.md",
      [
        "@osb feedback negative topic=a principle=pa",
        "...",
        "@osb feedback positive topic=b principle=pb",
        "",
      ].join("\n"),
    );
    const markers = discoverMarkers(readFileSync(path, "utf8"));
    expect(markers.length).toBe(2);
    await rewriteMarkers(path, [
      { marker: markers[0]!, signalId: "sig-aaa" },
      { marker: markers[1]!, signalId: "sig-bbb" },
    ]);
    const after = readFileSync(path, "utf8");
    expect(after).toMatch(/@osb✓ \[\[sig-aaa\]\] feedback negative topic=a/);
    expect(after).toMatch(/@osb✓ \[\[sig-bbb\]\] feedback positive topic=b/);
  });

  test("handles mixed inline + block markers", async () => {
    const path = writeTmp(
      "note.md",
      [
        "@osb feedback negative topic=a principle=pa",
        "",
        "```osb",
        "kind: feedback",
        "signal: positive",
        "topic: b",
        "principle: pb",
        "```",
        "",
      ].join("\n"),
    );
    const markers = discoverMarkers(readFileSync(path, "utf8"));
    expect(markers.length).toBe(2);
    await rewriteMarkers(path, [
      { marker: markers[0]!, signalId: "sig-aaa" },
      { marker: markers[1]!, signalId: "sig-bbb" },
    ]);
    const after = readFileSync(path, "utf8");
    expect(after).toMatch(/^@osb✓ \[\[sig-aaa\]\] feedback negative/m);
    expect(after).toMatch(/^```osb-checked$/m);
    expect(after).toMatch(/^<!-- @osb✓ \[\[sig-bbb\]\] -->$/m);
  });
});
