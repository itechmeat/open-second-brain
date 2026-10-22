/**
 * MCP integration test for `brain_create_note` (Brain Portability &
 * Interop suite, Unit D). The tool writes an actual vault note file
 * (path + frontmatter + content) - distinct from `brain_note`, which
 * only appends a log line. Handler exercised directly with a minimal
 * context. Refusals map to INVALID_PARAMS and write nothing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { WRITE_BATCH_TOOLS } from "../../src/mcp/brain/write-batch-tools.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { PAGE_LINT_KEY, UNDATED_QUANTITY_CODE } from "../../src/core/brain/page-lint.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../../src/core/write-binding/index.ts";
import { listMcpRouteLatency } from "../../src/core/brain/mcp-route-metrics.ts";
import { isRouteStageName } from "../../src/core/route-scope.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { MCPServer } from "../../src/mcp/server.ts";
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
  vault = mkdtempSync(join(tmpdir(), "o2b-create-note-tool-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-create-note-tool-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = NOTES_TOOLS.find((t) => t.name === "brain_create_note")!;
const handler = tool.handler;

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
 * The post-write index refresh a created note claims.
 *
 * The card names created notes among the writes that must resolve
 * without a reindex, so an applied create claims the SAME detached,
 * claim-guarded refresh a lifecycle write claims - fire-and-forget, with
 * the claim marker and its refusal reason on the receipt under the same
 * vocabulary (`index_refresh`, `index_refresh_reason`). The seam is the
 * freshen module itself, mocked here so the assertion sees the forced
 * call without ever spawning a real indexer; the suite-wide freshen-off
 * default keeps every OTHER test in this file inert.
 */
