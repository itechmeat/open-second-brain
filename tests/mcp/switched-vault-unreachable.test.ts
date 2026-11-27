/**
 * The MCP server of a machine switched to the brain store, whose vault
 * folder cannot be read or is gone.
 *
 * The brain lives in the store there, so the tools that answer from the
 * store (the digest, store-backed search, feedback capture) keep working,
 * as they do on a server with no vault (design D14 item 2); a tool that
 * works on vault notes refuses with `vault_unreadable` and writes nothing,
 * never recreating a folder that is gone (an unmounted disk). Before the
 * fix every tool answered `vault_unreadable` on an unreadable vault, and
 * on a vault that was gone a note tool recreated it and a search waited
 * out its timeout. A machine that has not switched keeps refusing every
 * tool (`tests/cli/mcp-vault-unreadable.test.ts`).
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, renameSync } from "node:fs";

import { writePreference } from "../../src/core/brain/preference.ts";
import { MCPServer } from "../../src/mcp/index.ts";
import { partitionRecords, switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const RULE = "Always feed the otters before the herons.";

let env: StoreEnv | undefined;
const undo: Array<() => void> = [];
afterEach(() => {
  try {
    for (const step of undo.splice(0)) step();
  } finally {
    env?.cleanup();
    env = undefined;
  }
});

/** A switched machine with no legacy tree, holding one confirmed preference in the store. */
function switchedMachine(prefix: string): { env: StoreEnv; server: MCPServer } {
  env = makeStoreEnv(prefix, { legacyTree: false });
  switchDevice(env.storeRoot);
  writePreference(env.vault, {
    slug: "otters-first",
    topic: "otters-first",
    principle: RULE,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
    confidence_value: 0.9,
  });
  const server = new MCPServer(
    { vault: env.vault, configPath: env.configPath },
    { reach: "local" },
  );
  return { env, server };
}

async function request(server: MCPServer, name: string, args: object) {
  return (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result?: Record<string, any>; error?: { data?: { code?: string } } };
}

async function call(server: MCPServer, name: string, args: object): Promise<Record<string, any>> {
  const response = await request(server, name, args);
  expect(response.error).toBeUndefined();
  return response.result!;
}

function errorCode(result: Record<string, any>): string | null {
  if (result["isError"] !== true) return null;
  return result["_meta"]?.["open-second-brain/error"]?.["code"] ?? "untyped";
}

function text(result: Record<string, any>): string {
  return (result["content"] as Array<{ text: string }>).map((c) => c.text).join("\n");
}

/** The store-backed tools answer from the store; the note tool refuses. */
async function expectStoreServed(server: MCPServer, root: string): Promise<void> {
  const context = await call(server, "brain_context", {});
  expect(errorCode(context)).toBeNull();
  expect(text(context)).toContain(RULE);

  const search = await call(server, "brain_search", { query: "otters herons" });
  expect(errorCode(search)).toBeNull();

  const before = partitionRecords(root, "shared").length;
  const feedback = await call(server, "brain_feedback", {
    topic: "tabs",
    principle: "Prefer tabs over spaces in makefiles.",
    signal: "positive",
  });
  expect(errorCode(feedback)).toBeNull();
  expect(partitionRecords(root, "shared").length).toBeGreaterThan(before);

  // Refused the way a server with no vault refuses a note tool
  // (`vault_required`), with the reason's own code.
  const note = await request(server, "brain_create_note", {
    path: "Notes/x.md",
    content: "hi\n",
  });
  expect(note.error?.data?.code).toBe("vault_unreadable");
}

test.skipIf(CHMOD_CANNOT_DENY)(
  "a switched machine serves the store tools while its vault cannot be read",
  async () => {
    const { env: e, server } = switchedMachine("osb-mcp-switched-unreadable-");
    chmodSync(e.vault, 0o000);
    undo.push(() => chmodSync(e.vault, 0o755));
    await expectStoreServed(server, e.storeRoot);
    // Readable again: the note tool works in the same server.
    chmodSync(e.vault, 0o755);
    const note = await call(server, "brain_create_note", {
      path: "Notes/x.md",
      content: "hi\n",
    });
    expect(errorCode(note)).toBeNull();
  },
  60_000,
);

test("a switched machine serves the store tools while its vault folder is gone", async () => {
  const { env: e, server } = switchedMachine("osb-mcp-switched-gone-");
  const away = `${e.vault}-away`;
  renameSync(e.vault, away);
  undo.push(() => {
    if (existsSync(away) && !existsSync(e.vault)) renameSync(away, e.vault);
  });
  await expectStoreServed(server, e.storeRoot);
  // The note tool did not recreate the folder that is gone.
  expect(existsSync(e.vault)).toBe(false);
}, 60_000);

