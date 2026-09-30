/**
 * MCP integration tests for `brain_write_batch` (W2, t_7718ab22): the
 * general atomic batch write tool, the second consumer of kernel 2.
 *
 * A mixed batch commits all-or-nothing; the first invalid operation
 * aborts with a typed error naming the operation index and no disk write
 * happens. Single-operation batches produce results equal to the
 * dedicated brain_create_note / brain_update_note / brain_append_note
 * tools.
 *
 * The nothing-writes-silently wave (unit B) adds `allow_empty` to the
 * `update_note` op object and pins the two refusals the batch inherits
 * from the shared projection: a blank body over a note that has one, and
 * a target the host cannot read - each aborting the whole batch before
 * any operation commits.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { readLogDay } from "../../src/core/brain/log-jsonl.ts";
import { writeImagesDir } from "../../src/core/brain/paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { WRITE_BATCH_TOOLS } from "../../src/mcp/brain/write-batch-tools.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { MAX_BATCH_OPERATIONS } from "../../src/core/brain/write-batch.ts";
import * as ledger from "../../src/core/brain/idempotency-ledger.ts";
import { PAGE_LINT_KEY } from "../../src/core/brain/page-lint.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

/**
 * Shape of a note-write id, as `noteWriteId` spells it (who-wrote-what,
 * Task A). Its value carries the instant of the write, so a receipt test
 * pins the shape rather than a literal.
 */
const NOTE_WRITE_ID_RE = /^nw_\d{14}_[0-9a-f]{16}$/;

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-write-batch-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-write-batch-cfg-"));
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

