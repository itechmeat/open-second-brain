/**
 * MCP integration tests for `brain_update_note` and `brain_append_note`
 * (W1, t_3ff3fe77). Both tools are single-operation batches over the
 * atomic write-batch core (kernel 2). They reuse the create-note safety
 * envelope and refuse a missing target with a typed error mapped to
 * INVALID_PARAMS.
 *
 * The nothing-writes-silently wave (unit B) adds the `allow_empty`
 * argument to `brain_update_note` and three refusals pinned here: a
 * blank body over a note that has one (INVALID_PARAMS,
 * `blank_overwrite_refused`, naming the note), an existing note the host
 * cannot read (INTERNAL_ERROR, `target_unreadable` - the caller's
 * request is right and the host is not), and an explicit empty `content`
 * read as a clear request rather than as an absent argument.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS, writeBatchErrorToMcp } from "../../src/mcp/brain/notes-tools.ts";
import { WriteBatchError } from "../../src/core/brain/write-batch.ts";
import { PAGE_LINT_KEY, UNDATED_QUANTITY_CODE } from "../../src/core/brain/page-lint.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

/**
 * Shape of a note-write id, as `noteWriteId` spells it (who-wrote-what,
 * Task A). Its value carries the instant of the write, so a receipt test
 * pins the shape rather than a literal.
 */
const NOTE_WRITE_ID_RE = /^nw_\d{14}_[0-9a-f]{16}$/;

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

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-update-note-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-update-note-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedNote(rel: string, body: string, frontmatter = ""): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const fm = frontmatter ? `---\n${frontmatter}\n---\n\n` : "";
  writeFileSync(abs, `${fm}${body}\n`, "utf8");
}

const updateTool = NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;
const appendTool = NOTES_TOOLS.find((t) => t.name === "brain_append_note")!;

// The freshen seam both claim describes below intercept. Module scope so
// the update and the append tests share ONE registration and ONE
// teardown - two private copies of a mock that must be un-registered is
// exactly how a leaked mock starts.
const FRESHEN_MODULE = "../../src/core/search/freshen.ts";
let realFreshen: Record<string, unknown> | null = null;
let forcedCalls: Array<{ vault: string; opts: Record<string, unknown> }> = [];

/** Intercept the freshen machinery at the deferred-import seam. */
async function mockFreshenSpawned(): Promise<void> {
  realFreshen = { ...(await import(FRESHEN_MODULE)) };
  forcedCalls = [];
  mock.module(FRESHEN_MODULE, () => ({
    ...realFreshen,
    maybeFreshenIndex: (config: { vault: string }, opts: Record<string, unknown>) => {
      forcedCalls.push({ vault: config.vault, opts });
      return "spawned" as const;
    },
  }));
}

afterEach(() => {
  // This runner's mock registration outlives mock.restore() across test
  // FILES, so the teardown re-registers the REAL module object instead:
  // whatever leaks past this file is freshen.ts itself, byte for byte.
  if (realFreshen !== null) mock.module(FRESHEN_MODULE, () => realFreshen);
  mock.restore();
  realFreshen = null;
  forcedCalls = [];
});

/** Stamp the vault's index with an old instant: the claim's stale gate must pass. */
async function stampIndexStale(): Promise<void> {
  const { LAST_INDEXED_AT_STATE_KEY, Store } = await import("../../src/core/search/store.ts");
  const store = await Store.open(resolveSearchConfig({ vault, configPath: ctx.configPath! }), {
    mode: "write",
  });
  store.setState(LAST_INDEXED_AT_STATE_KEY, "2026-08-15T00:00:00.000Z");
  await store.close();
}

function withIntervalEnv(value: string): () => void {
  const key = "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S";
  const saved = process.env[key];
  process.env[key] = value;
  return () => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
}

/**
 * The post-write index refresh a content edit claims.
 *
 * The release notes promise that a content edit claims a refresh, so an
 * applied update claims the SAME detached, claim-guarded refresh a
 * lifecycle write claims - fire-and-forget, with the claim marker and
 * its refusal reason on the receipt under the same vocabulary
 * (`index_refresh`, `index_refresh_reason`). The seam is the freshen
 * module itself, mocked here so the assertion sees the forced call
 * without ever spawning a real indexer; the suite-wide freshen-off
 * default keeps every OTHER test in this file inert.
 */
