/**
 * Tests for `inline-scan.ts` — the vault walker that finds @osb markers,
 * dedups against the existing inbox, writes signals, and rewrites the
 * source files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { scanInline } from "../../src/core/brain/inline-scan.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-inline-scan-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeMd(rel: string, content: string): string {
  const path = join(tmp, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

describe("scanInline", () => {
  test("finds an inline marker in Daily/ and creates a signal in inbox/", async () => {
    writeMd(
      "Daily/2026-05-16.md",
      "Note text\n@osb feedback negative topic=mocking principle=\"don't mock DB\"\n",
    );
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.found).toBe(1);
    expect(result.created).toBe(1);
    expect(result.deduped).toBe(0);

    const inboxFiles = readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md"));
    expect(inboxFiles.length).toBe(1);
    const sig = readFileSync(join(brainDirs(tmp).inbox, inboxFiles[0]!), "utf8");
    expect(sig).toMatch(/^source_type: inline$/m);
    expect(sig).toMatch(/^dedup_hash: /m);
    expect(sig).toMatch(/topic: mocking/);
  });

  test("skips Brain/ when walking (no self-recursion)", async () => {
    // Plant a marker-like line INSIDE Brain/ to confirm we skip it.
    writeFileSync(
      join(brainDirs(tmp).inbox, "sig-fake.md"),
      "---\nkind: brain-signal\n---\n@osb feedback negative topic=fake principle=x\n",
      "utf8",
    );
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.found).toBe(0);
  });

  test("rewrites the source file to '@osb✓ [[sig-...]]'", async () => {
    const notePath = writeMd(
      "Daily/2026-05-16.md",
      "@osb feedback negative topic=rewrite principle=p\n",
    );
    await scanInline(tmp, { agent: "test" });
    const after = readFileSync(notePath, "utf8");
    expect(after).toMatch(/^@osb✓ \[\[sig-.*-rewrite\]\] feedback negative topic=rewrite principle=p$/m);
  });

  test("is idempotent on second run (rewritten markers ignored)", async () => {
    writeMd(
      "Daily/2026-05-16.md",
      "@osb feedback negative topic=idemp principle=p\n",
    );
    const first = await scanInline(tmp, { agent: "test" });
    expect(first.created).toBe(1);

    const second = await scanInline(tmp, { agent: "test" });
    expect(second.found).toBe(0);
    expect(second.created).toBe(0);
    expect(second.deduped).toBe(0);
  });

  test("dedups against an existing inbox signal with the same dedup_hash", async () => {
    // First run creates one signal.
    const notePath = writeMd(
      "Daily/2026-05-16.md",
      "@osb feedback negative topic=dup principle=p\n",
    );
    await scanInline(tmp, { agent: "test" });

    // Restore the marker (simulate user re-pasting).
    writeFileSync(notePath, "@osb feedback negative topic=dup principle=p\n");

    const second = await scanInline(tmp, { agent: "test" });
    expect(second.found).toBe(1);
    expect(second.created).toBe(0);
    expect(second.deduped).toBe(1);

    // Only one signal on disk.
    const inboxFiles = readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md"));
    expect(inboxFiles.length).toBe(1);
  });

  test("--dry-run does not write signals or rewrite files", async () => {
    const notePath = writeMd(
      "Daily/2026-05-16.md",
      "@osb feedback negative topic=dry principle=p\n",
    );
    const before = readFileSync(notePath, "utf8");
    const result = await scanInline(tmp, { agent: "test", dryRun: true });
    expect(result.found).toBe(1);
    expect(result.created).toBe(0);
    expect(readFileSync(notePath, "utf8")).toBe(before);
    const inboxFiles = readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md"));
    expect(inboxFiles.length).toBe(0);
  });

  test("processes a fenced 'osb' block and writes signal + rewrites info-string", async () => {
    const notePath = writeMd(
      "Projects/foo.md",
      [
        "Before",
        "```osb",
        "kind: feedback",
        "signal: positive",
        "topic: block-test",
        "principle: long form text",
        "```",
        "After",
        "",
      ].join("\n"),
    );
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.created).toBe(1);
    const after = readFileSync(notePath, "utf8");
    expect(after).toMatch(/^```osb-checked$/m);
    expect(after).toMatch(/^<!-- @osb✓ \[\[sig-.*-block-test\]\] -->$/m);
  });

  test("--paths narrows the walker to specific subdirs", async () => {
    writeMd("Daily/d.md", "@osb feedback negative topic=in-daily principle=p\n");
    writeMd("Projects/p.md", "@osb feedback negative topic=in-projects principle=p\n");
    const result = await scanInline(tmp, {
      agent: "test",
      paths: ["Daily"],
    });
    expect(result.created).toBe(1);
    const inboxFiles = readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md"));
    const content = inboxFiles.map((f) =>
      readFileSync(join(brainDirs(tmp).inbox, f), "utf8"),
    );
    const joined = content.join("");
    expect(joined).toMatch(/topic: in-daily/);
    expect(joined).not.toMatch(/topic: in-projects/);
  });

  test("--exclude excludes additional directories", async () => {
    writeMd("Daily/d.md", "@osb feedback negative topic=ok principle=p\n");
    writeMd("Private/p.md", "@osb feedback negative topic=secret principle=p\n");
    const result = await scanInline(tmp, {
      agent: "test",
      exclude: ["Private"],
    });
    expect(result.created).toBe(1);
    const inboxFiles = readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md"));
    const joined = inboxFiles
      .map((f) => readFileSync(join(brainDirs(tmp).inbox, f), "utf8"))
      .join("");
    expect(joined).toMatch(/topic: ok/);
    expect(joined).not.toMatch(/topic: secret/);
  });

  test("skips .git and node_modules by default", async () => {
    writeMd(".git/info.md", "@osb feedback negative topic=git principle=p\n");
    writeMd("node_modules/lib.md", "@osb feedback negative topic=nm principle=p\n");
    writeMd("Daily/d.md", "@osb feedback negative topic=visible principle=p\n");
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.created).toBe(1);
  });

  test("skips files larger than 1 MiB", async () => {
    // Build a marker preceded by 1.5 MiB of filler.
    const filler = "x".repeat(1_500_000);
    writeMd(
      "Big/huge.md",
      `${filler}\n@osb feedback negative topic=huge principle=p\n`,
    );
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.found).toBe(0);
    expect(result.errors.some((e) => e.message.includes("too large"))).toBe(true);
  });

  test("counts malformed marker attempts without creating signals", async () => {
    writeMd("Daily/bad.md", "@osb feedback negative topic=missing-principle\n");
    const result = await scanInline(tmp, { agent: "test" });
    expect(result.found).toBe(0);
    expect(result.created).toBe(0);
    expect(result.malformed).toBe(1);
  });
});
