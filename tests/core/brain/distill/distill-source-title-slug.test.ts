/**
 * Distillation pages keep the non-Latin words of their source path, and a
 * distillation an older release wrote under the Latin-only slug is
 * rewritten in place on a re-distill, never doubled. The page stem is
 * `<slug>-<hash12>`; the hash names the source, so the old-slug page with
 * the same hash is the same record.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { tmpdir } from "node:os";

import { distillSource } from "../../../../src/core/brain/distill/distill-source.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { slugify } from "../../../../src/core/vault.ts";

let vault: string;
const NOW = new Date("2026-07-10T08:00:00Z");
const LATER = new Date("2026-07-11T09:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-slug-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/**
 * Distill `sourcePath`. The source file is written first unless
 * `withFile` is false: a path Windows reserves as a device name (`CON`)
 * cannot be an ordinary file there, and the page's stem is decided from
 * the path alone, so such a case needs no file.
 */
function distill(sourcePath: string, now: Date, withFile = true) {
  if (withFile) {
    const abs = join(vault, sourcePath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "# Title\n\nBody text.\n", "utf8");
  }
  return distillSource(
    vault,
    { sourcePath, claims: [{ text: "Body text." }] },
    { agent: "claude", now },
  );
}

for (const [sourcePath, words] of [
  ["Статьи/Проект release.md", "статьи-проект-release-md"],
  ["文章/重新质押.md", "文章-重新质押-md"],
] as const) {
  test(`a non-Latin source path keeps its words in the distillation page (${sourcePath})`, () => {
    const res = distill(sourcePath, NOW);
    expect(basename(res.distillationPath)).toMatch(
      new RegExp(`^[a-z]+-${words}-[0-9a-f]{12}\\.md$`, "u"),
    );
  });

  test(`a distillation stored under its old slug is rewritten in place (${sourcePath})`, () => {
    const first = distill(sourcePath, NOW);
    const hash = basename(first.distillationPath).slice(-15, -3);
    const firstName = basename(first.distillationPath);
    const prefix = firstName.slice(0, firstName.indexOf(words));
    const oldName = `${prefix}${slugify(sourcePath)}-${hash}.md`;
    const dir = join(vault, first.distillationPath, "..");
    renameSync(join(vault, first.distillationPath), join(dir, oldName));
    const again = distill(sourcePath, LATER);
    expect(again.created).toBe(false);
    expect(basename(again.distillationPath)).toBe(oldName);
    expect(readdirSync(dir).filter((name) => name.endsWith(`${hash}.md`))).toEqual([oldName]);
  });
}

test("an ASCII device-name source keeps the stem it always had", () => {
  expect(basename(distill("CON", NOW, false).distillationPath)).toMatch(
    /^[a-z]+-con-[0-9a-f]{12}\.md$/u,
  );
});

test("an old-slug distillation the caller may not read answers as an absent one", () => {
  const sourcePath = "Статьи/Проект release.md";
  const first = distill(sourcePath, NOW);
  const firstName = basename(first.distillationPath);
  const oldName = firstName.replace("статьи-проект-release-md", slugify(sourcePath));
  const dir = join(vault, first.distillationPath, "..");
  renameSync(join(vault, first.distillationPath), join(dir, oldName));
  // The reach predicate is asked with vault-relative POSIX paths, the
  // form `distillationPath` comes in, on every platform.
  const oldRel = posix.join(posix.dirname(first.distillationPath), oldName);
  const again = distillSource(
    vault,
    { sourcePath, claims: [{ text: "Body text." }] },
    { agent: "claude", now: LATER, readable: (rel) => rel !== oldRel },
  );
  // The answer an absent page gets: the new slug's path, created; the
  // withheld page is never read or rewritten.
  expect(again.distillationPath).toBe(first.distillationPath);
  expect(again.created).toBe(true);
});
