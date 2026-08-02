/**
 * MCP integration test for `brain_create_note` (Brain Portability &
 * Interop suite, Unit D). The tool writes an actual vault note file
 * (path + frontmatter + content) - distinct from `brain_note`, which
 * only appends a log line. Handler exercised directly with a minimal
 * context. Refusals map to INVALID_PARAMS and write nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import { WRITE_BATCH_TOOLS } from "../../src/mcp/brain/write-batch-tools.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { WRITE_BINDING_REFUSED_CODE } from "../../src/core/write-binding/index.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

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
