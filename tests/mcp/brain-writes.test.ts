/**
 * `brain_writes` (who-wrote-what, Task A / t_662f4e82).
 *
 * The agent-facing half of the note-write record: the listing, the
 * filters, and the one action that is DECLARED and not yet reachable -
 * `plan_revert`, which is refused by name so an agent learns the
 * capability exists rather than reading an unknown-argument error as a
 * typo.
 *
 * The end-to-end property is pinned here too: a note written through
 * `brain_create_note` shows up under `brain_writes` with the id its own
 * receipt named. Two surfaces, one record.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { recordNoteWrite, storeBeforeImage } from "../../src/core/brain/notes/write-record.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { BRAIN_TOOLS } from "../../src/mcp/brain-tools.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-brain-writes-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-writes-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = (name: string) => BRAIN_TOOLS.find((t) => t.name === name)!;

const call = async (name: string, args: Record<string, unknown>) =>
  (await tool(name).handler(ctx, args)) as Record<string, unknown>;

interface WritesReply {
  readonly action: string;
  readonly total_matched: number;
  readonly returned: number;
  readonly writes: ReadonlyArray<Record<string, unknown>>;
  readonly warnings: ReadonlyArray<unknown>;
}

const listWrites = async (args: Record<string, unknown> = {}): Promise<WritesReply> =>
  (await call("brain_writes", args)) as unknown as WritesReply;

/** Await `result`, assert it rejected with an MCPError, and return it. */
async function rejectedMcpError(result: unknown): Promise<MCPError> {
  let thrown: unknown;
  try {
    await result;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MCPError);
  return thrown as MCPError;
}

describe("brain_writes registration", () => {
  test("is registered, read-only by shape, and takes no required argument", () => {
    const def = tool("brain_writes");
    expect(def).toBeDefined();
    expect(def.inputSchema.required ?? []).toEqual([]);
    expect(def.previewBudget).toBeGreaterThan(0);
  });

  test("declares both actions now, so the schema pins move once", () => {
    const schema = tool("brain_writes").inputSchema as {
      properties: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect(schema.properties["action"]?.enum).toEqual(["list", "plan_revert"]);
    expect(schema.properties["op"]?.enum).toEqual(["create", "update", "append", "revert"]);
  });
});

describe("brain_writes action list", () => {
  test("lists what the note-write tools recorded, by the id they reported", async () => {
    const created = await call("brain_create_note", {
      path: "Notes/One.md",
      content: "first body",
    });
    await call("brain_update_note", { path: "Notes/One.md", content: "second body" });

    const reply = await listWrites({});
    expect(reply.action).toBe("list");
    expect(reply.total_matched).toBe(2);
    expect(reply.returned).toBe(2);
    // Newest first, so the update leads.
    expect(reply.writes.map((w) => w["op"])).toEqual(["update", "create"]);
    expect(reply.writes.map((w) => w["target"])).toEqual(["Notes/One.md", "Notes/One.md"]);
    // The very id the create receipt named: two surfaces, one record.
    expect(reply.writes.map((w) => w["write_id"])).toContain(created["write_id"]);
    expect(reply.writes[0]!["agent"]).toBe("claude");
  });

  test("defaults to list when no action is sent", async () => {
    await call("brain_create_note", { path: "Notes/One.md", content: "body" });
    expect((await listWrites({})).action).toBe("list");
  });

  test("filters by op and by path", async () => {
    await call("brain_create_note", { path: "Notes/One.md", content: "body" });
    await call("brain_create_note", { path: "Notes/Two.md", content: "body" });
    await call("brain_append_note", { path: "Notes/One.md", content: "more" });

    expect((await listWrites({ op: "append" })).total_matched).toBe(1);
    expect((await listWrites({ path: "Notes/Two.md" })).total_matched).toBe(1);
    expect((await listWrites({ agent: "nobody" })).total_matched).toBe(0);
  });

  test("limit caps the rows and total_matched still names the whole match", async () => {
    await call("brain_create_note", { path: "Notes/One.md", content: "body" });
    await call("brain_create_note", { path: "Notes/Two.md", content: "body" });

    const reply = await listWrites({ limit: 1 });
    expect(reply.total_matched).toBe(2);
    expect(reply.returned).toBe(1);
    expect(reply.writes).toHaveLength(1);
  });

  test("an empty vault answers with an empty list, not an error", async () => {
    const reply = await listWrites({});
    expect(reply.total_matched).toBe(0);
    expect(reply.writes).toEqual([]);
    expect(reply.warnings).toEqual([]);
  });

  test("an unknown op is refused by name", async () => {
    const err = await rejectedMcpError(call("brain_writes", { op: "delete" }));
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toContain("create, update, append, revert");
  });
});

describe("brain_writes action plan_revert", () => {
  /** Do what the write seams do, so the plan reads a real history. */
  function seedNote(opts: {
    readonly target: string;
    readonly bytes: string;
    readonly agent: string;
    readonly at: string;
  }): void {
    const abs = join(vault, opts.target);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    mkdirSync(dirname(abs), { recursive: true });
    if (before !== null) storeBeforeImage(vault, before);
    atomicWriteFileSync(abs, opts.bytes);
    recordNoteWrite(vault, {
      op: before === null ? "create" : "update",
      target: opts.target,
      before: before === null ? null : { bytes: before },
      after: { bytes: opts.bytes },
      timestamp: opts.at,
      agent: opts.agent,
    });
  }

  const TARGET = "notes/A.md";

  test("returns the entries and the digest, and no apply path", async () => {
    seedNote({ target: TARGET, bytes: "v0", agent: "seed", at: "2026-03-04T01:00:00Z" });
    seedNote({ target: TARGET, bytes: "v1", agent: "claude", at: "2026-03-04T02:00:00Z" });

    const reply = await call("brain_writes", { action: "plan_revert", agent: "claude" });
    expect(reply["action"]).toBe("plan_revert");
    expect(reply["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const entries = reply["entries"] as ReadonlyArray<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!["target"]).toBe(TARGET);
    expect(entries[0]!["action"]).toBe("restore");
    // The plan is a report: the tool has no apply and moved nothing.
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe("v1");
    expect(Object.keys(reply)).not.toContain("applied");
  });

  test("reports a refused target by name rather than dropping it", async () => {
    seedNote({ target: TARGET, bytes: "v0", agent: "seed", at: "2026-03-04T01:00:00Z" });
    seedNote({ target: TARGET, bytes: "v1", agent: "claude", at: "2026-03-04T02:00:00Z" });
    atomicWriteFileSync(join(vault, TARGET), "drifted");

    const reply = await call("brain_writes", { action: "plan_revert", path: TARGET });
    const entries = reply["entries"] as ReadonlyArray<Record<string, unknown>>;
    expect(entries[0]!["action"]).toBe("refuse");
    expect(entries[0]!["reason"]).toBe("drift");
  });

  test("an unbounded selector is refused with the code, not an empty plan", async () => {
    const err = await rejectedMcpError(
      call("brain_writes", { action: "plan_revert", since: "2026-03-04" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.message).toContain("unbounded_selector");
  });

  test("no apply reaches this tool: an --apply-shaped argument is rejected", () => {
    const schema = tool("brain_writes").inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).not.toContain("apply");
    expect(Object.keys(schema.properties)).not.toContain("digest");
  });
});
