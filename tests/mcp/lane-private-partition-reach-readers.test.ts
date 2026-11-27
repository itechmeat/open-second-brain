/**
 * Every reader that judges lane pages by the caller's reach withholds a
 * lane entry the store holds in its `private` partition.
 *
 * The reproduction (`lane-private-partition-reach.test.ts`) proves the
 * rule for the pledge, the obligation and the today brief. This file is
 * the table over the readers of design D5: one row per reader, each run
 * on a machine whose lane pages live in the store and on one with no
 * vault.
 *
 * Every row writes two entries of the reader's lane: one whose text
 * carries a `<private>` region (the store holds that one in its `private`
 * partition, and its frontmatter reserves nothing) and one ordinary
 * shared entry. The reader is then asked at a remote reach and at a local
 * reach, and the write verbs of the row are addressed to the hidden
 * entry at a remote reach.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { proceduralEntryId } from "../../src/core/brain/procedural-memory.ts";
import { setIntention } from "../../src/core/brain/intentions.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { foldIncomplete } from "../../src/core/store/lane-entry-store.ts";
import { makeLaneEnv, type LaneEnv, type LaneMode } from "../core/lanes/fixtures/lane-env.ts";

/** The text of the `<private>` region the hidden entries carry. */
const REGION_BODY = "synthetic region body";
const REGION = `<private>${REGION_BODY}</private>`;
const AGENT = "tester";
const CREATED_AT = "2026-11-01T00:00:00Z";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

/** One entry of a lane: where it lives and how it is named. */
interface Entry {
  /** The absolute path of the lane page. */
  readonly path: string;
  /** The vault-relative path of the lane page. */
  readonly rel: string;
  /** The identity the reader names it by (a slug, a scope, a path). */
  readonly identity: string;
  /** The text the reader may carry of it. */
  readonly title: string;
}

/** A write verb of a row, addressed to an entry by its identity. */
interface Verb {
  readonly name: string;
  /** The identity the verb addresses: a slug, a scope, an entry id. */
  readonly id: (entry: Entry) => string;
  /** The identity of an entry that is not there. */
  readonly absentId?: string;
  /**
   * False when the tool's own rule gives a withheld entry an answer of its
   * own (the refusal a write that would rewrite a chain it may not read
   * gets): the answer carries no content of the entry and changes nothing.
   */
  readonly same?: boolean;
  /** What the local read after the write must still show of the entry. */
  readonly unchanged?: (after: string) => boolean;
  readonly call: (server: MCPServer, id: string) => Promise<Record<string, unknown>>;
}

/** One reader of the table. */
interface Row {
  readonly reader: string;
  /** Write the row's hidden and shared entries into the lane. */
  readonly write: (root: string) => { readonly hidden: Entry; readonly shared: Entry };
  /** The read the row asserts on. */
  readonly read: (server: MCPServer) => Promise<Record<string, unknown>>;
  /** Whether the answer carries the shared entry. */
  readonly sharedVisible: (answer: Record<string, unknown>, mode: LaneMode) => boolean;
  /** The write verbs addressed to the hidden entry. */
  readonly verbs?: ReadonlyArray<Verb>;
  /** A step the row needs before it is read (an index the reader reads). */
  readonly prepare?: (lane: LaneEnv) => Promise<void>;
  /**
   * Whether a local read shows the hidden entry at all in that mode: the
   * today view reads the vault's own pages, and a server with no vault
   * has none to read.
   */
  readonly localShows?: (mode: LaneMode) => boolean;
}

// ----- The pages the rows write -----------------------------------------------