describe("brain_update_note - the post-write refresh claim", () => {
  test("a content edit claims one forced refresh: the seam sees force, and the receipt says claimed", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc");
    // An index exists and is stale: the claim's stale gate passes and
    // the forced machinery is what the seam intercepts.
    await stampIndexStale();
    await mockFreshenSpawned();
    const restore = withIntervalEnv("60");
    try {
      const res = (await updateTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "new body",
      })) as Record<string, unknown>;

      expect(res["updated"]).toBe(true);
      // The same claim marker vocabulary the lifecycle tool renders, on
      // the update receipt: a run is IN FLIGHT, never landed.
      expect(res["index_refresh"]).toBe("claimed");
      expect(res["index_refresh_reason"]).toBeNull();
      // The seam assertion: one forced call for THIS vault - force past
      // the freshness gate, because the edit is due by definition.
      expect(forcedCalls).toHaveLength(1);
      expect(forcedCalls[0]!.vault).toBe(vault);
      expect(forcedCalls[0]!.opts["force"]).toBe(true);
    } finally {
      restore();
    }
  });

  test("config off does not claim: the receipt says not_claimed and names off", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc");
    // An index exists (so the stale gate passes and the machinery is
    // what refuses), and no mock: with the interval at 0 the REAL
    // machinery answers before any spawn could be considered, so nothing
    // can leak out of this test either.
    await stampIndexStale();
    const restore = withIntervalEnv("0");
    try {
      const res = (await updateTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "new body",
      })) as Record<string, unknown>;

      expect(res["updated"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("off");
    } finally {
      restore();
    }
  });

  test("a writer-locked index still queues the write: the receipt names writer_lock and the marker stands", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc");
    // An index exists and is stale, the interval is on, and the REAL
    // machinery runs - no seam. The index writer lock is HELD: the shape
    // of a detached refresh mid-pass, which holds it for the bulk of its
    // run, where the lock probe answers before the claim is ever
    // consulted. A write that took the lock's answer home unmarked would
    // be dropped for a whole interval by the run's fresh stamp - the
    // exact mid-refresh drop the pending marker exists to prevent.
    await stampIndexStale();
    const { acquireWriterLockSync } = await import("../../src/core/search/store/writer-lock.ts");
    const { FRESHEN_PENDING_FILE, readFreshenPending } = await import(FRESHEN_MODULE);
    const dbPath = resolveSearchConfig({ vault, configPath: ctx.configPath! }).dbPath;
    const release = acquireWriterLockSync(dbPath);
    const scanStart = Date.now();
    const restore = withIntervalEnv("60");
    try {
      const res = (await updateTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "new body",
      })) as Record<string, unknown>;

      expect(res["updated"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("writer_lock");
      // The queue: a durable marker beside the freshen state says a
      // write is pending since an instant after this test's own scan
      // start, so the in-flight child's settle runs the one bounded
      // extra pass that covers it before it releases the claim.
      const stateDir = dirname(dbPath);
      const marker = readFreshenPending(stateDir);
      expect(marker).not.toBeNull();
      expect(marker!.since).toBeGreaterThanOrEqual(scanStart);
      expect(existsSync(join(stateDir, FRESHEN_PENDING_FILE))).toBe(true);
    } finally {
      release();
      restore();
    }
  });

  test("the claim resolves through the server's own config file, not the environment alone", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc");
    // The freshen-off decision arrives by CONFIG FILE here - the env
    // var the suite defaults to 0 is scrubbed - and the claim reads it
    // only because it resolves the search config through the server's
    // configPath. Resolved without it, the default interval stands and
    // the edit claims a run the operator's config refused.
    await stampIndexStale();
    atomicWriteFileSync(
      join(configHome, "config.yaml"),
      `vault: ${vault}\nagent_name: claude\nsearch_freshen_interval_s: 0\n`,
    );
    const key = "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S";
    const saved = process.env[key];
    delete process.env[key];
    try {
      const res = (await updateTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "new body",
      })) as Record<string, unknown>;

      expect(res["updated"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("off");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a byte-identical re-apply wrote nothing, so it carries no refresh marker at all", async () => {
    seedNote("Notes/Doc.md", "same body", "title: Doc");
    const res = (await updateTool.handler(ctx, {
      path: "Notes/Doc.md",
      content: "same body",
    })) as Record<string, unknown>;

    expect(res["updated"]).toBe(false);
    // Byte-identical-when-absent: a receipt for a write that did not
    // happen says nothing about a refresh it did not claim.
    expect("index_refresh" in res).toBe(false);
    expect("index_refresh_reason" in res).toBe(false);
  });
});