function writePref(slug: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${slug}`,
      "_status: confirmed",
      "principle: always test first",
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

const tool = WRITE_BATCH_TOOLS.find((t) => t.name === "brain_write_batch")!;

type BatchResponse = {
  readonly applied: number;
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly done: true;
  readonly [PAGE_LINT_KEY]?: {
    readonly findings: ReadonlyArray<Record<string, unknown>>;
    readonly total: number;
    readonly returned: number;
    readonly truncated: boolean;
    readonly skipped: ReadonlyArray<Record<string, unknown>>;
  };
};

async function runBatch(operations: unknown[]): Promise<BatchResponse> {
  return (await tool.handler(ctx, { operations })) as unknown as BatchResponse;
}

describe("brain_write_batch", () => {
  test("is registered and requires operations", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("operations");
  });

  test("commits a mixed batch all-or-nothing", async () => {
    writePref("test-first");
    seedNote("Notes/Existing.md", "old", "title: E");
    const res = await runBatch([
      { op: "create_note", path: "Notes/New.md", content: "fresh" },
      { op: "update_note", path: "Notes/Existing.md", content: "updated" },
      {
        op: "apply_evidence",
        pref_id: "test-first",
        artifact: "[[Notes/New.md]]",
        result: "applied",
      },
      { op: "append_log_line", text: "batch landed" },
    ]);
    expect(res.applied).toBe(4);
    expect(existsSync(join(vault, "Notes/New.md"))).toBe(true);
    expect(readFileSync(join(vault, "Notes/Existing.md"), "utf8")).toContain("updated");
  });

  test("a later invalid op aborts the batch: earlier ops do not land", async () => {
    await expect(
      tool.handler(ctx, {
        operations: [
          { op: "create_note", path: "Notes/First.md", content: "one" },
          // op 1 is invalid: the preference does not exist.
          { op: "apply_evidence", pref_id: "ghost", artifact: "[[x]]", result: "applied" },
        ],
      }),
    ).rejects.toThrow(MCPError);
    // Op 0 must not have landed.
    expect(existsSync(join(vault, "Notes/First.md"))).toBe(false);
  });

  test("the typed error names the offending operation index", async () => {
    let thrown: unknown;
    try {
      await tool.handler(ctx, {
        operations: [
          { op: "create_note", path: "Notes/Ok.md", content: "x" },
          { op: "update_note", path: "Notes/Ghost.md", content: "y" },
        ],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({ index: 1, code: "target_missing" });
    expect(existsSync(join(vault, "Notes/Ok.md"))).toBe(false);
  });

  test("an empty operations array is rejected", async () => {
    await expect(tool.handler(ctx, { operations: [] })).rejects.toThrow(MCPError);
  });

  test("a batch over the operation cap is rejected before any write", async () => {
    const tooMany = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => ({
      op: "create_note",
      path: `Notes/Over-${i}.md`,
      content: "x",
    }));
    let thrown: unknown;
    try {
      await tool.handler(ctx, { operations: tooMany });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({
      code: "too_many_operations",
      index: -1,
      max: MAX_BATCH_OPERATIONS,
      count: MAX_BATCH_OPERATIONS + 1,
    });
    // Nothing landed: the cap is enforced during validation, before commit.
    expect(existsSync(join(vault, "Notes/Over-0.md"))).toBe(false);
  });

  test("the inputSchema advertises the operation cap via maxItems", () => {
    const schema = tool.inputSchema as {
      properties: { operations: { maxItems?: number } };
    };
    expect(schema.properties.operations.maxItems).toBe(MAX_BATCH_OPERATIONS);
  });

  test("the operation object declares allow_empty with a description", () => {
    const schema = tool.inputSchema as {
      properties: {
        operations: {
          items: { properties: Record<string, { type?: string; description?: string }> };
        };
      };
    };
    const allowEmpty = schema.properties.operations.items.properties["allow_empty"];
    expect(allowEmpty?.type).toBe("boolean");
    expect((allowEmpty?.description ?? "").length).toBeGreaterThan(0);
  });

  test("an update_note op refuses to blank a note that has a body", async () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    let thrown: unknown;
    try {
      await runBatch([{ op: "update_note", path: "Notes/Doc.md", content: "" }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({
      code: "blank_overwrite_refused",
      index: 0,
      path: "Notes/Doc.md",
    });
    expect(readFileSync(join(vault, "Notes/Doc.md"), "utf8")).toContain("worth keeping");
  });

  test("allow_empty on the op clears the body deliberately", async () => {
    seedNote("Notes/Doc.md", "worth keeping", "title: Doc");
    const res = await runBatch([
      { op: "update_note", path: "Notes/Doc.md", content: "", allow_empty: true },
    ]);
    expect(res.applied).toBe(1);
    const md = readFileSync(join(vault, "Notes/Doc.md"), "utf8");
    expect(md).toContain("title: Doc");
    expect(md).not.toContain("worth keeping");
  });

  test("an unreadable note aborts the batch before any op lands", async () => {
    mkdirSync(join(vault, "Notes/Unreadable.md"), { recursive: true });
    let thrown: unknown;
    try {
      await runBatch([
        { op: "create_note", path: "Notes/First.md", content: "one" },
        { op: "update_note", path: "Notes/Unreadable.md", content: "two" },
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).data).toMatchObject({ code: "target_unreadable", index: 1 });
    expect(existsSync(join(vault, "Notes/First.md"))).toBe(false);
  });

  test("single-op create parity with brain_create_note", async () => {
    const createTool = NOTES_TOOLS.find((t) => t.name === "brain_create_note")!;
    const direct = await createTool.handler(ctx, { path: "Notes/Direct.md", content: "d" });
    const batch = await runBatch([{ op: "create_note", path: "Notes/Batch.md", content: "d" }]);
    const batchResult = batch.results[0]!;
    expect(batchResult).toMatchObject({ kind: "create_note", created: true });
    expect(direct).toMatchObject({ created: true });
  });

  test("single-op update parity with brain_update_note", async () => {
    seedNote("Notes/A.md", "old", "title: A");
    seedNote("Notes/B.md", "old", "title: B");
    const updateTool = NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;
    const direct = await updateTool.handler(ctx, { path: "Notes/A.md", content: "new" });
    const batch = await runBatch([{ op: "update_note", path: "Notes/B.md", content: "new" }]);
    const batchResult = batch.results[0]!;
    expect(direct).toMatchObject({ updated: true, path: "Notes/A.md" });
    expect(batchResult).toMatchObject({ kind: "update_note", updated: true, path: "Notes/B.md" });
    expect(readFileSync(join(vault, "Notes/A.md"), "utf8")).toBe(
      readFileSync(join(vault, "Notes/B.md"), "utf8").replace("title: B", "title: A"),
    );
  });

  test("single-op append parity with brain_append_note", async () => {
    seedNote("Notes/A.md", "base", "title: A");
    seedNote("Notes/B.md", "base", "title: A");
    const appendTool = NOTES_TOOLS.find((t) => t.name === "brain_append_note")!;
    await appendTool.handler(ctx, { path: "Notes/A.md", content: "more" });
    await tool.handler(ctx, {
      operations: [{ op: "append_note", path: "Notes/B.md", content: "more" }],
    });
    expect(readFileSync(join(vault, "Notes/A.md"), "utf8")).toBe(
      readFileSync(join(vault, "Notes/B.md"), "utf8"),
    );
  });

  test("refuses the Brain machinery root in a create op", async () => {
    await expect(
      tool.handler(ctx, { operations: [{ op: "create_note", path: "Brain/x.md", content: "y" }] }),
    ).rejects.toThrow(MCPError);
  });
});

/**
 * Write-time page lint (evidence-at-the-boundary, task A4). The batch ran
 * no document validation at all; the lint runs once over every page the
 * batch committed, with the basename index and schema pack computed ONCE
 * per call rather than once per operation.
 */
describe("brain_write_batch - the lint attached to the receipt", () => {
  test("a clean batch carries the counts, the results and each write id", async () => {
    const res = await runBatch([
      {
        op: "create_note",
        path: "Notes/CleanBatch.md",
        frontmatter: { title: "Clean" },
        content: "prose",
      },
    ]);
    expect(Object.keys(res)).toEqual(["applied", "results", "done"]);
    const only = (res["results"] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(Object.keys(only)).toEqual(["kind", "path", "created", "write_id"]);
    expect(only).toMatchObject({
      kind: "create_note",
      path: "Notes/CleanBatch.md",
      created: true,
    });
    // Each note result names the event that attributes it; the batch
    // envelope itself is unchanged (who-wrote-what, Task A).
    expect(only["write_id"]).toMatch(NOTE_WRITE_ID_RE);
    expect(res["applied"]).toBe(1);
    expect(res["done"]).toBe(true);
    expect(PAGE_LINT_KEY in res).toBe(false);
  });

  test("one report spans every page the batch wrote, each finding naming its page", async () => {
    const res = await runBatch([
      {
        op: "create_note",
        path: "Notes/One.md",
        frontmatter: { title: "One" },
        content: "see [[pref-ghost]]",
      },
      {
        op: "create_note",
        path: "Notes/Two.md",
        frontmatter: { title: "Two" },
        content: "see [[pref-other-ghost]]",
      },
      { op: "append_log_line", text: "batch landed" },
    ]);
    const lint = res[PAGE_LINT_KEY]!;
    expect(lint.total).toBe(2);
    expect(lint.returned).toBe(2);
    expect(lint.truncated).toBe(false);
    expect(lint.findings.map((f) => f["page"]).toSorted()).toEqual([
      "Notes/One.md",
      "Notes/Two.md",
    ]);
  });

  test("a log-only batch writes no page and lints nothing", async () => {
    const res = await runBatch([{ op: "append_log_line", text: "just a line" }]);
    expect(res.applied).toBe(1);
    expect(PAGE_LINT_KEY in res).toBe(false);
  });

  test("a byte-identical rewrite that skipped names no page for the lint", async () => {
    // The write that happened carries its finding; the re-apply that
    // skipped carries the receipt but no lint, the same rule the
    // single-write receipts follow - nothing was committed, so the
    // envelope names no page as one the batch wrote.
    seedNote("Notes/SkipLint.md", "v1");
    const body = "see [[pref-ghost]]";
    const first = await runBatch([{ op: "update_note", path: "Notes/SkipLint.md", content: body }]);
    expect(PAGE_LINT_KEY in first).toBe(true);
    const second = await runBatch([
      { op: "update_note", path: "Notes/SkipLint.md", content: body },
    ]);
    expect(second.results[0]).toMatchObject({ kind: "update_note", updated: false });
    expect(PAGE_LINT_KEY in second).toBe(false);
  });
});

/**
 * The absolute-path advisory (p4-silent-failure-hardening, Task 3). A
 * note body embedding an absolute home path used to land with no word
 * about it. The advisory rides each note result like page-lint rides the
 * envelope: non-blocking, and absent entirely when there is nothing to
 * say. Path fragments are composed so this file stays clean under the
 * repo hygiene gate's grammar.
 */
describe("brain_write_batch - the absolute-path advisory on the receipt", () => {
  const HOME = "/home/";
  const leaky = `see ${HOME}alice-dev/notes/x.md for details`;

  test("an update authoring a home path carries the advisory and still applies", async () => {
    seedNote("Notes/Leaky.md", "old", "title: Leaky");
    const res = await runBatch([{ op: "update_note", path: "Notes/Leaky.md", content: leaky }]);
    // Non-blocking: the batch applies and the bytes land.
    expect(res.applied).toBe(1);
    expect(readFileSync(join(vault, "Notes/Leaky.md"), "utf8")).toContain("alice-dev");
    const only = res.results[0]!;
    const advisory = only["path_advisory"] as
      | { total: number; findings: ReadonlyArray<Record<string, unknown>> }
      | undefined;
    expect(advisory).toBeDefined();
    expect(advisory!.total).toBe(1);
    expect(advisory!.findings).toEqual([
      { page: "Notes/Leaky.md", line: 1, detector: "unix-home" },
    ]);
    // The advisory echoes identifiers and integers, never the path itself.
    expect(JSON.stringify(res)).not.toContain(`${HOME}alice-dev`);
  });

  test("a clean update carries no advisory key at all", async () => {
    seedNote("Notes/Clean.md", "old", "title: Clean");
    const res = await runBatch([{ op: "update_note", path: "Notes/Clean.md", content: "new" }]);
    const only = res.results[0]!;
    expect(Object.keys(only)).toEqual(["kind", "path", "updated", "write_id"]);
    expect("path_advisory" in only).toBe(false);
  });

  test("a frontmatter-only update authors no body and carries no advisory", async () => {
    seedNote("Notes/Fm.md", "prose with no leak", "title: Fm");
    const res = await runBatch([
      { op: "update_note", path: "Notes/Fm.md", frontmatter: { title: "Fm2" } },
    ]);
    expect(res.applied).toBe(1);
    expect("path_advisory" in res.results[0]!).toBe(false);
  });

  test("create and append ops carry the advisory; log-line ops do not", async () => {
    seedNote("Notes/AppTarget.md", "base", "title: AppTarget");
    const res = await runBatch([
      { op: "create_note", path: "Notes/Created.md", content: leaky },
      { op: "append_note", path: "Notes/AppTarget.md", content: leaky },
      { op: "append_log_line", text: "batch landed" },
    ]);
    expect(res.applied).toBe(3);
    const [created, appended, logLine] = res.results;
    expect("path_advisory" in created!).toBe(true);
    expect("path_advisory" in appended!).toBe(true);
    expect("path_advisory" in logLine!).toBe(false);
  });

  test("brain_update_note passes the advisory through on its receipt", async () => {
    seedNote("Notes/Single.md", "old", "title: Single");
    const updateTool = NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;
    const leakyBody = `body with ${HOME}alice-dev/leak.md inside`;
    const res = (await updateTool.handler(ctx, {
      path: "Notes/Single.md",
      content: leakyBody,
    })) as Record<string, unknown>;
    expect(res["updated"]).toBe(true);
    const advisory = res["path_advisory"] as {
      total: number;
      findings: ReadonlyArray<Record<string, unknown>>;
    };
    expect(advisory.total).toBe(1);
    expect(advisory.findings[0]).toMatchObject({ page: "Notes/Single.md", line: 1 });
    expect(JSON.stringify(res)).not.toContain(`${HOME}alice-dev`);
  });

  test("brain_append_note carries no advisory key on a clean receipt", async () => {
    seedNote("Notes/App.md", "base", "title: App");
    const appendTool = NOTES_TOOLS.find((t) => t.name === "brain_append_note")!;
    const res = (await appendTool.handler(ctx, {
      path: "Notes/App.md",
      content: "clean addition",
    })) as Record<string, unknown>;
    expect(Object.keys(res)).toEqual(["appended", "path", "write_id"]);
    expect("path_advisory" in res).toBe(false);
  });
});

/** Note-write events recorded in today's log shard. */
function noteWriteEvents(): number {
  const day = readLogDay(vault, new Date().toISOString().slice(0, 10));
  return day.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.noteWrite).length;
}

function writeImages(): number {
  const dir = writeImagesDir(vault);
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

/** Stamp a note's mtime one minute into the past, measurably. */
function ageMtime(abs: string): number {
  const past = Date.now() / 1000 - 60;
  utimesSync(abs, past, past);
  return statSync(abs).mtimeMs;
}

/**
 * mtime stability on byte-identical rewrites (p4-silent-failure-hardening,
 * Task 6). The atomic write pipeline lands a fresh inode on every call,
 * so re-applying a byte-identical update used to bump the note's mtime -
 * poisoning recency ranking, validity windows and vault-delta counts -
 * while storing a before-image and recording a note-write event for a
 * write that never happened. The commit now skips unchanged targets, and
 * the receipt says what actually occurred.
 */
describe("brain_write_batch - mtime stability on byte-identical rewrites", () => {
  test("a byte-identical update re-applied writes nothing and says updated: false", async () => {
    seedNote("Notes/Stable.md", "v1");
    const first = await runBatch([{ op: "update_note", path: "Notes/Stable.md", content: "v2" }]);
    expect(first.results[0]).toMatchObject({ kind: "update_note", updated: true });

    const abs = join(vault, "Notes/Stable.md");
    const mtime = ageMtime(abs);
    const events = noteWriteEvents();
    const images = writeImages();

    const second = await runBatch([{ op: "update_note", path: "Notes/Stable.md", content: "v2" }]);
    const only = second.results[0]!;
    expect(only).toMatchObject({ kind: "update_note", path: "Notes/Stable.md", updated: false });
    // The mtime is untouched: no temp file, no rename, no fresh inode.
    expect(statSync(abs).mtimeMs).toBe(mtime);
    // No audit line exists for a write that did not happen - no note-write
    // event, no before-image, and no null write_id that could be mistaken
    // for a lost one.
    expect(noteWriteEvents()).toBe(events);
    expect(writeImages()).toBe(images);
    expect("write_id" in only).toBe(false);
    expect("audit_reason" in only).toBe(false);
  });

  test("a real change still bumps the mtime and reports updated: true", async () => {
    seedNote("Notes/Real.md", "v1");
    const abs = join(vault, "Notes/Real.md");
    const mtime = ageMtime(abs);
    const res = await runBatch([{ op: "update_note", path: "Notes/Real.md", content: "v2" }]);
    const only = res.results[0]!;
    expect(only).toMatchObject({ kind: "update_note", path: "Notes/Real.md", updated: true });
    expect(statSync(abs).mtimeMs).toBeGreaterThan(mtime);
    // A write that happened stays attributed.
    expect("write_id" in only).toBe(true);
  });

  test("an append with a fresh body reports appended: true", async () => {
    seedNote("Notes/Appended.md", "base", "title: Appended");
    const res = await runBatch([{ op: "append_note", path: "Notes/Appended.md", content: "more" }]);
    expect(res.results[0]).toMatchObject({
      kind: "append_note",
      path: "Notes/Appended.md",
      appended: true,
    });
    expect(readFileSync(join(vault, "Notes/Appended.md"), "utf8")).toContain("base");
    expect(readFileSync(join(vault, "Notes/Appended.md"), "utf8")).toContain("more");
  });
});

describe("brain_write_batch request receipts (t_b34439d9)", () => {
  const OPS = [{ op: "create_note", path: "Notes/Receipted.md", content: "written once" }];

  test("a request_id returns a receipt, and a retry returns the retained duplicate", async () => {
    const first = (await tool.handler(ctx, {
      operations: OPS,
      request_id: "req-42",
    })) as Record<string, unknown>;
    expect(first["request_id"]).toBe("req-42");
    expect(first["receipt"]).toBe("applied");
    expect(first["applied"]).toBe(1);

    const retry = (await tool.handler(ctx, {
      operations: OPS,
      request_id: "req-42",
    })) as Record<string, unknown>;
    expect(retry["request_id"]).toBe("req-42");
    expect(retry["receipt"]).toBe("duplicate");
    // The retained original receipt: the batch reports what the FIRST call
    // applied, and nothing new lands.
    expect(retry["applied"]).toBe(1);
    expect(existsSync(join(vault, "Notes/Receipted.md"))).toBe(true);
  });

  test("a request_id omitted leaves the payload without receipt fields", async () => {
    const res = (await tool.handler(ctx, { operations: OPS })) as Record<string, unknown>;
    expect(Object.hasOwn(res, "request_id")).toBe(false);
    expect(Object.hasOwn(res, "receipt")).toBe(false);
  });

  test("a concurrent duplicate recorded mid-batch reaches the caller by its own status", async () => {
    const LOG_OPS = [{ op: "append_log_line", text: "concurrent receipt line" }];
    await tool.handler(ctx, { operations: LOG_OPS, request_id: "req-race" });
    // The unlocked consult misses the rival's record, as under a concurrent call.
    const spy = spyOn(ledger, "lookupKey").mockReturnValueOnce(null);
    try {
      const res = (await tool.handler(ctx, {
        operations: LOG_OPS,
        request_id: "req-race",
      })) as Record<string, unknown>;
      expect(res["receipt"]).toBe("concurrent_duplicate");
    } finally {
      spy.mockRestore();
    }
  });

  test("a concurrent record of the same id with another payload: this call's writes landed and the receipt says so", async () => {
    await tool.handler(ctx, {
      operations: [{ op: "append_log_line", text: "the rival line" }],
      request_id: "req-conflict",
    });
    const spy = spyOn(ledger, "lookupKey").mockReturnValueOnce(null);
    try {
      const res = (await tool.handler(ctx, {
        operations: OPS,
        request_id: "req-conflict",
      })) as Record<string, unknown>;
      expect(res["receipt"]).toBe("payload_conflict");
      expect(res["applied"]).toBe(1);
      expect(res["done"]).toBe(true);
      expect(String(res["receipt_note"])).toMatch(/writes of this call landed/);
      expect(existsSync(join(vault, "Notes/Receipted.md"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    ["a number", 7],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["an over-long id", "x".repeat(300)],
  ])("request_id as %s is INVALID_PARAMS before any write", async (_label, requestId) => {
    let thrown: unknown = null;
    try {
      await tool.handler(ctx, { operations: OPS, request_id: requestId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).code).toBe(INVALID_PARAMS);
    expect((thrown as MCPError).message).toMatch(/request_id|idempotency key/);
    expect(existsSync(join(vault, "Notes/Receipted.md"))).toBe(false);
  });

  test("a duplicate retry lints nothing: the call wrote no page", async () => {
    const first = (await tool.handler(ctx, { operations: OPS, request_id: "req-lint" })) as Record<
      string,
      unknown
    >;
    const retry = (await tool.handler(ctx, { operations: OPS, request_id: "req-lint" })) as Record<
      string,
      unknown
    >;
    expect(retry["receipt"]).toBe("duplicate");
    expect(PAGE_LINT_KEY in first).toBe(true);
    expect(PAGE_LINT_KEY in retry).toBe(false);
  });
});
