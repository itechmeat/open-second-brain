/**
 * Source summary pages keep the non-Latin words of their source path, and
 * a summary an older release wrote under the Latin-only slug is rewritten
 * in place on re-ingest, never doubled. The page stem is
 * `<slug>-<hash12>`; the hash names the source, so the old-slug page with
 * the same hash is the same record.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, posix } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { slugify } from "../../../../src/core/vault.ts";

let vault: string;
let configHome: string;
const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-slug-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-slug-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Ingest `sourcePath`. The source file is written first unless
 * `withFile` is false: a path Windows reserves as a device name (`CON`)
 * cannot be an ordinary file there, and the summary's stem is decided
 * from the path alone, so such a case needs no file.
 */
function ingest(sourcePath: string, now: Date, withFile = true) {
  if (withFile) {
    const abs = join(vault, sourcePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "the source bytes\n", "utf8");
  }
  return ingestSource(
    vault,
    { sourcePath, summary: "A summary.", extraction: { entities: [], relations: [] } },
    { agent: "claude", now },
  );
}

function sourcesDir(summaryPath: string): string {
  return join(vault, summaryPath, "..");
}

for (const [sourcePath, words] of [
  ["Статьи/Проект release.md", "статьи-проект-release-md"],
  ["文章/重新质押.md", "文章-重新质押-md"],
] as const) {
  test(`a non-Latin source path keeps its words in the summary page (${sourcePath})`, () => {
    const res = ingest(sourcePath, NOW);
    expect(basename(res.summaryPath)).toMatch(
      new RegExp(`^[a-z]+-${words}-[0-9a-f]{12}\\.md$`, "u"),
    );
  });

  test(`a summary stored under its old slug is rewritten in place (${sourcePath})`, () => {
    const first = ingest(sourcePath, NOW);
    const hash = basename(first.summaryPath).slice(-15, -3);
    const firstName = basename(first.summaryPath);
    const prefix = firstName.slice(0, firstName.indexOf(words));
    const oldName = `${prefix}${slugify(sourcePath)}-${hash}.md`;
    const dir = sourcesDir(first.summaryPath);
    renameSync(join(vault, first.summaryPath), join(dir, oldName));
    const again = ingest(sourcePath, LATER);
    expect(again.created).toBe(false);
    expect(basename(again.summaryPath)).toBe(oldName);
    expect(readdirSync(dir).filter((name) => name.endsWith(`${hash}.md`))).toEqual([oldName]);
  });
}

test("an ASCII device-name source keeps the stem it always had", () => {
  const res = ingest("CON", NOW, false);
  expect(basename(res.summaryPath)).toMatch(/^[a-z]+-con-[0-9a-f]{12}\.md$/u);
});

test("an old-slug summary the caller may not read answers as an absent one", () => {
  const sourcePath = "Статьи/Проект release.md";
  const first = ingest(sourcePath, NOW);
  const dir = sourcesDir(first.summaryPath);
  const firstName = basename(first.summaryPath);
  const oldName = firstName.replace("статьи-проект-release-md", slugify(sourcePath));
  renameSync(join(vault, first.summaryPath), join(dir, oldName));
  // The reach predicate is asked with vault-relative POSIX paths, the
  // form `summaryPath` comes in, on every platform.
  const oldRel = posix.join(posix.dirname(first.summaryPath), oldName);
  const before = readFileSync(join(dir, oldName), "utf8");
  const abs = join(vault, sourcePath);
  const withheld = ingestSource(
    vault,
    { sourcePath, summary: "A summary.", extraction: { entities: [], relations: [] } },
    { agent: "claude", now: LATER, readable: (rel) => rel !== oldRel },
  );
  // The answer an absent page gets: the new slug's path, created.
  expect(withheld.summaryPath).toBe(first.summaryPath);
  expect(withheld.created).toBe(true);
  expect(readFileSync(join(dir, oldName), "utf8")).toBe(before);
  expect(readFileSync(abs, "utf8")).toBe("the source bytes\n");
});
