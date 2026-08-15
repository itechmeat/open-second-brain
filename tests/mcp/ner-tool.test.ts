/**
 * MCP integration tests for `brain_intake_entities` (model-based NER intake,
 * Knowledge Provenance suite). The calling agent owns the recognition; the
 * tool validates the typed payload and commits it through the shared
 * extraction-intake primitive. OSB never runs a model here.
 *
 * The handler is exercised directly with a minimal ServerContext - the arg
 * validation and the INVALID_PARAMS translation are the surface under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { getEntity, listEntities } from "../../src/core/brain/entities/registry.ts";
import { NER_TOOLS } from "../../src/mcp/brain/ner-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ner-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ner-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  // The locked directory first: a 0-mode directory cannot be walked, so the
  // vault removal below would fail on the test that creates one.
  try {
    chmodSync(join(vault, LOCKED_DIR), 0o755);
  } catch {
    // Only one test creates it.
  }
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** A directory this vault denies itself, so `stat` answers with an errno. */
const LOCKED_DIR = "Locked";
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const handler = NER_TOOLS[0]!.handler;

/**
 * A cited source is trusted only when the file it names is really there
 * (GitHub #160), so every intake below that expects its entities in the
 * canonical registry seeds the note it claims to have read.
 */
function seed(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `bytes of ${rel}\n`, "utf8");
}

describe("brain_intake_entities", () => {
  test("intakes agent-supplied entities into the registry", async () => {
    seed("Notes/scaling.md");
    const res = await handler(ctx, {
      source: "[[Notes/scaling.md]]",
      entities: [
        { category: "concept", name: "Layer 2s" },
        { category: "people", name: "Vitalik", aliases: ["V."] },
      ],
    });
    expect(res).toEqual({
      entities_created: [expect.any(String), expect.any(String)],
      entities_updated: [],
      relations_applied: 0,
      trust: "trusted",
    });
    expect(listEntities(vault)).toHaveLength(2);
    expect(getEntity(vault, { category: "concept", query: "Layer 2s" })?.name).toBe("Layer 2s");
  });

  test("applies typed relations between extracted entities", async () => {
    seed("Notes/restaking.md");
    const res = await handler(ctx, {
      source: "[[Notes/restaking.md]]",
      entities: [
        { category: "concept", name: "Restaking" },
        { category: "concept", name: "Validators" },
      ],
      relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
    });
    expect(res).toMatchObject({ relations_applied: 1 });
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.relations.some((r) => r.relation === "related")).toBe(true);
  });

  test("cites the source wikilink in a newly created entity body", async () => {
    seed("Articles/eth-roadmap.md");
    await handler(ctx, {
      entities: [{ category: "concept", name: "Sharding" }],
      source: "[[Articles/eth-roadmap.md]]",
    });
    const sharding = getEntity(vault, { category: "concept", query: "Sharding" });
    expect(sharding?.body).toContain("## Sources");
    expect(sharding?.body).toContain("[[Articles/eth-roadmap.md]]");
  });

  test("rejects an empty entities array with INVALID_PARAMS and writes nothing", async () => {
    await expect(handler(ctx, { entities: [] })).rejects.toThrow(MCPError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  /**
   * The classifier refuses an unreadable source rather than calling it
   * untrusted, and that refusal reaches the caller as an MCP error. Rethrown
   * verbatim, the Node errno spells out `/home/<user>/<vault>/Locked/note.md`
   * - an existence-and-permission oracle over the operator's filesystem,
   * queried with a string the caller chose. The refusal is right; the
   * operator's path in the answer is not.
   */
  test.skipIf(RUNNING_AS_ROOT)("an unreadable source fails without naming a path", async () => {
    const locked = join(vault, LOCKED_DIR);
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "note.md"), "bytes\n", "utf8");
    chmodSync(locked, 0o000);
    let thrown: unknown;
    try {
      await handler(ctx, {
        source: `[[${LOCKED_DIR}/note.md]]`,
        entities: [{ category: "concept", name: "Restaking" }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    const message = (thrown as Error).message;
    expect(message).toContain(`${LOCKED_DIR}/note.md`);
    expect(message).toContain("EACCES");
    expect(message).not.toContain(vault);
    expect(message).not.toContain("permission denied");
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("translates an unknown relation into INVALID_PARAMS with no partial write", async () => {
    // A real source, so the refusal under test is the relation vocabulary and
    // not the source contract checked before it.
    seed("Notes/scaling.md");
    await expect(
      handler(ctx, {
        source: "[[Notes/scaling.md]]",
        entities: [
          { category: "concept", name: "A" },
          { category: "concept", name: "B" },
        ],
        relations: [{ from: "A", relation: "causes", to: "B" }],
      }),
    ).rejects.toThrow(MCPError);
    expect(listEntities(vault)).toHaveLength(0);
  });
});
