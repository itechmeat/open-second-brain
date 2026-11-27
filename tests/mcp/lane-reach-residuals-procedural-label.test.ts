/**
 * A derived label below local reach comes only from what the caller may
 * read (change `lane-reach-residuals`, package 2, design R2): a private
 * procedure tagged `Client Zeta`, read before a shared one tagged
 * `client-zeta`, titles the entity node both link to; a caller below
 * local reach sees that node with a title derived from its id
 * (`Tag: client-zeta` for the node `ent-tag-client-zeta`, design R2),
 * under an id that carries no spelling, its kept edges rewritten to it;
 * a local caller keeps the stored id.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const HELD = "Brain/procedures/zqa-label-held.md";
const SHARED = "Brain/procedures/zqb-label-shared.md";
const NODE = "ent-tag-client-zeta";

function procedure(title: string, tag: string, held: boolean): string {
  return [
    "---",
    "kind: brain-procedure",
    `tags: [${tag}]`,
    `title: ${title}`,
    "---",
    `# ${title}`,
    "",
    `zqlabel step ${held ? REGION : "shared"}`,
    "",
  ].join("\n");
}

/** Both procedures indexed and the graph rebuilt at local reach. */
async function seeded(): Promise<LaneEnv> {
  const e = makeLaneEnv("store", "osb-lane-procedural-label-");
  lane = e;
  writeLaneText(e.vault, join(e.vault, HELD), procedure("Zqlabel held", "Client Zeta", true));
  writeLaneText(e.vault, join(e.vault, SHARED), procedure("Zqlabel shared", "client-zeta", false));
  expect(laneEntryInPrivate(e.vault, join(e.vault, HELD))).toBe(true);
  expect(laneEntryInPrivate(e.vault, join(e.vault, SHARED))).toBe(false);
  const local = localServer(e);
  expect(await call(local, "brain_procedural_memory", { operation: "reconcile" })).not.toContain(
    '"error"',
  );
  expect(await call(local, "brain_procedural_graph", { operation: "rebuild" })).not.toContain(
    '"error"',
  );
  return e;
}

/** The nodes of a `show` answer. */
function nodesOf(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  const graph = (answer["graph"] ?? answer) as Record<string, unknown>;
  return (graph["nodes"] ?? []) as Array<Record<string, unknown>>;
}

/** The edges of a `show` answer. */
function edgesOf(answer: Record<string, unknown>): Array<Record<string, unknown>> {
  const graph = (answer["graph"] ?? answer) as Record<string, unknown>;
  return (graph["edges"] ?? []) as Array<Record<string, unknown>>;
}

/** The node `id` of a `show` answer, or undefined. */
function nodeOf(answer: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  return nodesOf(answer).find((node) => node["id"] === id);
}

/** The node of a `show` answer with the title `title`, or undefined. */
function nodeTitled(
  answer: Record<string, unknown>,
  title: string,
): Record<string, unknown> | undefined {
  return nodesOf(answer).find((node) => node["title"] === title);
}

describe("an entity node a private and a shared procedure link to", () => {
  test("below local reach the node is titled from its id, not from the private spelling", async () => {
    const e = await seeded();
    const answer = await callJson(server(e), "brain_procedural_graph", { operation: "show" });
    const node = nodeTitled(answer, "Tag: client-zeta");
    expect({
      kept: node !== undefined,
      title: node?.["title"],
      privateSpelling: JSON.stringify(answer).includes("Client Zeta"),
    }).toEqual({ kept: true, title: "Tag: client-zeta", privateSpelling: false });
  });

  test("below local reach the retitled node's id carries no spelling, and its kept edge follows it", async () => {
    const e = await seeded();
    const answer = await callJson(server(e), "brain_procedural_graph", { operation: "show" });
    const node = nodeTitled(answer, "Tag: client-zeta");
    const id = String(node?.["id"]);
    const edges = edgesOf(answer);
    expect({
      idSpelling: /zeta/i.test(id),
      storedId: JSON.stringify(answer).includes(NODE),
      ids: nodesOf(answer).filter((n) => n["id"] === id).length,
      edgeToNode: edges.some((edge) => edge["from"] === id || edge["to"] === id),
      danglingEdge: edges.some(
        (edge) =>
          !nodesOf(answer).some((n) => n["id"] === edge["from"]) ||
          !nodesOf(answer).some((n) => n["id"] === edge["to"]),
      ),
    }).toEqual({
      idSpelling: false,
      storedId: false,
      ids: 1,
      edgeToNode: true,
      danglingEdge: false,
    });
  });

  test("local control: a local caller keeps the node's id and its edges", async () => {
    const e = await seeded();
    const answer = await callJson(localServer(e), "brain_procedural_graph", { operation: "show" });
    expect(nodeOf(answer, NODE)).toBeDefined();
    expect(edgesOf(answer).some((edge) => edge["from"] === NODE || edge["to"] === NODE)).toBe(true);
  });

  test("local control: a local caller sees the node with its stored title", async () => {
    const e = await seeded();
    const answer = await callJson(localServer(e), "brain_procedural_graph", { operation: "show" });
    expect(nodeOf(answer, NODE)?.["title"]).toBe("Tag: Client Zeta");
  });
});