describe("brain_create_note - the post-write refresh claim", () => {
  // This runner's mock registration outlives mock.restore() across test
  // FILES, so the teardown re-registers the REAL module object instead:
  // whatever leaks past this file is freshen.ts itself, byte for byte.
  const FRESHEN_MODULE = "../../src/core/search/freshen.ts";
  let realFreshen: Record<string, unknown> | null = null;
  let forcedCalls: Array<{ vault: string; opts: Record<string, unknown> }> = [];

  afterEach(() => {
    if (realFreshen !== null) mock.module(FRESHEN_MODULE, () => realFreshen);
    mock.restore();
    realFreshen = null;
    forcedCalls = [];
  });

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

  test("an applied create claims one forced refresh: the seam sees force, and the receipt says claimed", async () => {
    // An index exists and is stale: the claim's stale gate passes and the
    // forced machinery is what the seam intercepts.
    await stampIndexStale();
    await mockFreshenSpawned();
    const restore = withIntervalEnv("60");
    try {
      const res = (await handler(ctx, {
        path: "Notes/Refreshed.md",
        frontmatter: { title: "R" },
        content: "a created note that claims its refresh",
      })) as Record<string, unknown>;

      expect(res["created"]).toBe(true);
      // The same claim marker vocabulary the lifecycle tool renders, on
      // the create receipt: a run is IN FLIGHT, never landed.
      expect(res["index_refresh"]).toBe("claimed");
      expect(res["index_refresh_reason"]).toBeNull();
      // The seam assertion: one forced call for THIS vault - force past
      // the freshness gate, because the create is due by definition.
      expect(forcedCalls).toHaveLength(1);
      expect(forcedCalls[0]!.vault).toBe(vault);
      expect(forcedCalls[0]!.opts["force"]).toBe(true);
    } finally {
      restore();
    }
  });

  test("config off does not claim: the receipt says not_claimed and names off", async () => {
    // An index exists (so the stale gate passes and the machinery is
    // what refuses), and no mock: with the interval at 0 the REAL
    // machinery answers before any spawn could be considered, so nothing
    // can leak out of this test either.
    await stampIndexStale();
    const restore = withIntervalEnv("0");
    try {
      const res = (await handler(ctx, {
        path: "Notes/Unrefreshed.md",
        content: "an operator who disabled freshening asked for exactly that",
      })) as Record<string, unknown>;

      expect(res["created"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("off");
    } finally {
      restore();
    }
  });

  test("the claim resolves through the server's own config file, not the environment alone", async () => {
    // The freshen-off decision arrives by CONFIG FILE here - the env
    // var the suite defaults to 0 is scrubbed, because the environment
    // wins over the config file and would answer `off` whether or not
    // the claim resolved the server's configPath. The claim reads the
    // config file only because it resolves the search config through
    // it, the file every other search-resolving call in the tool reads.
    // Resolved without it, the default interval stands and the create
    // claims a run the operator's config refused.
    await stampIndexStale();
    atomicWriteFileSync(
      join(configHome, "config.yaml"),
      `vault: ${vault}\nagent_name: claude\nsearch_freshen_interval_s: 0\n`,
    );
    const key = "OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S";
    const saved = process.env[key];
    delete process.env[key];
    try {
      const res = (await handler(ctx, {
        path: "Notes/ConfigOff.md",
        content: "the config file's off is the claim's off",
      })) as Record<string, unknown>;

      expect(res["created"]).toBe(true);
      expect(res["index_refresh"]).toBe("not_claimed");
      expect(res["index_refresh_reason"]).toBe("off");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a skipped create wrote nothing, so it carries no refresh marker at all", async () => {
    await handler(ctx, { path: "Notes/There.md", content: "first\n" });
    const res = (await handler(ctx, {
      path: "Notes/There.md",
      content: "second\n",
      if_exists: "skip",
    })) as Record<string, unknown>;

    expect(res["created"]).toBe(false);
    // Byte-identical-when-absent: a receipt for a write that did not
    // happen says nothing about a refresh it did not claim.
    expect("index_refresh" in res).toBe(false);
    expect("index_refresh_reason" in res).toBe(false);
  });
});

describe("brain_create_note", () => {
  test("is registered with a write-shaped name and schema", () => {
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("path");
  });

  test("creates a note file with frontmatter and content, returns its path", async () => {
    const res = await handler(ctx, {
      path: "Notes/FromAgent.md",
      frontmatter: { title: "From Agent", tags: ["x"] },
      content: "Captured by an agent.",
    });
    expect(res).toMatchObject({ created: true, path: "Notes/FromAgent.md" });
    const md = readFileSync(join(vault, "Notes/FromAgent.md"), "utf8");
    expect(md).toContain("title: From Agent");
    expect(md).toContain("Captured by an agent.");
  });

  test("path traversal is rejected with INVALID_PARAMS and writes nothing", async () => {
    await expect(handler(ctx, { path: "../escape.md", content: "x" })).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
  });

  test("writing into the Brain root is rejected with INVALID_PARAMS", async () => {
    await expect(handler(ctx, { path: "Brain/x.md", content: "x" })).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Brain/x.md"))).toBe(false);
  });

  test("a non-object frontmatter is rejected with INVALID_PARAMS", async () => {
    await expect(
      handler(ctx, { path: "Notes/Bad.md", frontmatter: "not-an-object", content: "x" }),
    ).rejects.toThrow(MCPError);
  });

  test("a prototype-mutating frontmatter key is rejected, never assigned", async () => {
    // JSON.parse creates an OWN "__proto__" key (the real JSON-RPC vector),
    // unlike an object literal where __proto__ sets the prototype.
    const frontmatter = JSON.parse('{"__proto__": ["polluted"]}');
    await expect(
      handler(ctx, { path: "Notes/Proto.md", frontmatter, content: "x" }),
    ).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Notes/Proto.md"))).toBe(false);
  });

  test("clobbering an existing note is rejected", async () => {
    await handler(ctx, { path: "Notes/Once.md", content: "first" });
    await expect(handler(ctx, { path: "Notes/Once.md", content: "second" })).rejects.toThrow(
      MCPError,
    );
    expect(readFileSync(join(vault, "Notes/Once.md"), "utf8")).toContain("first");
  });
});

/**
 * Authoring modes added by provenance-at-the-boundary, Unit C:
 * `if_exists`, `strict`, and template-mode bodies. The pre-existing
 * cases above stay untouched and green - a refusal is still the
 * default, and the three new arguments are inert when absent.
 */
describe("brain_create_note - authoring modes", () => {
  test("advertises the new arguments without changing the required set", () => {
    const props = tool.inputSchema.properties as Record<string, { type?: unknown }>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["if_exists", "strict", "template", "template_variables"]),
    );
    expect(tool.inputSchema.required).toEqual(["path"]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  test("with the new arguments absent, a note with no frontmatter is still written", async () => {
    const res = await handler(ctx, { path: "Notes/Absent.md", content: "body only" });
    expect(res).toMatchObject({ created: true, outcome: "created", path: "Notes/Absent.md" });
  });

  test('if_exists "skip" returns a skipped outcome a caller cannot read as a create', async () => {
    await handler(ctx, { path: "Notes/Idem.md", content: "first" });
    const res = await handler(ctx, {
      path: "Notes/Idem.md",
      content: "second",
      if_exists: "skip",
    });
    expect(res).toMatchObject({ created: false, outcome: "skipped", path: "Notes/Idem.md" });
    expect(readFileSync(join(vault, "Notes/Idem.md"), "utf8")).toContain("first");
  });

  test("an unknown if_exists value is rejected rather than defaulted", async () => {
    await expect(handler(ctx, { path: "Notes/Bad.md", if_exists: "overwrite" })).rejects.toThrow(
      MCPError,
    );
    expect(existsSync(join(vault, "Notes/Bad.md"))).toBe(false);
  });

  test("strict reports the validator's coded violations and writes nothing", async () => {
    try {
      await handler(ctx, { path: "Notes/Strict.md", content: "body only", strict: true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MCPError);
      const data = (err as MCPError).data as { violations?: ReadonlyArray<{ code: string }> };
      expect(data.violations?.map((v) => v.code)).toContain("frontmatter-missing");
    }
    expect(existsSync(join(vault, "Notes/Strict.md"))).toBe(false);
  });

  test("template mode renders variables, a section, an iteration, and keeps a typo intact", async () => {
    const res = await handler(ctx, {
      path: "Notes/Tpl.md",
      frontmatter: { title: "T" },
      template: "# {{title}}\n{{#draft}}(draft){{/draft}}\n{{#tags}}- {{.}}\n{{/tags}}{{ typo }}",
      template_variables: { title: "T", draft: true, tags: ["a", "b"] },
    });
    expect(res).toMatchObject({ created: true, outcome: "created" });
    const md = readFileSync(join(vault, "Notes/Tpl.md"), "utf8");
    expect(md).toContain("# T");
    expect(md).toContain("(draft)");
    expect(md).toContain("- a\n- b\n");
    expect(md).toContain("{{ typo }}");
  });

  test("a malformed template is an INVALID_PARAMS refusal, not a half-written note", async () => {
    await expect(handler(ctx, { path: "Notes/Broken.md", template: "{{#a}}x" })).rejects.toThrow(
      MCPError,
    );
    expect(existsSync(join(vault, "Notes/Broken.md"))).toBe(false);
  });

  test("template_variables values are held to the frontmatter value domain", async () => {
    await expect(
      handler(ctx, { path: "Notes/BadVars.md", template: "{{a}}", template_variables: { a: {} } }),
    ).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Notes/BadVars.md"))).toBe(false);
  });
});

describe("the write surface names the write binding it enforces", () => {
  // Every tool that traverses the shared create-note envelope spells out
  // its refusals; a caller reads that list as complete, so the binding
  // has to appear in it.
  const BINDING_TERM = "write binding";
  for (const t of [...NOTES_TOOLS, ...WRITE_BATCH_TOOLS]) {
    test(`${t.name} lists the binding among its refusals`, () => {
      expect(t.description.toLowerCase()).toContain(BINDING_TERM);
    });
  }
});

describe("a refused write can be traced back to a registered code", () => {
  const MALFORMED = "schema_version: 99\n";

  test("a binding refusal carries the advisory code and its exit", async () => {
    atomicWriteFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nwrite_binding:\n  path_prefixes:\n    - Projects\n",
    );
    let caught: MCPError | null = null;
    try {
      await handler(ctx, { path: "Elsewhere/N.md", content: "x" });
    } catch (err) {
      caught = err as MCPError;
    }
    expect(caught).toBeInstanceOf(MCPError);
    const data = caught!.data as Record<string, unknown>;
    expect(data["code"]).toBe("write_binding");
    expect(data["diagnostic_code"]).toBe(WRITE_BINDING_REFUSED_CODE);
    expect(data["next_command"]).toBe(resolveNextStep(WRITE_BINDING_REFUSED_CODE)!.nextCommand);
  });

  test("a malformed config is a typed refusal with a vault-relative source", async () => {
    atomicWriteFileSync(join(vault, "Brain", "_brain.yaml"), MALFORMED);
    let caught: MCPError | null = null;
    try {
      await handler(ctx, { path: "Notes/N.md", content: "x" });
    } catch (err) {
      caught = err as MCPError;
    }
    expect(caught).toBeInstanceOf(MCPError);
    expect(caught!.message).toContain("Brain/_brain.yaml");
    expect(caught!.message).not.toContain(vault);
    const data = caught!.data as Record<string, unknown>;
    expect(data["code"]).toBe("config_invalid");
    expect(data["next_command"]).toBe(resolveNextStep("config-invalid")!.nextCommand);
  });
});

describe("a frontmatter key must be a key the parser can read back", () => {
  test("a newline-bearing key is refused before anything is written", async () => {
    await expect(
      handler(ctx, { path: "Notes/Inject.md", frontmatter: { "a\nowner: mallory": "v" } }),
    ).rejects.toThrow(MCPError);
    expect(existsSync(join(vault, "Notes/Inject.md"))).toBe(false);
  });
});

/**
 * Write-time page lint (evidence-at-the-boundary, task A4). The lint runs
 * AFTER the commit, reads what is on disk, and never gates the write. The
 * key is ABSENT ENTIRELY when there is nothing to say, which is what lets
 * a caller read its absence as "clean" and only that.
 */
describe("brain_create_note - the lint attached to the receipt", () => {
  /** The handler's declared return is `unknown`; every case here reads keys. */
  const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await handler(ctx, args)) as Record<string, unknown>;

  test("a clean write carries the flags, the path and the write id", async () => {
    const res = await call({
      path: "Notes/Clean.md",
      frontmatter: { title: "Clean" },
      content: "plain prose, no links",
    });
    // A landed create carries the refresh-claim marker beside the audit
    // half (freshening is off suite-wide, so it reads not_claimed with
    // its reason).
    expect(Object.keys(res)).toEqual([
      "created",
      "outcome",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
    expect(res).toMatchObject({ created: true, outcome: "created", path: "Notes/Clean.md" });
    // `write_id` joined the receipt with the note-write record
    // (who-wrote-what, Task A); its value is derived from the instant of
    // the write, so the shape is what can be pinned.
    expect(res["write_id"]).toMatch(NOTE_WRITE_ID_RE);
    expect("audit_reason" in res).toBe(false);
    expect(PAGE_LINT_KEY in res).toBe(false);
  });

  test("a broken Brain wikilink rides back as one warning with a next command", async () => {
    const res = await call({
      path: "Notes/Broken.md",
      frontmatter: { title: "Broken" },
      content: "see [[pref-ghost]]",
    });
    expect(res).toMatchObject({ created: true, path: "Notes/Broken.md" });
    const lint = res[PAGE_LINT_KEY] as Record<string, unknown>;
    expect(lint).toMatchObject({ total: 1, returned: 1, truncated: false, skipped: [] });
    expect((lint["findings"] as ReadonlyArray<Record<string, unknown>>)[0]).toMatchObject({
      severity: "warning",
      code: "broken-wikilink",
      page: "Notes/Broken.md",
      next_command: resolveNextStep("broken-wikilink")!.nextCommand,
    });
  });

  test("an invalid document is reported, not refused: the note is on disk", async () => {
    const res = await call({ path: "Notes/NoFm.md", content: "body only" });
    expect(res).toMatchObject({ created: true, outcome: "created" });
    expect(existsSync(join(vault, "Notes/NoFm.md"))).toBe(true);
    const lint = res[PAGE_LINT_KEY] as { findings: ReadonlyArray<Record<string, unknown>> };
    expect(lint.findings[0]).toMatchObject({ severity: "error", code: "frontmatter-missing" });
  });

  test("a skipped create wrote no bytes, so it lints nothing", async () => {
    await handler(ctx, { path: "Notes/Idem2.md", content: "first" });
    const res = await call({
      path: "Notes/Idem2.md",
      content: "second",
      if_exists: "skip",
    });
    expect(res).toMatchObject({ created: false, outcome: "skipped" });
    expect(PAGE_LINT_KEY in res).toBe(false);
  });
});

/**
 * Undated-quantity lint at the receipt boundary (write-honesty, F4,
 * t_fb442a24). The write SUCCEEDS - the finding is advisory - and the
 * receipt carries the new code. The same write on a page that declares
 * `valid_from` is byte-identical to the clean receipt: no lint key at all.
 */
describe("brain_create_note - the undated-quantity lint", () => {
  const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await handler(ctx, args)) as Record<string, unknown>;

  test("an undated numeric write succeeds and carries the finding", async () => {
    const res = await call({
      path: "Notes/UndatedNumeric.md",
      frontmatter: { title: "Undated" },
      content: "We onboarded 5,000 users.",
    });
    expect(res).toMatchObject({ created: true, outcome: "created" });
    expect(existsSync(join(vault, "Notes/UndatedNumeric.md"))).toBe(true);
    const lint = res[PAGE_LINT_KEY] as { findings: ReadonlyArray<Record<string, unknown>> };
    expect(lint.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: UNDATED_QUANTITY_CODE,
        page: "Notes/UndatedNumeric.md",
        path: "body",
      }),
    ]);
    expect(typeof lint.findings[0]!["next_command"]).toBe("string");
  });

  test("the same write with valid_from keeps the byte-identical clean receipt", async () => {
    const res = await call({
      path: "Notes/DatedNumeric.md",
      frontmatter: { title: "Dated", valid_from: "2026-10-01" },
      content: "We onboarded 5,000 users.",
    });
    expect(res).toMatchObject({ created: true, outcome: "created" });
    expect(PAGE_LINT_KEY in res).toBe(false);
    expect(Object.keys(res)).toEqual([
      "created",
      "outcome",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
  });
});

function enableWidening(): void {
  appendFileSync(ctx.configPath!, "near_duplicate_write_widening_enabled: true\n");
}

/**
 * Opt-in widening of the near-duplicate hint beyond the written page's
 * directory, through the keyword index. With the key off the receipt is
 * exactly what shipped; with it on, a create in another folder reports the
 * earlier page and names the method.
 */
describe("brain_create_note - widened near-duplicate hint", () => {
  const BODY = "orchard lantern copper meadow violet harbor";

  async function seedIndexedEarlierPage(): Promise<void> {
    await handler(ctx, { path: "Projects/Earlier.md", frontmatter: { title: "E" }, content: BODY });
    await indexVault(resolveSearchConfig({ vault, configPath: ctx.configPath! }), { force: true });
  }

  test("with the key on, a create in another folder reports the earlier page", async () => {
    enableWidening();
    await seedIndexedEarlierPage();
    const res = (await handler(ctx, {
      path: "Notes/Later.md",
      frontmatter: { title: "L" },
      content: BODY,
    })) as Record<string, unknown>;
    const lint = res[PAGE_LINT_KEY] as {
      findings: ReadonlyArray<Record<string, unknown>>;
      widening: string;
    };
    expect(lint.widening).toBe("used");
    expect(lint.findings).toEqual([
      expect.objectContaining({
        code: "near-duplicate",
        page: "Notes/Later.md",
        path: "Projects/Earlier.md",
        message: expect.stringContaining("method=lexical"),
      }),
    ]);
  });

  test("with the key off, the receipt is unchanged", async () => {
    await seedIndexedEarlierPage();
    const res = (await handler(ctx, {
      path: "Notes/Later.md",
      frontmatter: { title: "L" },
      content: BODY,
    })) as Record<string, unknown>;
    // "Unchanged" now includes the refresh-claim marker a landed create
    // carries (the lint widening is what this test keeps unchanged).
    expect(Object.keys(res)).toEqual([
      "created",
      "outcome",
      "path",
      "write_id",
      "index_refresh",
      "index_refresh_reason",
    ]);
  });

  test("with the key on and no index, the receipt says widening did not run", async () => {
    enableWidening();
    const res = (await handler(ctx, {
      path: "Notes/Later.md",
      frontmatter: { title: "L" },
      content: BODY,
    })) as Record<string, unknown>;
    expect(res[PAGE_LINT_KEY]).toMatchObject({
      total: 0,
      widening: "index_unavailable",
      widening_detail: "INDEX_MISSING",
    });
  });
});

async function createdStages(): Promise<ReadonlyArray<{ name: unknown; ms: unknown }>> {
  const server = new MCPServer({ vault, configPath: ctx.configPath! });
  await server.callTool("brain_create_note", {
    path: "Notes/AA-stage-probe.md",
    content: "orchard lantern copper meadow violet harbor",
  });
  const [record] = listMcpRouteLatency(vault, { tool: "brain_create_note" });
  const stages = record!.payload["stages"];
  expect(Array.isArray(stages)).toBe(true);
  return stages as ReadonlyArray<{ name: unknown; ms: unknown }>;
}

function expectTimed(stages: ReadonlyArray<{ name: unknown; ms: unknown }>, name: string): void {
  const stage = stages.find((s) => s.name === name);
  expect(stage).toBeDefined();
  expect(isRouteStageName(stage!.name)).toBe(true);
  expect(Number.isFinite(stage!.ms)).toBe(true);
  expect(stage!.ms as number).toBeGreaterThanOrEqual(0);
}

/**
 * With route metrics on, a create's continuity record names the time the
 * receipt lint and the near-duplicate lookup took. Only presence and a
 * finite non-negative value are asserted: never an order, never a size.
 */
describe("brain_create_note - receipt lint stage timings", () => {
  const CONFIG_ENV = "OPEN_SECOND_BRAIN_CONFIG";
  let savedConfigEnv: string | undefined;

  beforeEach(() => {
    savedConfigEnv = process.env[CONFIG_ENV];
    process.env[CONFIG_ENV] = ctx.configPath!;
    appendFileSync(ctx.configPath!, 'mcp_route_metrics_enabled: "true"\n');
  });

  afterEach(() => {
    if (savedConfigEnv === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = savedConfigEnv;
  });

  test("the record carries lint and near_duplicate_lookup", async () => {
    const stages = await createdStages();
    expectTimed(stages, "lint");
    expectTimed(stages, "near_duplicate_lookup");
  });

  test("with widening on, the lookup is still one named stage", async () => {
    enableWidening();
    const stages = await createdStages();
    expectTimed(stages, "near_duplicate_lookup");
    expect(stages.filter((s) => s.name === "near_duplicate_lookup")).toHaveLength(1);
  });
});