/** A lane page as text: frontmatter fields and a body. */
function page(fields: Readonly<Record<string, string>>, body: string): string {
  const front = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${front}\n---\n\n${body}\n`;
}

function pledgePage(title: string, body: string): string {
  return page(
    {
      title,
      due: "2026-12-01",
      created_at: CREATED_AT,
      agent: AGENT,
    },
    body,
  );
}

function obligationPage(title: string, body: string): string {
  return page({ title, cadence: "weekly", created_at: CREATED_AT, agent: AGENT }, body);
}

function decisionPage(slug: string, title: string, body: string): string {
  return page(
    {
      type: "decision",
      id: `decision-${slug}`,
      title,
      chosen: "the chosen course",
      assumption: "the assumption",
      review_date: "2026-12-01",
      created_at: CREATED_AT,
      agent: AGENT,
      outcome: "",
    },
    body,
  );
}

function clusterPage(cluster: string, body: string): string {
  return page(
    {
      kind: "brain-cluster",
      cluster,
      size: "2",
      density: "0.5",
      generated_at: CREATED_AT,
    },
    body,
  );
}

function procedurePage(title: string, body: string): string {
  return page({ title }, body);
}

/** The proposals artifact: the table the bridges reader parses. */
function proposalsPage(body: string): string {
  return page(
    { proposals: "1" },
    [
      "| source | target | similarity | inbound (src/tgt) |",
      "| --- | --- | --- | --- |",
      "| [[alpha]] (Brain/notes/alpha.md) | [[beta]] (Brain/notes/beta.md) | 0.5 | 1 |",
      "",
      body,
    ].join("\n"),
  );
}

// ----- The table ---------------------------------------------------------------

const ROWS: ReadonlyArray<Row> = [
  {
    reader: "brain_pledge",
    write: (root) => {
      const hiddenPath = join(root, "Brain", "pledges", "synthetic-hidden-pledge.md");
      const sharedPath = join(root, "Brain", "pledges", "synthetic-shared-pledge.md");
      writeLaneText(root, hiddenPath, pledgePage("Synthetic hidden pledge", REGION));
      writeLaneText(root, sharedPath, pledgePage("Synthetic shared pledge", "shared body"));
      return {
        hidden: {
          path: hiddenPath,
          rel: "Brain/pledges/synthetic-hidden-pledge.md",
          identity: "synthetic-hidden-pledge",
          title: "Synthetic hidden pledge",
        },
        shared: {
          path: sharedPath,
          rel: "Brain/pledges/synthetic-shared-pledge.md",
          identity: "synthetic-shared-pledge",
          title: "Synthetic shared pledge",
        },
      };
    },
    read: (server) => call(server, "brain_pledge", { operation: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("Synthetic shared pledge"),
    verbs: [
      {
        name: "fulfill",
        id: (entry) => entry.identity,
        call: (server, id) => call(server, "brain_pledge", { operation: "fulfill", slug: id }),
      },
      {
        name: "remove",
        id: (entry) => entry.identity,
        call: (server, id) => call(server, "brain_pledge", { operation: "remove", slug: id }),
      },
    ],
  },
  {
    reader: "brain_obligation",
    write: (root) => {
      const hiddenPath = join(root, "Brain", "obligations", "synthetic-hidden-obligation.md");
      const sharedPath = join(root, "Brain", "obligations", "synthetic-shared-obligation.md");
      writeLaneText(root, hiddenPath, obligationPage("Synthetic hidden obligation", REGION));
      writeLaneText(root, sharedPath, obligationPage("Synthetic shared obligation", "shared body"));
      return {
        hidden: {
          path: hiddenPath,
          rel: "Brain/obligations/synthetic-hidden-obligation.md",
          identity: "synthetic-hidden-obligation",
          title: "Synthetic hidden obligation",
        },
        shared: {
          path: sharedPath,
          rel: "Brain/obligations/synthetic-shared-obligation.md",
          identity: "synthetic-shared-obligation",
          title: "Synthetic shared obligation",
        },
      };
    },
    read: (server) => call(server, "brain_obligation", { operation: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("Synthetic shared obligation"),
    verbs: [
      {
        name: "done",
        id: (entry) => entry.identity,
        call: (server, id) => call(server, "brain_obligation", { operation: "done", slug: id }),
      },
      {
        name: "remove",
        id: (entry) => entry.identity,
        call: (server, id) => call(server, "brain_obligation", { operation: "remove", slug: id }),
      },
    ],
  },
  {
    reader: "brain_brief view=today",
    write: (root) => {
      const hiddenPath = join(root, "Brain", "pledges", "synthetic-today-hidden-pledge.md");
      const sharedPath = join(root, "Brain", "pledges", "synthetic-today-shared-pledge.md");
      writeLaneText(root, hiddenPath, pledgePage("Synthetic today hidden pledge", REGION));
      writeLaneText(root, sharedPath, pledgePage("Synthetic today shared pledge", "shared body"));
      return {
        hidden: {
          path: hiddenPath,
          rel: "Brain/pledges/synthetic-today-hidden-pledge.md",
          identity: "synthetic-today-hidden-pledge",
          title: "Synthetic today hidden pledge",
        },
        shared: {
          path: sharedPath,
          rel: "Brain/pledges/synthetic-today-shared-pledge.md",
          identity: "synthetic-today-shared-pledge",
          title: "Synthetic today shared pledge",
        },
      };
    },
    read: (server) => call(server, "brain_brief", { view: "today" }),
    // The today view reads the vault's own pages, so a server with no
    // vault lists none of them: the shared entry is there to be counted
    // only on a machine that has a vault.
    sharedVisible: (answer, mode) =>
      mode === "no-vault" || JSON.stringify(answer).includes("Synthetic today shared pledge"),
    localShows: (mode) => mode !== "no-vault",
  },
  {
    reader: "brain_lifecycle",
    write: (root) => {
      const hiddenPath = join(root, "Brain", "pledges", "synthetic-lifecycle-hidden.md");
      const sharedPath = join(root, "Brain", "pledges", "synthetic-lifecycle-shared.md");
      writeLaneText(root, hiddenPath, pledgePage("Synthetic lifecycle hidden", REGION));
      writeLaneText(root, sharedPath, pledgePage("Synthetic lifecycle shared", "shared body"));
      return {
        hidden: {
          path: hiddenPath,
          rel: "Brain/pledges/synthetic-lifecycle-hidden.md",
          identity: "synthetic-lifecycle-hidden",
          title: "Synthetic lifecycle hidden",
        },
        shared: {
          path: sharedPath,
          rel: "Brain/pledges/synthetic-lifecycle-shared.md",
          identity: "synthetic-lifecycle-shared",
          title: "Synthetic lifecycle shared",
        },
      };
    },
    read: (server) => call(server, "brain_pledge", { operation: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("Synthetic lifecycle shared"),
    verbs: [
      {
        name: "tombstone",
        id: (entry) => entry.rel,
        absentId: "Brain/pledges/synthetic-absent-entry.md",
        call: (server, id) =>
          call(server, "brain_lifecycle", {
            action: "tombstone",
            path: id,
            reason: "synthetic reason",
          }),
      },
    ],
  },
  {
    reader: "brain_intention",
    write: (root) => {
      const hiddenScope = "synthetic-hidden-scope";
      const sharedScope = "synthetic-shared-scope";
      setIntention(root, { scope: hiddenScope, text: REGION, agent: AGENT });
      setIntention(root, { scope: sharedScope, text: "shared body", agent: AGENT });
      return {
        hidden: {
          path: join(root, "Brain", "intentions", `${hiddenScope}.md`),
          rel: `Brain/intentions/${hiddenScope}.md`,
          identity: hiddenScope,
          title: hiddenScope,
        },
        shared: {
          path: join(root, "Brain", "intentions", `${sharedScope}.md`),
          rel: `Brain/intentions/${sharedScope}.md`,
          identity: sharedScope,
          title: sharedScope,
        },
      };
    },
    read: (server) => call(server, "brain_intention", { operation: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("synthetic-shared-scope"),
    verbs: [
      {
        name: "set",
        id: (entry) => entry.identity,
        absentId: "synthetic-absent-scope",
        same: false,
        unchanged: (after) => after.includes(REGION_BODY),
        call: (server, id) =>
          call(server, "brain_intention", { operation: "set", scope: id, text: "another text" }),
      },
      {
        name: "move",
        id: (entry) => entry.identity,
        call: (server, id) => call(server, "brain_intention", { operation: "move", scope: id }),
      },
    ],
  },
  {
    reader: "brain_procedural_memory",
    write: (root) => {
      const hiddenRel = "Brain/procedures/synthetic-hidden-procedure.md";
      const sharedRel = "Brain/procedures/synthetic-shared-procedure.md";
      writeLaneText(
        root,
        join(root, hiddenRel),
        procedurePage("Synthetic hidden procedure", REGION),
      );
      writeLaneText(
        root,
        join(root, sharedRel),
        procedurePage("Synthetic shared procedure", "shared body"),
      );
      return {
        hidden: {
          path: join(root, hiddenRel),
          rel: hiddenRel,
          identity: hiddenRel,
          title: "Synthetic hidden procedure",
        },
        shared: {
          path: join(root, sharedRel),
          rel: sharedRel,
          identity: sharedRel,
          title: "Synthetic shared procedure",
        },
      };
    },
    read: (server) => call(server, "brain_procedural_memory", { operation: "list" }),
    // The procedural memory reader answers from the index the reconcile
    // writes, so the row builds it at local reach first.
    prepare: async (env) => {
      const local = makeServer(env, TRANSPORT_REACH.local);
      await call(local, "brain_procedural_memory", { operation: "reconcile" });
    },
    sharedVisible: (answer) => JSON.stringify(answer).includes("synthetic-shared-procedure"),
    verbs: [
      {
        name: "mark_used",
        id: (entry) => proceduralEntryId(entry.identity),
        call: (server, id) =>
          call(server, "brain_procedural_memory", { operation: "mark_used", id }),
      },
      {
        name: "mark_outcome",
        id: (entry) => proceduralEntryId(entry.identity),
        call: (server, id) =>
          call(server, "brain_procedural_memory", {
            operation: "mark_outcome",
            id,
            outcome: "success",
          }),
      },
    ],
  },
  {
    reader: "brain_clusters",
    write: (root) => {
      const hiddenPath = join(root, "Brain", "clusters", "synthetic-hidden-cluster.md");
      const sharedPath = join(root, "Brain", "clusters", "synthetic-shared-cluster.md");
      writeLaneText(root, hiddenPath, clusterPage("synthetic hidden cluster", REGION));
      writeLaneText(root, sharedPath, clusterPage("synthetic shared cluster", "shared body"));
      return {
        hidden: {
          path: hiddenPath,
          rel: "Brain/clusters/synthetic-hidden-cluster.md",
          identity: "synthetic-hidden-cluster.md",
          title: "synthetic hidden cluster",
        },
        shared: {
          path: sharedPath,
          rel: "Brain/clusters/synthetic-shared-cluster.md",
          identity: "synthetic-shared-cluster.md",
          title: "synthetic shared cluster",
        },
      };
    },
    read: (server) => call(server, "brain_clusters", { operation: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("synthetic-shared-cluster.md"),
  },
  {
    reader: "brain_decision",
    write: (root) => {
      const hiddenSlug = "synthetic-hidden-decision";
      const sharedSlug = "synthetic-shared-decision";
      writeLaneText(
        root,
        join(root, "Brain", "decisions", `decision-${hiddenSlug}.md`),
        decisionPage(hiddenSlug, "Synthetic hidden decision", REGION),
      );
      writeLaneText(
        root,
        join(root, "Brain", "decisions", `decision-${sharedSlug}.md`),
        decisionPage(sharedSlug, "Synthetic shared decision", "shared body"),
      );
      return {
        hidden: {
          path: join(root, "Brain", "decisions", `decision-${hiddenSlug}.md`),
          rel: `Brain/decisions/decision-${hiddenSlug}.md`,
          identity: hiddenSlug,
          title: "Synthetic hidden decision",
        },
        shared: {
          path: join(root, "Brain", "decisions", `decision-${sharedSlug}.md`),
          rel: `Brain/decisions/decision-${sharedSlug}.md`,
          identity: sharedSlug,
          title: "Synthetic shared decision",
        },
      };
    },
    read: (server) => call(server, "brain_decision", { action: "list" }),
    sharedVisible: (answer) => JSON.stringify(answer).includes("Synthetic shared decision"),
    verbs: [
      {
        name: "rate",
        id: (entry) => entry.identity,
        call: (server, id) =>
          call(server, "brain_decision", { action: "rate", slug: id, rating: 4 }),
      },
      {
        name: "outcome",
        id: (entry) => entry.identity,
        call: (server, id) =>
          call(server, "brain_decision", { action: "outcome", slug: id, outcome: "shipped" }),
      },
    ],
  },
];

// ----- The runner --------------------------------------------------------------

/** A server at the reach given, or with no reach minted at all (a remote caller). */
function makeServer(env: LaneEnv, reach?: TransportReach): MCPServer {
  const config = {
    vault: env.mode === "no-vault" ? null : env.vault,
    configPath: env.env.configPath,
  };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

/** The tool's structured answer, or the message it refused with. */
async function call(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const result = await server.callTool(tool, args);
    return (result["structuredContent"] ?? result) as Record<string, unknown>;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

describe("private-partition lane entries are withheld below local reach", () => {
  for (const row of ROWS) {
    for (const mode of ["store", "no-vault"] as const) {
      test(`${row.reader} withholds the private-partition entry (${mode})`, async () => {
        lane = makeLaneEnv(mode);
        const entries = row.write(lane.vault);
        if (row.prepare !== undefined) await row.prepare(lane);
        // The partition the store holds each entry in, read from the store:
        // the hidden one is private by partition alone, the shared one is not.
        expect(laneEntryInPrivate(lane.vault, entries.hidden.path)).toBe(true);
        expect(laneEntryInPrivate(lane.vault, entries.shared.path)).toBe(false);

        const remote = makeServer(lane);
        const answer = await row.read(remote);
        const text = JSON.stringify(answer);
        expect({
          identity: text.includes(entries.hidden.identity),
          title: text.includes(entries.hidden.title),
          body: text.includes(REGION_BODY),
        }).toEqual({ identity: false, title: false, body: false });
        expect(row.sharedVisible(answer, mode)).toBe(true);

        const local = makeServer(lane, TRANSPORT_REACH.local);
        const localAnswer = await row.read(local);
        if (row.localShows?.(mode) ?? true) {
          expect(JSON.stringify(localAnswer).includes(entries.hidden.identity)).toBe(true);
        }

        const env = lane;
        for (const verb of row.verbs ?? []) {
          const hiddenId = verb.id(entries.hidden);
          const absentId = verb.absentId ?? "synthetic-absent-entry";
          // The private partition's records around the write to the hidden entry.
          const privateBefore = JSON.stringify(env.laneRecords("private"));
          const hiddenAnswer = await verb.call(remote, hiddenId);
          expect({
            verb: verb.name,
            private_unchanged: JSON.stringify(env.laneRecords("private")) === privateBefore,
          }).toEqual({ verb: verb.name, private_unchanged: true });
          const absentAnswer = await verb.call(remote, absentId);
          if (verb.same !== false) {
            expect({
              verb: verb.name,
              same:
                JSON.stringify(hiddenAnswer).split(hiddenId).join("ENTRY") ===
                JSON.stringify(absentAnswer).split(absentId).join("ENTRY"),
            }).toEqual({ verb: verb.name, same: true });
          } else {
            // A refusal of its own: the answer carries no content of the
            // entry and names nothing the caller did not name.
            expect(JSON.stringify(hiddenAnswer).includes(REGION_BODY)).toBe(false);
          }
          // The entry is unchanged: a local read still shows it, and the
          // write did not land on it.
          const after = await row.read(local);
          const localText = JSON.stringify(after);
          expect(localText.includes(entries.hidden.identity)).toBe(true);
          if (verb.unchanged !== undefined) expect(verb.unchanged(localText)).toBe(true);
        }
      });
    }
  }

  test("the bridges reader withholds a private-partition proposals file", async () => {
    lane = makeLaneEnv("store");
    const path = join(lane.vault, "Brain", "proposals", "bridges.md");
    writeLaneText(lane.vault, path, proposalsPage("shared body"));
    // The shared artifact is readable below local reach.
    const remote = makeServer(lane);
    const sharedAnswer = await call(remote, "brain_bridges", { operation: "list" });
    expect(sharedAnswer["exists"]).toBe(true);
    // The same artifact, private by partition alone.
    writeLaneText(lane.vault, path, proposalsPage(REGION));
    expect(laneEntryInPrivate(lane.vault, path)).toBe(true);
    const privateAnswer = await call(remote, "brain_bridges", { operation: "list" });
    expect({
      exists: privateAnswer["exists"],
      body: JSON.stringify(privateAnswer).includes(REGION_BODY),
    }).toEqual({ exists: false, body: false });
    const local = makeServer(lane, TRANSPORT_REACH.local);
    expect((await call(local, "brain_bridges", { operation: "list" }))["exists"]).toBe(true);
  });
  test("an incomplete fold withholds every lane entry below local reach", async () => {
    lane = makeLaneEnv("store");
    const sharedPath = join(lane.vault, "Brain", "pledges", "synthetic-fold-shared.md");
    writeLaneText(lane.vault, sharedPath, pledgePage("Synthetic fold shared", "shared body"));
    // A private entry whose body was spilled into a blob, and the blob is
    // gone: the fold may now miss a record, so it cannot say which
    // entries the private partition holds.
    writeLaneText(
      lane.vault,
      join(lane.vault, "Brain", "pledges", "synthetic-fold-hidden.md"),
      pledgePage("Synthetic fold hidden", `${REGION}${"x".repeat(200_000)}`),
    );
    const blobs = join(lane.env.storeRoot, "private", "blobs");
    for (const prefix of readdirSync(blobs)) {
      for (const blob of readdirSync(join(blobs, prefix))) {
        rmSync(join(blobs, prefix, blob), { force: true });
      }
    }
    expect(foldIncomplete()).toBe(true);
    const remote = makeServer(lane);
    const answer = await call(remote, "brain_pledge", { operation: "list" });
    expect(JSON.stringify(answer).includes("Synthetic fold shared")).toBe(false);
    const local = makeServer(lane, TRANSPORT_REACH.local);
    const localAnswer = await call(local, "brain_pledge", { operation: "list" });
    expect(JSON.stringify(localAnswer).includes("Synthetic fold shared")).toBe(true);
  });

  test("a machine whose lane pages are files answers as before the change", async () => {
    lane = makeLaneEnv("legacy");
    const path = join(lane.vault, "Brain", "pledges", "synthetic-legacy-pledge.md");
    writeLaneText(lane.vault, path, pledgePage("Synthetic legacy pledge", REGION));
    // A file-backed lane page is judged by its frontmatter and owner, so
    // the entry is readable below local reach as it is today.
    expect(laneEntryInPrivate(lane.vault, path)).toBe(false);
    const remote = makeServer(lane);
    const answer = await call(remote, "brain_pledge", { operation: "list" });
    expect(JSON.stringify(answer).includes("Synthetic legacy pledge")).toBe(true);
  });
  test("a local caller under the ownership gate keeps its own hidden entry", async () => {
    lane = makeLaneEnv("store");
    // The gate is on, and the caller's identity is the one the entry
    // carries as its owner.
    mkdirSync(join(lane.vault, "Brain"), { recursive: true });
    writeFileSync(
      join(lane.vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: fail\n",
      "utf8",
    );
    const saved = process.env["VAULT_AGENT_NAME"];
    process.env["VAULT_AGENT_NAME"] = AGENT;
    try {
      const path = join(lane.vault, "Brain", "pledges", "synthetic-gate-hidden.md");
      writeLaneText(
        lane.vault,
        path,
        page(
          {
            title: "Synthetic gate hidden",
            due: "2026-12-01",
            created_at: CREATED_AT,
            agent: AGENT,
            owner: AGENT,
          },
          REGION,
        ),
      );
      expect(laneEntryInPrivate(lane.vault, path)).toBe(true);
      const local = makeServer(lane, TRANSPORT_REACH.local);
      const answer = await call(local, "brain_pledge", { operation: "list" });
      expect(JSON.stringify(answer).includes("Synthetic gate hidden")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["VAULT_AGENT_NAME"];
      else process.env["VAULT_AGENT_NAME"] = saved;
    }
  });
  test("a list of fifty pledges at a remote reach", async () => {
    lane = makeLaneEnv("store");
    for (let index = 0; index < 50; index += 1) {
      writeLaneText(
        lane.vault,
        join(lane.vault, "Brain", "pledges", `synthetic-bulk-${index}.md`),
        pledgePage(`Synthetic bulk pledge ${index}`, index === 7 ? REGION : "shared body"),
      );
    }
    const remote = makeServer(lane);
    const started = performance.now();
    const answer = await call(remote, "brain_pledge", { operation: "list" });
    const elapsed = performance.now() - started;
    console.log(`bulk list of fifty pledges: ${elapsed.toFixed(1)} ms`);
    const rows = (answer["pledges"] ?? []) as Array<Record<string, unknown>>;
    // The hidden entry is left out of the list and of its count.
    expect(rows.length).toBe(49);
    expect(JSON.stringify(answer).includes("Synthetic bulk pledge 7")).toBe(false);
  });
});