describe("brain_update_note", () => {
  test("is registered and requires a path", () => {
    expect(updateTool).toBeDefined();
    expect(updateTool.inputSchema.required).toContain("path");
  });

  test("merges frontmatter and replaces the body of an existing note", async () => {
    seedNote("Notes/Doc.md", "old body", "title: Doc\nstatus: draft");
    const res = await updateTool.handler(ctx, {
      path: "Notes/Doc.md",
      frontmatter: { status: "final" },
      content: "new body",
    });
    expect(res).toMatchObject({ updated: true, path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("title: Doc");
    expect(md).toContain("status: final");
    expect(md).toContain("new body");
    expect(md).not.toContain("old body");
  });

  test("a missing target is rejected with INVALID_PARAMS and writes nothing", async () => {
    const err = await rejectedMcpError(
      updateTool.handler(ctx, { path: "Notes/Ghost.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "target_missing", index: 0, path: "Notes/Ghost.md" });
    expect(existsSync(join(vault, "Notes/Ghost.md"))).toBe(false);
  });

  test("requires at least frontmatter or content", async () => {
    seedNote("Notes/Doc.md", "body", "title: Doc");
    const err = await rejectedMcpError(updateTool.handler(ctx, { path: "Notes/Doc.md" }));
    expect(err.code).toBe(INVALID_PARAMS);
  });

  test("declares the optional allow_empty boolean with a description", () => {
    const schema = updateTool.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
      required: ReadonlyArray<string>;
    };
    expect(schema.properties["allow_empty"]?.type).toBe("boolean");
    expect((schema.properties["allow_empty"]?.description ?? "").length).toBeGreaterThan(0);
    expect(schema.required).not.toContain("allow_empty");
  });

  test("a blank body over a note that has one is refused, naming the note", async () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const err = await rejectedMcpError(
      updateTool.handler(ctx, { path: "Notes/Doc.md", content: "   " }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "blank_overwrite_refused", path: "Notes/Doc.md" });
    expect(err.message).toContain("Notes/Doc.md");
    expect(readFileSync(join(vault, "Notes/Doc.md"), "utf8")).toContain("worth keeping");
  });

  test("allow_empty clears the body deliberately", async () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const res = await updateTool.handler(ctx, {
      path: "Notes/Doc.md",
      content: "",
      allow_empty: true,
    });
    expect(res).toMatchObject({ updated: true, path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("title: Doc");
    expect(md).not.toContain("worth keeping");
  });

  test("an explicit empty content beside frontmatter is a clear request, not an absent one", async () => {
    // It used to collapse to "argument not sent": the frontmatter merge
    // landed, the body the caller asked to clear stayed, and the receipt
    // said updated: true.
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const err = await rejectedMcpError(
      updateTool.handler(ctx, {
        path: "Notes/Doc.md",
        frontmatter: { status: "final" },
        content: "",
      }),
    );
    expect(err.data).toMatchObject({ code: "blank_overwrite_refused", path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("worth keeping");
    expect(md).not.toContain("status: final");
  });

  test("allow_empty clears the body while merging frontmatter", async () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    await updateTool.handler(ctx, {
      path: "Notes/Doc.md",
      frontmatter: { status: "final" },
      content: "",
      allow_empty: true,
    });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("status: final");
    expect(md).not.toContain("worth keeping");
  });

  test("an existing note the host cannot read is refused, not blanked", async () => {
    // A directory where the note should be: it exists, and reading it
    // raises EISDIR regardless of the running user.
    mkdirSync(join(vault, "Notes/Doc.md"), { recursive: true });
    // At local reach: a remote caller is answered as for a missing note,
    // because a page nobody can measure is treated as one that reserved
    // itself. The diagnostic is for the operator who can fix the file.
    const err = await rejectedMcpError(
      updateTool.handler(
        { ...ctx, reach: TRANSPORT_REACH.local },
        { path: "Notes/Doc.md", content: "replacement" },
      ),
    );
    expect(err.code).toBe(INTERNAL_ERROR);
    expect(err.data).toMatchObject({ code: "target_unreadable", path: "Notes/Doc.md" });
  });

  test("path traversal is refused with INVALID_PARAMS", async () => {
    const err = await rejectedMcpError(
      updateTool.handler(ctx, { path: "../escape.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "invalid_path", index: 0 });
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });
});

describe("brain_append_note - the post-write refresh claim", () => {
  test("an applied append claims one forced refresh: the seam sees force, and the receipt says claimed", async () => {
    // An append writes body bytes, so it is a content edit: the release
    // notes' "a content edit claims" covers it, and an append that left
    // the index stale for an interval would be the gap the claim exists
    // to close.
    seedNote("Notes/Doc.md", "first", "title: Doc");
    await stampIndexStale();
    await mockFreshenSpawned();
    const restore = withIntervalEnv("60");
    try {
      const res = (await appendTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "second",
      })) as Record<string, unknown>;

      expect(res["appended"]).toBe(true);
      expect(res["index_refresh"]).toBe("claimed");
      expect(res["index_refresh_reason"]).toBeNull();
      expect(forcedCalls).toHaveLength(1);
      expect(forcedCalls[0]!.vault).toBe(vault);
      expect(forcedCalls[0]!.opts["force"]).toBe(true);
    } finally {
      restore();
    }
  });

  test("config off does not claim: the receipt says not_claimed and names off", async () => {
    seedNote("Notes/Doc.md", "first", "title: Doc");
    await stampIndexStale();
    const restore = withIntervalEnv("0");
    try {
      const res = (await appendTool.handler(ctx, {
        path: "Notes/Doc.md",
        content: "second",
      })) as Record<string, unknown>;

      expect(res["appended"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("off");
    } finally {
      restore();
    }
  });

  test("a refused append wrote nothing, so it claims nothing", async () => {
    // The typed refusal is thrown before any claim is attempted. The
    // mock is installed and freshening is ON (with a stamped stale
    // index, so a claim that DID run would reach the seam) - the
    // assertion has something to catch: a claim hoisted above the write
    // would light the seam up on its way to the refusal.
    await stampIndexStale();
    await mockFreshenSpawned();
    const restore = withIntervalEnv("60");
    try {
      await rejectedMcpError(appendTool.handler(ctx, { path: "Notes/Ghost.md", content: "x" }));
      expect(forcedCalls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("brain_append_note", () => {
  test("is registered and requires path and content", () => {
    expect(appendTool).toBeDefined();
    expect(appendTool.inputSchema.required).toContain("path");
    expect(appendTool.inputSchema.required).toContain("content");
  });

  test("appends to the body of an existing note", async () => {
    seedNote("Notes/Doc.md", "first", "title: Doc");
    const res = await appendTool.handler(ctx, { path: "Notes/Doc.md", content: "second" });
    expect(res).toMatchObject({ appended: true, path: "Notes/Doc.md" });
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("first");
    expect(md).toContain("second");
    expect(md.indexOf("first")).toBeLessThan(md.indexOf("second"));
  });

  test("a missing target is rejected with INVALID_PARAMS", async () => {
    const err = await rejectedMcpError(
      appendTool.handler(ctx, { path: "Notes/Ghost.md", content: "x" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "target_missing", index: 0, path: "Notes/Ghost.md" });
  });

  test("an existing note the host cannot read is refused, not overwritten", async () => {
    mkdirSync(join(vault, "Notes/Doc.md"), { recursive: true });
    // At local reach, for the reason the update case above gives.
    const err = await rejectedMcpError(
      appendTool.handler(
        { ...ctx, reach: TRANSPORT_REACH.local },
        { path: "Notes/Doc.md", content: "more" },
      ),
    );
    expect(err.code).toBe(INTERNAL_ERROR);
    expect(err.data).toMatchObject({ code: "target_unreadable", path: "Notes/Doc.md" });
  });

  test("declares no allow_empty: an append never replaces a body", () => {
    const schema = appendTool.inputSchema as { properties: Record<string, unknown> };
    expect("allow_empty" in schema.properties).toBe(false);
  });

  test("refuses to author into the Brain machinery root", async () => {
    const err = await rejectedMcpError(
      appendTool.handler(ctx, { path: "Brain/x.md", content: "y" }),
    );
    expect(err.code).toBe(INVALID_PARAMS);
    expect(err.data).toMatchObject({ code: "excluded", index: 0 });
  });
});

describe("writeBatchErrorToMcp", () => {
  test("wraps a non-WriteBatchError into a structured INTERNAL_ERROR MCPError", () => {
    const mapped = writeBatchErrorToMcp(new Error("disk exploded"), "brain_update_note");
    expect(mapped).toBeInstanceOf(MCPError);
    expect(mapped.code).toBe(INTERNAL_ERROR);
    expect(mapped.message).toContain("disk exploded");
  });

  test("maps a WriteBatchError onto a structured INVALID_PARAMS", () => {
    const mapped = writeBatchErrorToMcp(
      new WriteBatchError("target_missing", 2, "note does not exist", { path: "Notes/x.md" }),
      "brain_write_batch",
    );
    expect(mapped).toBeInstanceOf(MCPError);
    expect(mapped.code).toBe(INVALID_PARAMS);
    expect(mapped.data).toMatchObject({ code: "target_missing", index: 2, path: "Notes/x.md" });
  });
});

/**
 * Write-time page lint (evidence-at-the-boundary, task A4). Update and
 * append ran NO document validation at all before this: they returned a
 * hardcoded `{updated: true}` over a document that could have no
 * frontmatter, a bogus type, or malformed tags. The lint runs after the
 * commit, reports what a strict create would have refused, and never
 * gates the write.
 */
describe("the lint attached to the update / append receipts", () => {
  /** The handler's declared return is `unknown`; every case here reads keys. */
  const call = async (
    tool: typeof updateTool,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => (await tool.handler(ctx, args)) as Record<string, unknown>;

  test("a clean update carries the flag, the path and the write id, in that order", async () => {
    seedNote("Notes/Clean.md", "old body", "title: Clean");
    const res = await call(updateTool, { path: "Notes/Clean.md", content: "new body" });
    // The shape is pinned in full so a field cannot arrive unannounced.
    // `write_id` joined it with the note-write record (who-wrote-what,
    // Task A) and is the one key whose VALUE cannot be a literal: it is
    // derived from the instant of the write. The refresh-claim marker
    // joined it when content edits started claiming a refresh (freshening
    // is off suite-wide, so it reads not_claimed with its reason).
    expect(Object.keys(res)).toEqual([
      "updated",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
    expect(res).toMatchObject({ updated: true, path: "Notes/Clean.md" });
    expect(res["write_id"]).toMatch(NOTE_WRITE_ID_RE);
    // An id present means no audit reason is owed, and the lint has
    // nothing to say about a clean page.
    expect("audit_reason" in res).toBe(false);
    expect(PAGE_LINT_KEY in res).toBe(false);
  });

  test("a clean append carries the flag, the path and the write id, in that order", async () => {
    seedNote("Notes/CleanA.md", "first", "title: CleanA");
    const res = await call(appendTool, { path: "Notes/CleanA.md", content: "second" });
    // The shape is pinned in full so a field cannot arrive unannounced.
    // The refresh-claim marker joined the update receipt when content
    // edits started claiming a refresh, and the append - a content edit
    // of its own - claims under the same vocabulary (freshening is off
    // suite-wide, so it reads not_claimed with its reason).
    expect(Object.keys(res)).toEqual([
      "appended",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
    expect(res).toMatchObject({ appended: true, path: "Notes/CleanA.md" });
    expect(res["write_id"]).toMatch(NOTE_WRITE_ID_RE);
    expect("audit_reason" in res).toBe(false);
    expect(PAGE_LINT_KEY in res).toBe(false);
  });

  test("an update that breaks the document reports error findings first", async () => {
    seedNote("Notes/Doc.md", "body", "title: Doc");
    const res = await call(updateTool, {
      path: "Notes/Doc.md",
      frontmatter: { type: "not-a-declared-type" },
      content: "see [[pref-ghost]]",
    });
    expect(res).toMatchObject({ updated: true, path: "Notes/Doc.md" });
    const lint = res[PAGE_LINT_KEY] as { findings: ReadonlyArray<Record<string, unknown>> };
    expect(lint.findings[0]).toMatchObject({ severity: "error", code: "schema-type-unknown" });
    expect(lint.findings.map((f) => f["code"])).toContain("broken-wikilink");
  });

  test("an append that introduces a broken link says so without refusing", async () => {
    seedNote("Notes/App.md", "first", "title: App");
    const res = await call(appendTool, {
      path: "Notes/App.md",
      content: "see [[pref-ghost]]",
    });
    expect(res).toMatchObject({ appended: true });
    const lint = res[PAGE_LINT_KEY] as Record<string, unknown>;
    expect(lint).toMatchObject({ total: 1, returned: 1, truncated: false, skipped: [] });
    expect(readFileSync(join(vault, "Notes/App.md"), "utf8")).toContain("[[pref-ghost]]");
  });
});

/**
 * Undated-quantity lint on update and append receipts (write-honesty, F4,
 * t_fb442a24). Both writes succeed; the advisory rides the receipt with the
 * new code. A page already declaring `valid_from` keeps the clean receipt,
 * with no lint key at all.
 */
describe("the undated-quantity lint on update / append receipts", () => {
  const call = async (
    tool: typeof updateTool,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => (await tool.handler(ctx, args)) as Record<string, unknown>;

  test("an undated numeric update succeeds and carries the finding", async () => {
    seedNote("Notes/UndatedUpdate.md", "old body", "title: U");
    const res = await call(updateTool, {
      path: "Notes/UndatedUpdate.md",
      content: "We onboarded 5,000 users.",
    });
    expect(res).toMatchObject({ updated: true, path: "Notes/UndatedUpdate.md" });
    const lint = res[PAGE_LINT_KEY] as { findings: ReadonlyArray<Record<string, unknown>> };
    expect(lint.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: UNDATED_QUANTITY_CODE,
        page: "Notes/UndatedUpdate.md",
        path: "body",
      }),
    ]);
  });

  test("an update onto a page with valid_from keeps the clean receipt", async () => {
    seedNote("Notes/DatedUpdate.md", "old body", "title: D\nvalid_from: 2026-10-01");
    const res = await call(updateTool, {
      path: "Notes/DatedUpdate.md",
      content: "We onboarded 5,000 users.",
    });
    expect(PAGE_LINT_KEY in res).toBe(false);
    expect(Object.keys(res)).toEqual([
      "updated",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
  });

  test("an undated numeric append succeeds and carries the finding", async () => {
    seedNote("Notes/UndatedAppend.md", "first", "title: A");
    const res = await call(appendTool, {
      path: "Notes/UndatedAppend.md",
      content: "We onboarded 5,000 users.",
    });
    expect(res).toMatchObject({ appended: true, path: "Notes/UndatedAppend.md" });
    const lint = res[PAGE_LINT_KEY] as { findings: ReadonlyArray<Record<string, unknown>> };
    expect(lint.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: UNDATED_QUANTITY_CODE,
        page: "Notes/UndatedAppend.md",
        path: "body",
      }),
    ]);
  });

  test("an append onto a page with valid_from keeps the clean receipt", async () => {
    seedNote("Notes/DatedAppend.md", "first", "title: D\nvalid_from: 2026-10-01");
    const res = await call(appendTool, {
      path: "Notes/DatedAppend.md",
      content: "We onboarded 5,000 users.",
    });
    expect(PAGE_LINT_KEY in res).toBe(false);
    expect(Object.keys(res)).toEqual([
      "appended",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
  });
});