test("the operator's rules are reported as unread, with the reason, when the vault is unreachable", async () => {
  // The rules live in the vault, and the vault is out of reach: the answer
  // says so, naming the reason, instead of reporting no rules - which
  // reads as "the operator wrote none".
  const { env: e, server } = switchedMachine("osb-mcp-switched-rules-");
  const away = `${e.vault}-away`;
  renameSync(e.vault, away);
  undo.push(() => {
    if (existsSync(away) && !existsSync(e.vault)) renameSync(away, e.vault);
  });
  const context = await call(server, "brain_context", {});
  expect(errorCode(context)).toBeNull();
  const content = text(context);
  expect(content).toContain("UNAVAILABLE");
  // The reason, and the standing and the scoped rules it is about.
  expect(content).toContain("ENOENT");
  expect(content.toLowerCase()).toContain("no standing rules are in force");
  expect(content.toLowerCase()).toContain("no scoped operator rules are in force");
  // The rules are not read from the store: the operator's rules live in
  // the vault, and the store holds the operator's memories (the
  // preference below), not the constitution.
  expect(content).toContain(RULE);
}, 60_000);

/**
 * Every store-backed tool, at both reaches, on a switched machine whose
 * vault folder is gone. At remote reach the stored text a tool hands out
 * is shaped by the delivery binding, whose provenance probe must not read
 * the vault getter: with no vault there is no page to probe, and the text
 * gets the fail-closed fence the delivery contract gives absent
 * provenance. Before the fix `brain_context` and a pinned-scratchpad read
 * at remote reach answered `vault_unreadable`.
 */
const STORE_BACKED: ReadonlyArray<readonly [string, object]> = [
  ["brain_context", {}],
  ["brain_search", { query: "otters herons" }],
  // A preference lookup reads the store's folds, not vault files.
  ["brain_query", { preference: "pref-otters-first" }],
  ["brain_pinned_context", { operation: "read" }],
  [
    "brain_feedback",
    {
      topic: "tabs",
      principle: "Prefer tabs in makefiles.",
      signal: "positive",
    },
  ],
  ["brain_apply_evidence", { pref_id: "otters-first", artifact: "[[notes/a]]", result: "applied" }],
  ["brain_note", { text: "Shipped the otter feeder." }],
  ["brain_changes", {}],
  ["brain_dream", { dry_run: true }],
  ["brain_doctor", {}],
  ["brain_settings", { action: "list" }],
  ["second_brain_status", {}],
];

/** The two shapes of an unreachable vault: the folder gone, or at mode 000. */
const UNREACHABLE = [
  {
    shape: "gone",
    skip: false,
    cutOff(vault: string): void {
      const away = `${vault}-away`;
      renameSync(vault, away);
      undo.push(() => {
        if (existsSync(away) && !existsSync(vault)) renameSync(away, vault);
      });
    },
  },
  {
    shape: "unreadable",
    skip: CHMOD_CANNOT_DENY,
    cutOff(vault: string): void {
      chmodSync(vault, 0o000);
      undo.push(() => chmodSync(vault, 0o755));
    },
  },
] as const;

for (const { shape, skip, cutOff } of UNREACHABLE)
  for (const reach of ["local", "remote"] as const) {
    test.skipIf(skip)(
      `at ${reach} reach every store-backed tool answers while the vault is ${shape}`,
      async () => {
        const { env: e } = switchedMachine(`osb-mcp-switched-sweep-${shape}-${reach}-`);
        const server = new MCPServer({ vault: e.vault, configPath: e.configPath }, { reach });
        cutOff(e.vault);
        // A scratchpad with content, written while the vault is gone, so the
        // read below hands out stored text.
        if (reach === "remote") {
          // Below local reach the pinned register is `shared` (change
          // `lane-reach-residuals`, requirement "A machine register and the
          // receipt ledger follow the lane rule below local reach"): the
          // remote caller's own text, written before the `private` register
          // holds a record, lands there and is what its read below hands out.
          const shared = await call(server, "brain_pinned_context", {
            operation: "write",
            content: "Heron rota.",
          });
          expect(errorCode(shared)).toBeNull();
        }
        const local = new MCPServer(
          { vault: e.vault, configPath: e.configPath },
          { reach: "local" },
        );
        await call(local, "brain_pinned_context", {
          operation: "write",
          content: "Otter rota.",
        });

        const answers: Record<string, string | null> = {};
        for (const [name, args] of STORE_BACKED) {
          // In order: the writers and the reads share one store.
          // eslint-disable-next-line no-await-in-loop
          const response = await request(server, name, args);
          answers[name] = response.error?.data?.code ?? errorCode(response.result!);
        }
        expect(answers).toEqual(Object.fromEntries(STORE_BACKED.map(([name]) => [name, null])));

        const context = text(await call(server, "brain_context", {}));
        expect(context).toContain(RULE);
        const query = text(await call(server, "brain_query", { topic: "otters-first" }));
        expect(query).toContain(RULE);
        // An explicit owner scope is authorized against the vault the store
        // is served from, not the vault getter: it answers like the unscoped one.
        const scoped = await request(server, "brain_query", {
          topic: "otters-first",
          agent_scope: "otter-keeper",
        });
        expect(scoped.error?.data?.code ?? errorCode(scoped.result!)).toBeNull();
        expect(text(scoped.result!)).toContain(RULE);
        const pinned = text(await call(server, "brain_pinned_context", { operation: "read" }));
        if (reach === "remote") {
          // The remote read answers the `shared` register, and names
          // nothing of the pin the local writer put into `private`, in the
          // scratchpad or in the session context that embeds it; a local
          // read still returns that pin.
          expect(pinned).toContain("Heron rota.");
          expect(pinned).toContain("store:shared/pinned");
          expect(pinned).not.toContain("Otter rota.");
          expect(pinned).not.toContain("store:private/pinned");
          expect(context).toContain("Heron rota.");
          expect(context).not.toContain("Otter rota.");
          const own = text(await call(local, "brain_pinned_context", { operation: "read" }));
          expect(own).toContain("Otter rota.");
          // Absent provenance is fenced at remote reach, never delivered bare.
          expect(pinned).toContain("unverified provenance (no derivable stamps)");
        } else {
          expect(pinned).toContain("Otter rota.");
        }
        // Nothing recreated a folder that is gone.
        if (shape === "gone") expect(existsSync(e.vault)).toBe(false);
      },
      60_000,
    );
  }

