/**
 * Owner-scope isolation on the search-backed surfaces and the
 * progressive-disclosure drill-down (context-integrity-gates, Unit A /
 * Task 7).
 *
 * These surfaces reach `isOwnerVisible` through the existing
 * `SearchOptions.agentScope`, so the filter is per-call opt-in and NOT
 * behind `integrity.owner_scope_delivery`: a caller that explicitly asks
 * for a scope has asked to be isolated, and a gate that quietly ignored
 * the request would return another owner's pages to a caller who
 * believed it was scoped. An omitted scope filters nothing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deepSynthesis } from "../../../src/core/brain/deep-synthesis.ts";
import { fileContextRecall } from "../../../src/core/brain/file-recall.ts";
import { expandHit } from "../../../src/core/search/cards.ts";
import { indexVault, resolveSearchConfig, search } from "../../../src/core/search/index.ts";
import { SearchError, type ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const QUERY = "lattice widgets";
/** Probe path whose derived query terms appear verbatim in every note. */
const PROBE = "lattice-widgets.md";
const PROBE_TERMS = `${PROBE} lattice-widgets`;

const NOW = new Date("2026-05-10T00:00:00Z");

let vault: string;
let configHome: string;
let config: ResolvedSearchConfig;

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-agent-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-agent-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes", "owned-a.md"),
    `---\nowner: ${OWNER_A}\n---\n\n${QUERY} ${PROBE_TERMS} owned by a\n`,
  );
  writeFileSync(
    join(vault, "notes", "owned-b.md"),
    `---\nowner: ${OWNER_B}\n---\n\n${QUERY} ${PROBE_TERMS} owned by b\n`,
  );
  writeFileSync(join(vault, "notes", "shared.md"), `# Shared\n\n${QUERY} ${PROBE_TERMS} shared\n`);
  config = resolveSearchConfig({ vault, configPath });
  await indexVault(config, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

async function chunkIdFor(relPath: string): Promise<number> {
  const outcome = await search(config, { query: QUERY, limit: 20 });
  const hit = outcome.results.find((r) => r.path === relPath);
  expect(hit).toBeDefined();
  return hit!.chunkId;
}

test("fileContextRecall scopes to the requesting owner", async () => {
  const unscoped = await fileContextRecall(config, {
    filePath: join(vault, "notes", PROBE),
    minBytes: 0,
  });
  const unscopedPaths = unscoped.results.map((r) => r.path);
  expect(unscopedPaths).toContain("notes/owned-a.md");
  expect(unscopedPaths).toContain("notes/owned-b.md");

  const scoped = await fileContextRecall(config, {
    filePath: join(vault, "notes", PROBE),
    minBytes: 0,
    agentScope: OWNER_A,
  });
  const scopedPaths = scoped.results.map((r) => r.path);
  expect(scopedPaths).not.toContain("notes/owned-b.md");
  expect(scopedPaths).toContain("notes/owned-a.md");
  expect(scopedPaths).toContain("notes/shared.md");
});

test("deepSynthesis scopes to the requesting owner", async () => {
  const unscoped = await deepSynthesis(config, QUERY, { now: NOW, limit: 20 });
  expect(unscoped.notes.map((m) => m.path)).toContain("notes/owned-b.md");

  const scoped = await deepSynthesis(config, QUERY, { now: NOW, limit: 20, agentScope: OWNER_A });
  const paths = scoped.notes.map((m) => m.path);
  expect(paths).not.toContain("notes/owned-b.md");
  expect(paths).toContain("notes/owned-a.md");
  expect(paths).toContain("notes/shared.md");
});

test("expandHit refuses another owner's chunk exactly as if it were absent", async () => {
  const foreign = await chunkIdFor("notes/owned-b.md");

  // Unscoped: the drill-down works, so the refusal below is the scope.
  const open = await expandHit(config, { chunkId: foreign });
  expect(open.note.path).toBe("notes/owned-b.md");

  const absentId = 999_999;
  const absentError = await expandHit(config, { chunkId: absentId }).then(
    () => null,
    (e: unknown) => e as SearchError,
  );
  const refusedError = await expandHit(config, { chunkId: foreign, agentScope: OWNER_A }).then(
    () => null,
    (e: unknown) => e as SearchError,
  );

  expect(absentError).toBeInstanceOf(SearchError);
  expect(refusedError).toBeInstanceOf(SearchError);
  expect(refusedError!.code).toBe(absentError!.code);
  // Indistinguishable but for the id the caller itself supplied: the
  // message must not reveal that the chunk exists and is owned.
  expect(refusedError!.message).toBe(`chunk not found: ${foreign}`);
  expect(absentError!.message).toBe(`chunk not found: ${absentId}`);
});

test("expandHit serves the owner's own chunk and every shared one", async () => {
  const own = await chunkIdFor("notes/owned-a.md");
  const shared = await chunkIdFor("notes/shared.md");

  expect((await expandHit(config, { chunkId: own, agentScope: OWNER_A })).note.path).toBe(
    "notes/owned-a.md",
  );
  expect((await expandHit(config, { chunkId: shared, agentScope: OWNER_A })).note.path).toBe(
    "notes/shared.md",
  );
});

test("expandHit with a blank scope is byte-identical to an unscoped call", async () => {
  const foreign = await chunkIdFor("notes/owned-b.md");
  const unscoped = await expandHit(config, { chunkId: foreign });
  const blank = await expandHit(config, { chunkId: foreign, agentScope: "   " });
  expect(JSON.stringify(blank)).toBe(JSON.stringify(unscoped));
});

// ----- A1: the isolation boundary must fail CLOSED -------------------------

/**
 * A document still in the index whose FILE is gone (deleted, renamed, or
 * made unreadable since the last index run) has an unknowable owner. Both
 * `isPathOwnerVisible` and `expandHit`'s per-hit check document that they
 * fail closed; this pins that they actually do, on the ranked path and on
 * the drill-down.
 */
test("a deleted owner-tagged file is hidden from another owner, not shared", async () => {
  const foreign = await chunkIdFor("notes/owned-a.md");
  rmSync(join(vault, "notes", "owned-a.md"));

  const scoped = await search(config, { query: QUERY, limit: 20, agentScope: OWNER_B });
  expect(scoped.results.map((r) => r.path)).not.toContain("notes/owned-a.md");

  const refused = await expandHit(config, { chunkId: foreign, agentScope: OWNER_B }).then(
    () => null,
    (e: unknown) => e as SearchError,
  );
  expect(refused).toBeInstanceOf(SearchError);
  expect(refused!.message).toBe(`chunk not found: ${foreign}`);
});

test("an unreadable owner-tagged file is hidden from another owner", async () => {
  const target = join(vault, "notes", "owned-a.md");
  const foreign = await chunkIdFor("notes/owned-a.md");
  chmodSync(target, 0o000);
  try {
    const scoped = await search(config, { query: QUERY, limit: 20, agentScope: OWNER_B });
    expect(scoped.results.map((r) => r.path)).not.toContain("notes/owned-a.md");
    const refused = await expandHit(config, { chunkId: foreign, agentScope: OWNER_B }).then(
      () => null,
      (e: unknown) => e as SearchError,
    );
    expect(refused).toBeInstanceOf(SearchError);
  } finally {
    chmodSync(target, 0o644);
  }
});

test("an unscoped call still serves a deleted file's indexed chunk", async () => {
  const chunkId = await chunkIdFor("notes/owned-a.md");
  rmSync(join(vault, "notes", "owned-a.md"));
  const unscoped = await search(config, { query: QUERY, limit: 20 });
  expect(unscoped.results.map((r) => r.path)).toContain("notes/owned-a.md");
  expect((await expandHit(config, { chunkId })).note.path).toBe("notes/owned-a.md");
});

// ----- A2: a present-but-unusable `owner:` is never ownerless --------------

const LIST_OWNER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["block", `owner:\n  - ${OWNER_A}\n  - ${OWNER_B}`],
  ["inline", `owner: [${OWNER_A}, ${OWNER_B}]`],
  ["mapping", `owner:\n  name: ${OWNER_A}`],
]);

for (const [shape, frontmatter] of LIST_OWNER_SHAPES) {
  test(`a ${shape}-shaped owner: is withheld from a scoped caller, not shared`, async () => {
    const rel = `notes/owner-${shape}.md`;
    writeFileSync(
      join(vault, rel),
      `---\n${frontmatter}\n---\n\n${QUERY} ${PROBE_TERMS} ${shape} owner\n`,
    );
    await indexVault(config, {});

    const unscoped = await search(config, { query: QUERY, limit: 20 });
    expect(unscoped.results.map((r) => r.path)).toContain(rel);

    const perScope = await Promise.all(
      [OWNER_A, OWNER_B].map((scope) =>
        search(config, { query: QUERY, limit: 20, agentScope: scope }),
      ),
    );
    for (const scoped of perScope) {
      expect(scoped.results.map((r) => r.path)).not.toContain(rel);
    }

    const chunkId = (await search(config, { query: QUERY, limit: 20 })).results.find(
      (r) => r.path === rel,
    )!.chunkId;
    const refused = await expandHit(config, { chunkId, agentScope: OWNER_A }).then(
      () => null,
      (e: unknown) => e as SearchError,
    );
    expect(refused).toBeInstanceOf(SearchError);
  });
}
