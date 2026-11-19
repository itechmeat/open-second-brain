/**
 * Census of the files the in-vault state writers name, against the store
 * migration's claims (change migration-sync-conflict-copies, follow-up 3).
 *
 * `STATE_SURFACES` names one durable location per row, and the migration
 * catalogue claims exactly those locations. A writer module that owns a
 * row often keeps more than one file beside it: the freshen child keeps
 * its claim (`freshen.claim`) and its pending marker
 * (`freshen-pending.json`) beside `freshen-state.json`, and a start
 * whose process died leaves the claim behind. Such a file is on disk when
 * a migration scans, no locator claims it, and the dry run refuses the
 * whole vault over it.
 *
 * So the population is taken from the writers, not from a list of names:
 * for every row whose location is under `<vault>/Brain/` or
 * `<vault>/.open-second-brain/`, every module its `sources` names, and
 * every file-name constant such a module declares
 * (`const NAME = "<name>.<ext>"`, a known file extension, not a bare
 * suffix such as `.tar.zst`), the file is planted where the module keeps
 * its files (beside the row's file, or inside the row's folder) in an
 * otherwise empty legacy tree, and the migration's walk must claim it.
 * A name that can never be on disk there while a migration scans is
 * listed in {@link NOT_IN_THE_TREE} with the reason.
 *
 * What this cannot see, stated rather than implied: a file name a writer
 * builds at run time with no constant (a temp name with a pid, which
 * `fs-atomic.ts` `writerTempOriginals` and the sibling-family test cover),
 * and a writer that is in no row's `sources` (the state-surface census
 * fails on that one first).
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";

import { STATE_SURFACES } from "../../../src/core/state/surfaces.ts";
import {
  legacyRootNames,
  migrationCatalogue,
} from "../../../src/core/store-migration/catalogue.ts";
import { unclaimedEntries } from "../../../src/core/store-migration/legacy-claims.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Extensions of the files a writer keeps; a constant with another one is not a file name. */
const FILE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".lock",
  ".claim",
  ".sqlite",
  ".md",
  ".yaml",
  ".txt",
  ".key",
  ".pub",
  ".pem",
  ".log",
]);

const FILE_CONSTANT_RE =
  /\bconst\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*["'`]([A-Za-z0-9_][\w.-]*)["'`]/g;

/** Planted targets (vault-relative) that are never in the legacy tree when a migration scans. */
const NOT_IN_THE_TREE: Readonly<Record<string, string>> = {};

interface Target {
  readonly rel: string;
  readonly row: string;
  readonly module: string;
}

function modulesOf(sources: ReadonlyArray<string>): string[] {
  return sources.flatMap((source) => {
    const abs = join(REPO_ROOT, source);
    if (source.endsWith("/")) {
      if (!existsSync(abs)) return [];
      return readdirSync(abs)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => source + name);
    }
    return existsSync(abs) ? [source] : [];
  });
}

function targets(vault: string): Target[] {
  const out = new Map<string, Target>();
  for (const row of STATE_SURFACES) {
    const rel = relative(vault, row.derive(vault, null)).split(sep).join("/");
    if (!rel.startsWith("Brain/") && !rel.startsWith(".open-second-brain/")) continue;
    // A row that is a folder keeps its files inside it; a file row, beside it.
    const dir = extname(rel) === "" ? rel : dirname(rel);
    for (const module of modulesOf(row.sources)) {
      const text = readFileSync(join(REPO_ROOT, module), "utf8");
      for (const match of text.matchAll(FILE_CONSTANT_RE)) {
        const name = match[1]!;
        if (!FILE_EXTENSIONS.has(extname(name))) continue;
        const target = `${dir}/${name}`;
        if (!out.has(target)) out.set(target, { rel: target, row: row.id, module });
      }
    }
  }
  return [...out.values()].toSorted((a, b) => (a.rel < b.rel ? -1 : 1));
}

/** Whether the migration's walk claims `rel`, alone in an otherwise empty legacy tree. */
function claimed(vault: string, rel: string): boolean {
  for (const top of ["Brain", ".open-second-brain"]) {
    rmSync(join(vault, top), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    mkdirSync(join(vault, top), { recursive: true });
  }
  const path = join(vault, ...rel.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"token":"fr-x","at":1}\n');
  const catalogue = migrationCatalogue(vault);
  const roots = legacyRootNames(vault, catalogue).map((top) => join(vault, top));
  return (
    unclaimedEntries(
      vault,
      roots,
      catalogue.flatMap((entry) => entry.locators),
    ).length === 0
  );
}

describe("files the in-vault state writers name", () => {
  const parent = mkdtempSync(join(tmpdir(), "osb-writer-targets-"));
  const vault = join(parent, "vault");
  mkdirSync(vault, { recursive: true });
  const all = targets(vault);

  test("the sweep finds the writers' files, the freshen claim among them", () => {
    const rels = all.map((t) => t.rel);
    expect(rels).toContain(".open-second-brain/freshen.claim");
    expect(rels).toContain(".open-second-brain/freshen-pending.json");
    // A sweep that stopped matching would check nothing and pass, so the
    // count is pinned: a moved number names the writer that added or
    // dropped a file in the same commit.
    // 21: the first sweep (change migration-sync-conflict-copies).
    expect(all.length).toBe(21);
  });

  test("every one is claimed by a migration locator or listed with a reason", () => {
    try {
      const gaps = all
        .filter((t) => !(t.rel in NOT_IN_THE_TREE) && !claimed(vault, t.rel))
        .map((t) => `${t.rel} (${t.row}, ${t.module})`);
      expect(gaps).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test("every listed name is still one the sweep finds, with an argument for a reason", () => {
    const rels = new Set(all.map((t) => t.rel));
    for (const [rel, reason] of Object.entries(NOT_IN_THE_TREE)) {
      expect([rel, rels.has(rel)]).toEqual([rel, true]);
      expect(reason.length).toBeGreaterThan(80);
    }
  });
});
