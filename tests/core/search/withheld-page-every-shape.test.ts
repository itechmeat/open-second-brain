/**
 * One withheld page, every answer shape.
 *
 * The main result list drops a page the caller's reach, visibility scope,
 * owner scope or session/project scope withholds. Every other shape a
 * search answer can take - compact cards, the evidence pack's recall
 * union, the read planner, the by-chunk-id expansion, the relational
 * arm's provenance path - must withhold the
 * same page from the same caller, or it names (or serves) what the result
 * list hides.
 *
 * The fixture is built so that each shape would name the withheld page if
 * it skipped the filters: the page matches every query term, its title
 * matches the planner's seed rule, and it holds the only occurrence of one
 * term, so the union reaches for it when the result list leaves that term
 * uncovered.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { expandHit } from "../../../src/core/search/cards.ts";
import { planRead } from "../../../src/core/search/graph-prepass.ts";
import {
  cachedAnswerAdmitted,
  resolvePoolFilters,
} from "../../../src/core/search/pipeline/pool-filters.ts";
import { runRelationalArm } from "../../../src/core/search/pipeline/relational-arm.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { SearchOptions } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const QUERY = "zephyr xylophone";
const VISIBLE = "visible.md";
const WITHHELD = "withheld.md";
const HUB = "hub.md";

type Caller = Pick<SearchOptions, "transportReach" | "visibility" | "agentScope" | "scope">;

interface Row {
  readonly name: string;
  /** Frontmatter lines of the withheld page. */
  readonly frontmatter: string;
  /** The caller the page is withheld from. */
  readonly caller: Caller;
  /** A caller the page is NOT withheld from: proves the fixture reaches it. */
  readonly admitted: Caller;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "reserved page at remote reach",
    frontmatter: "visibility: [private]",
    caller: { transportReach: TRANSPORT_REACH.remote },
    admitted: { transportReach: TRANSPORT_REACH.local, visibility: ["private"] },
  },
  {
    name: "tagged page under the default visibility scope",
    frontmatter: "visibility: [team]",
    caller: { transportReach: TRANSPORT_REACH.local },
    admitted: { transportReach: TRANSPORT_REACH.local, visibility: ["team"] },
  },
  {
    name: "another owner's page under an owner scope",
    frontmatter: "owner: other-agent",
    caller: { transportReach: TRANSPORT_REACH.local, agentScope: "me" },
    admitted: { transportReach: TRANSPORT_REACH.local, agentScope: "other-agent" },
  },
  {
    name: "another project's page under a project scope",
    frontmatter: "project: beta",
    caller: { transportReach: TRANSPORT_REACH.local, scope: { project: "alpha" } },
    admitted: { transportReach: TRANSPORT_REACH.local, scope: { project: "beta" } },
  },
];

interface Shapes {
  readonly results: ReadonlyArray<string>;
  readonly cards: ReadonlyArray<string>;
  readonly union: ReadonlyArray<string>;
  readonly plan: ReadonlyArray<string>;
  readonly expanded: ReadonlyArray<string>;
  readonly provenance: ReadonlyArray<string>;
}