/**
 * A search result past the preview budget is parked as an artifact. The
 * server parked it under the configured vault, and on a switched machine
 * that resolves machine state through a look at `<vault>/Brain`: with the
 * vault at mode 000 the look failed and the search refused at local reach
 * (where the rows are long enough to be parked), while a folder that is
 * gone, and the shorter rows at remote reach, answered. The payload is now
 * parked where a server with no vault parks it, and fetched back from there.
 */
for (const { shape, skip, cutOff } of UNREACHABLE) {
  test.skipIf(skip)(
    `a search result past the preview budget is parked while the vault is ${shape}`,
    async () => {
      const { env: e, server } = switchedMachine(`osb-mcp-switched-park-${shape}-`);
      for (let i = 0; i < 30; i += 1) {
        writePreference(e.vault, {
          slug: `otters-${i}`,
          topic: `otters-${i}`,
          principle: `Feed the otters of pool ${i} first. ${"Keep the otter pool clean. ".repeat(8)}`,
          created_at: "2026-11-01T00:00:00Z",
          unconfirmed_until: "2026-11-02T00:00:00Z",
          status: "confirmed",
          confirmed_at: "2026-11-02T00:00:00Z",
          evidenced_by: ["[[sig-x]]"],
          confidence_value: 0.9,
        });
      }
      cutOff(e.vault);
      const search = await call(server, "brain_search", { query: "otters", limit: 30 });
      expect(errorCode(search)).toBeNull();
      const envelope = JSON.parse(text(search)) as {
        preview_truncated?: boolean;
        artifact_id: string;
      };
      expect(envelope.preview_truncated).toBe(true);
      const full = await call(server, "brain_artifact_get", { artifact_id: envelope.artifact_id });
      expect(errorCode(full)).toBeNull();
      expect(text(full)).toContain("Feed the otters of pool");
      if (shape === "gone") expect(existsSync(e.vault)).toBe(false);
    },
    60_000,
  );
}

/** Thirty long confirmed preferences, so a search for them is parked past its preview budget. */
function manyOtters(vault: string): void {
  for (let i = 0; i < 30; i += 1) {
    writePreference(vault, {
      slug: `otters-${i}`,
      topic: `otters-${i}`,
      principle: `Feed the otters of pool ${i} first. ${"Keep the otter pool clean. ".repeat(8)}`,
      created_at: "2026-11-01T00:00:00Z",
      unconfirmed_until: "2026-11-02T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-11-02T00:00:00Z",
      evidenced_by: ["[[sig-x]]"],
      confidence_value: 0.9,
    });
  }
}

/** The vault back as it was before `cutOff`. */
function bringBack(shape: "gone" | "unreadable", vault: string): void {
  if (shape === "gone") renameSync(`${vault}-away`, vault);
  else chmodSync(vault, 0o755);
}

/**
 * A handle names a parked payload for the whole run, whatever happened
 * to the vault between the search that parked it and the fetch: a payload
 * parked while the vault was out of reach is fetched after it is back,
 * and one parked while it was there is fetched while it is out of reach.
 */
for (const { shape, skip, cutOff } of UNREACHABLE) {
  for (const parkedWhile of ["out of reach", "there"] as const) {
    test.skipIf(skip)(
      `a handle parked while the vault is ${parkedWhile} resolves after it changes (${shape})`,
      async () => {
        const { env: e, server } = switchedMachine(`osb-mcp-switched-handle-${shape}-`);
        manyOtters(e.vault);
        if (parkedWhile === "out of reach") cutOff(e.vault);
        const search = await call(server, "brain_search", { query: "otters", limit: 30 });
        expect(errorCode(search)).toBeNull();
        const envelope = JSON.parse(text(search)) as {
          preview_truncated?: boolean;
          artifact_id: string;
        };
        expect(envelope.preview_truncated).toBe(true);
        if (parkedWhile === "out of reach") bringBack(shape, e.vault);
        else cutOff(e.vault);
        const full = await call(server, "brain_artifact_get", {
          artifact_id: envelope.artifact_id,
        });
        expect(errorCode(full)).toBeNull();
        expect(text(full)).toContain("Feed the otters of pool");
      },
      60_000,
    );
  }
}
