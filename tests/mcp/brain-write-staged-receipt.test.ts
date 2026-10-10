/**
 * MCP staged receipts (write-side trust, Task 9).
 *
 * With a review lane's gate on, `brain_create_note` stages the create
 * into `Brain/pending/notes/` and `brain_write_batch` reports the staged
 * op per-op. The receipt is the contract an agent reads: `created: false`
 * is NOT a refusal, `staged: true` says where the bytes went, and
 * `pending_id` plus `next_command` name the queue entry and the operator
 * command that publishes it. With the toggle absent every receipt here is
 * byte-identical to its pre-Task-9 shape - that property is pinned by the
 * unmodified create/batch suites, not by this file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { WRITE_BATCH_TOOLS } from "../../src/mcp/brain/write-batch-tools.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const NOTES_ENV = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED";
const INGEST_ENV = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";

let vault: string;
let configHome: string;
let ctx: ServerContext;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-staged-receipt-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-staged-receipt-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
  for (const key of [NOTES_ENV, INGEST_ENV]) {
    savedEnv[key] = process.env[key];
    process.env[key] = "true";
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const createNote = NOTES_TOOLS.find((t) => t.name === "brain_create_note")!.handler;
const writeBatch = WRITE_BATCH_TOOLS.find((t) => t.name === "brain_write_batch")!.handler;
const ingestSource = INGEST_TOOLS.find((t) => t.name === "brain_ingest_source")!.handler;

describe("brain_create_note staged receipt", () => {
  test("a gated create reports staged with the pending id and next command", async () => {
    const res = (await createNote(ctx, {
      path: "Notes/Staged.md",
      frontmatter: { title: "Staged" },
      content: "awaiting review",
    })) as Record<string, unknown>;
    expect(res["created"]).toBe(false);
    expect(res["outcome"]).toBe("staged");
    expect(res["staged"]).toBe(true);
    expect(res["path"]).toBe("Notes/Staged.md");
    expect(typeof res["pending_id"]).toBe("string");
    expect(res["next_command"]).toBe("o2b brain pending apply <pending-id>");
    // Nothing exists at the publish target; the bytes sit in the queue.
    expect(existsSync(join(vault, "Notes/Staged.md"))).toBe(false);
    const pendingId = res["pending_id"] as string;
    const stagedBytes = readFileSync(join(vault, "Brain/pending/notes", `${pendingId}.md`), "utf8");
    expect(stagedBytes).toContain("awaiting review");
  });
});

describe("brain_write_batch staged op receipt", () => {
  test("a staged create op carries created false, staged true and the pending id", async () => {
    const res = (await writeBatch(ctx, {
      operations: [{ op: "create_note", path: "Notes/Batch Staged.md", content: "batch bytes" }],
    })) as { results: Array<Record<string, unknown>> };
    const only = res.results[0]!;
    expect(only["kind"]).toBe("create_note");
    expect(only["created"]).toBe(false);
    expect(only["staged"]).toBe(true);
    expect(only["path"]).toBe("Notes/Batch Staged.md");
    expect(typeof only["pending_id"]).toBe("string");
    expect(only["next_command"]).toBe("o2b brain pending apply <pending-id>");
    expect(existsSync(join(vault, "Notes/Batch Staged.md"))).toBe(false);
  });

  test("a mixed batch stages the create and appends the published note directly", async () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    const seed = join(vault, "Notes/Direct.md");
    writeFileSync(seed, "existing\n", "utf8");
    const res = (await writeBatch(ctx, {
      operations: [
        { op: "create_note", path: "Notes/New.md", content: "staged" },
        { op: "append_note", path: "Notes/Direct.md", content: "appended" },
      ],
    })) as { results: Array<Record<string, unknown>> };
    expect(res.results[0]!["staged"]).toBe(true);
    expect(res.results[1]!["appended"]).toBe(true);
    expect(readFileSync(seed, "utf8")).toContain("appended");
  });
});

describe("brain_ingest_source staged receipt", () => {
  test("a gated first ingest reports staged with the pending id and next command", async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles/eth.md"), "bytes of the source\n", "utf8");
    const res = (await ingestSource(ctx, {
      source_path: "Articles/eth.md",
      summary: "Ethereum scaling overview.",
      entities: [{ category: "concept", name: "Rollups" }],
    })) as Record<string, unknown>;
    expect(res["staged"]).toBe(true);
    expect(typeof res["pending_id"]).toBe("string");
    expect(res["next_command"]).toBe("o2b brain pending apply <pending-id>");
    // The summary page's publish target is untouched; the bytes are queued.
    expect(existsSync(join(vault, res["summary_path"] as string))).toBe(false);
    const pendingId = res["pending_id"] as string;
    const stagedBytes = readFileSync(
      join(vault, "Brain/pending/ingest", `${pendingId}.md`),
      "utf8",
    );
    expect(stagedBytes).toContain("Ethereum scaling overview.");
  });
});

/**
 * The deny arm (write-side trust, Task 12): under a permissions document
 * rule that refuses the write, the tool answers with the NAMED refusal -
 * the `write-refused` code, the rule that decided, and the operator
 * command - never as an internal error a caller would retry into the
 * same wall. Nothing is written and no queue entry exists.
 */
describe("document-denied writes answer as named refusals", () => {
  const DOC = () => join(vault, "Brain", "_permissions.yaml");

  test("brain_create_note carries the write-refused code and the rule", async () => {
    writeFileSync(DOC(), "version: 1\ndefault_action: deny\n");
    let refused: MCPError | undefined;
    try {
      await createNote(ctx, { path: "Notes/Denied.md", content: "x" });
    } catch (err) {
      refused = err instanceof MCPError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(MCPError);
    expect((refused?.data as { code?: string } | undefined)?.code).toBe("write-refused");
    expect((refused?.data as { rule?: string } | undefined)?.rule).toBe("default");
    expect((refused?.data as { next_command?: string } | undefined)?.next_command).toBe(
      "o2b brain permissions show",
    );
    expect(existsSync(join(vault, "Notes/Denied.md"))).toBe(false);
    expect(existsSync(join(vault, "Brain/pending/notes"))).toBe(false);
  });

  test("brain_ingest_source carries the write-refused code before any write", async () => {
    writeFileSync(DOC(), "version: 1\ndefault_action: deny\n");
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles/eth.md"), "source bytes\n", "utf8");
    let refused: MCPError | undefined;
    try {
      await ingestSource(ctx, {
        source_path: "Articles/eth.md",
        summary: "Ethereum scaling overview.",
        entities: [{ category: "concept", name: "Rollups" }],
      });
    } catch (err) {
      refused = err instanceof MCPError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(MCPError);
    expect((refused?.data as { code?: string } | undefined)?.code).toBe("write-refused");
    expect(String(refused?.message)).toContain("write refused");
    // The refusal precedes registration: no entity page exists either
    // (the starter bundle leaves the entities directory empty).
    const entitiesDir = join(vault, "Brain", "entities");
    expect(existsSync(entitiesDir) ? readdirSync(entitiesDir).length : 0).toBe(0);
    expect(existsSync(join(vault, "Brain/pending/ingest"))).toBe(false);
  });
});