describe("a withheld page appears in no answer shape", () => {
  let vault: string;
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ vault, dbPath, cleanup } = createTempVault("withheld-shapes"));
  });
  afterEach(() => cleanup());

  async function shapesFor(caller: Caller, cacheEnabled = false): Promise<Shapes> {
    const cfg = makeConfig({ vault, dbPath, cacheEnabled });
    const full = await search(cfg, { query: QUERY, limit: 10, ...caller });
    const cards = await search(cfg, { query: QUERY, limit: 10, disclosure: "cards", ...caller });
    // A query whose results cover "zephyr" only, so the union reaches for
    // "xylophone", which only the withheld page holds.
    const pack = await search(cfg, {
      query: QUERY,
      limit: 1,
      evidencePack: true,
      ...caller,
    });
    const plan = await planRead(cfg, QUERY, { filters: caller });
    // The by-chunk-id expansion of every chunk the index holds: chunk ids
    // are sequential, so this is what an enumerating caller would walk.
    const store = await Store.open(cfg, { mode: "read" });
    let chunkIds: number[];
    let provenance: string[];
    try {
      const titles = store.documentTitles();
      chunkIds = [...titles.keys()].flatMap((id) => store.getChunksByDocument(id).map((c) => c.id));
      // The relational arm's ordered path from the hub: hub -> withheld
      // -> visible, so the visible node's provenance names the withheld
      // page as its middle step unless the arm withholds it.
      const arm = runRelationalArm(store, vault, "[[hub]] related extends", {
        ...(caller.transportReach !== undefined ? { reach: caller.transportReach } : {}),
        ...(caller.visibility !== undefined ? { visibility: caller.visibility } : {}),
        ...(caller.agentScope !== undefined ? { agentScope: caller.agentScope } : {}),
        ...(caller.scope !== undefined ? { scope: caller.scope } : {}),
      });
      provenance = [...arm.reachByChunk.values()].flatMap((r) =>
        r.path.map((step) => titles.get(step.documentId)?.path ?? String(step.documentId)),
      );
    } finally {
      await store.close();
    }
    // A refused chunk rejects exactly like an absent one.
    const expanded = (
      await Promise.allSettled(chunkIds.map((chunkId) => expandHit(cfg, { chunkId, ...caller })))
    ).flatMap((r) => (r.status === "fulfilled" ? [r.value.note.path] : []));
    return {
      results: full.results.map((r) => r.path),
      cards: (cards.cards ?? []).map((c) => c.path),
      union: (pack.evidencePack?.unionRecords ?? []).map((r) => r.path),
      plan: plan.shortlist.map((e) => e.path),
      expanded,
      provenance,
    };
  }

  for (const row of ROWS) {
    for (const cached of [false, true])
      test(`${row.name}${cached ? ", query cache warmed by an admitted caller" : ""}`, async () => {
        writeMd(vault, VISIBLE, "# Zephyr notes\n\nzephyr zephyr zephyr field notes");
        writeMd(vault, HUB, '---\nrelated: "[[withheld]]"\n---\n\nhub page.');
        writeMd(
          vault,
          WITHHELD,
          `---\n${row.frontmatter}\nextends: "[[visible]]"\n---\n# Zephyr Xylophone\n\nzephyr xylophone [[visible]]`,
        );
        await indexVault(makeConfig({ vault, dbPath }));

        // With the query cache on, the admitted caller's answers are cached
        // first: the withheld caller's same queries must not be served them.
        const admitted = await shapesFor(row.admitted, cached);
        expect(admitted.results).toContain(WITHHELD);
        expect(admitted.cards).toContain(WITHHELD);
        expect(admitted.plan).toContain(WITHHELD);
        expect(admitted.expanded).toContain(WITHHELD);
        expect(admitted.provenance).toContain(WITHHELD);

        const shapes = await shapesFor(row.caller, cached);
        for (const [shape, paths] of Object.entries(shapes)) {
          expect({ shape, paths }).toEqual({
            shape,
            paths: paths.filter((p: string) => p !== WITHHELD),
          });
        }
      });
  }

  test("a cached answer is not served once the page's frontmatter withholds it, before any reindex", async () => {
    writeMd(vault, VISIBLE, "# Zephyr notes\n\nzephyr zephyr zephyr field notes");
    writeMd(vault, WITHHELD, "# Zephyr Xylophone\n\nzephyr xylophone [[visible]]");
    await indexVault(makeConfig({ vault, dbPath }));
    const cfg = makeConfig({ vault, dbPath, cacheEnabled: true });
    const remote = { transportReach: TRANSPORT_REACH.remote };
    const warm = await search(cfg, { query: QUERY, limit: 10, ...remote });
    expect(warm.results.map((r) => r.path)).toContain(WITHHELD);
    // The page is reserved on disk; the index has not seen the edit yet.
    writeMd(
      vault,
      WITHHELD,
      "---\nvisibility: [private]\n---\n# Zephyr Xylophone\n\nzephyr xylophone [[visible]]",
    );
    const uncached = await search(makeConfig({ vault, dbPath }), {
      query: QUERY,
      limit: 10,
      ...remote,
    });
    const again = await search(cfg, { query: QUERY, limit: 10, ...remote });
    expect(again.results.map((r) => r.path)).toEqual(uncached.results.map((r) => r.path));
    expect(again.results.map((r) => r.path)).not.toContain(WITHHELD);
  });

  test("a folded duplicate location the filters now withhold is named on neither the row nor the card", async () => {
    const twin = "# Twin\n\nquartz meridian lantern passage";
    writeMd(vault, "alpha.md", twin);
    writeMd(vault, "beta.md", twin);
    await indexVault(makeConfig({ vault, dbPath }));
    const cfg = makeConfig({ vault, dbPath });
    const local = { transportReach: TRANSPORT_REACH.local };
    const dupPaths = async () => {
      const full = await search(cfg, { query: "quartz meridian", limit: 10, ...local });
      const cards = await search(cfg, {
        query: "quartz meridian",
        limit: 10,
        disclosure: "cards",
        ...local,
      });
      return {
        rows: full.results.flatMap((r) => [r.path, ...(r.duplicates ?? []).map((d) => d.path)]),
        cards: (cards.cards ?? []).flatMap((c) => [c.path, ...(c.duplicatePointers ?? [])]),
      };
    };
    // The fixture folds one copy into the other.
    const before = await dupPaths();
    expect(before.rows.toSorted()).toEqual(["alpha.md", "beta.md"]);
    // One copy is tagged on disk; the index has not seen the edit, so the
    // two still fold into one row.
    writeMd(vault, "beta.md", `---\nvisibility: [team]\n---\n${twin}`);
    const after = await dupPaths();
    expect(after.rows).toEqual(["alpha.md"]);
    expect(after.cards.some((p) => p.startsWith("beta.md"))).toBe(false);
  });

  test("a cached answer is judged by the pages its trail ids and card pointers name", async () => {
    writeMd(vault, VISIBLE, "# Zephyr notes\n\nzephyr field notes");
    writeMd(vault, "mid.md", "# Mid\n\nbeta mid document");
    await indexVault(makeConfig({ vault, dbPath }));
    const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "read" });
    try {
      const midId = store.getDocumentIdByPath("mid.md")!;
      // Only a relational trail id, or only a card's duplicate pointer,
      // names the page: no `path` string anywhere in the row.
      const shapes = {
        trail: {
          results: [{ path: VISIBLE }],
          retrievalTrail: { relationalPaths: [{ code: "relational-path", path: [midId] }] },
        },
        pointer: { cards: [{ path: VISIBLE, duplicatePointers: ["mid.md:L1-L3"] }] },
      };
      const admitted = (shape: unknown) =>
        cachedAnswerAdmitted(
          shape,
          resolvePoolFilters({ query: "", transportReach: TRANSPORT_REACH.remote }),
          {
            vault,
            store,
            frontmatterCache: new Map(),
          },
        );
      for (const [name, shape] of Object.entries(shapes)) {
        expect([name, admitted(shape)]).toEqual([name, true]);
      }
      // The page is reserved on disk; nothing reindexes.
      writeMd(vault, "mid.md", "---\nvisibility: [private]\n---\n# Mid\n\nbeta mid document");
      for (const [name, shape] of Object.entries(shapes)) {
        expect([name, admitted(shape)]).toEqual([name, false]);
      }
    } finally {
      await store.close();
    }
  });

  test("the union still names an admitted page for an uncovered term", async () => {
    writeMd(vault, VISIBLE, "# Zephyr notes\n\nzephyr zephyr zephyr field notes");
    writeMd(vault, "other.md", "# Other\n\nxylophone");
    await indexVault(makeConfig({ vault, dbPath }));
    const cfg = makeConfig({ vault, dbPath });
    const pack = await search(cfg, {
      query: QUERY,
      limit: 1,
      evidencePack: true,
      transportReach: TRANSPORT_REACH.remote,
    });
    const named = (pack.evidencePack?.unionRecords ?? []).map((r) => r.path);
    expect(pack.results.map((r) => r.path)).toEqual([VISIBLE]);
    expect(named).toContain("other.md");
  });
});
