/**
 * What `brain_scaffold_stub` says at the MCP boundary.
 *
 * Three defects, two of them about the boundary rather than the
 * scaffolding.
 *
 * A. the `detail` it returns named the absolute host path of the search
 *    index - `no search index at ${config.dbPath}`, and the raw sqlite
 *    message, which embeds the database file it failed on. MCP responses
 *    land in model context, which is exactly why `vaultStoreReference`
 *    renders `vault://<hex>` unless `expose_host_paths` is set, so any
 *    agent calling this on an unindexed vault learned the operator's home
 *    directory. The sibling at `admin-tools.ts:137` says the same thing
 *    and names no path.
 *
 * D. it read `limit` under `action: "list"` and never looked at
 *    `target` / `path` / `sources` / `if_exists` / `apply`, so
 *    `{"action":"list","target":"Foo","apply":true}` came back as a
 *    normal `state: "measured"` envelope. An agent holding a stale
 *    `action` reads that as a write that happened. `argument-guard.ts`
 *    calls a silently ignored argument "the worst kind of fallback", and
 *    the sibling tool in the same file refuses `to` on an archive rather
 *    than dropping it.
 *
 * E. `docs/mcp.md:102` said the stub's body "links back to the documents
 *    that referenced it, so nothing in it is invented", and the write
 *    path never consulted the index: it wrote whatever strings the
 *    caller put in `sources`, unvalidated and outside the path envelope
 *    `target` and `path` both go through. So a caller could hand it
 *    three invented paths and get a note citing three documents that do
 *    not exist, from the one surface whose selling point is that it
 *    cites rather than composes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { LIFECYCLE_FILE_TOOLS } from "../../src/mcp/brain/lifecycle-file-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-stub-boundary-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-stub-boundary-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const tool = LIFECYCLE_FILE_TOOLS.find((t) => t.name === "brain_scaffold_stub")!;

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool.handler(ctx, args)) as Record<string, unknown>;
}

describe("host paths in the response (A)", () => {
  test("a missing index is reported without naming the index file", async () => {
    const res = await call({ action: "list" });

    expect(res["state"]).toBe("index_missing");
    const detail = String(res["detail"]);
    expect(detail.length).toBeGreaterThan(0);
    // The vault is a mkdtemp path, so any leak of it - or of the store
    // beneath it - shows up as a substring.
    expect(detail).not.toContain(vault);
    expect(detail).not.toContain(tmpdir());
    // The remedy still travels, on its own field.
    expect(String(res["next_command"]).length).toBeGreaterThan(0);
  });

  test("the whole envelope carries no absolute host path", async () => {
    const res = await call({ action: "list" });
    expect(JSON.stringify(res)).not.toContain(vault);
  });
});

describe("the sources a stub cites (E)", () => {
  test("a source that is not an existing note is refused, not written", async () => {
    const attempt = call({
      action: "write",
      target: "Projects/Missing",
      sources: ["Notes/DoesNotExist.md"],
      apply: true,
    });
    await expect(attempt).rejects.toMatchObject({ data: { code: "unknown_source" } });
  });

  test("a source that escapes the vault is refused", async () => {
    const attempt = call({
      action: "write",
      target: "Projects/Missing",
      sources: ["../../etc/passwd"],
      apply: true,
    });
    await expect(attempt).rejects.toMatchObject({ data: { code: "unknown_source" } });
  });

  test("an existing note is cited, and the body links back to it", async () => {
    writeFileSync(join(vault, "Ref.md"), "see [[Projects/Missing]]\n");
    const res = await call({
      action: "write",
      target: "Projects/Missing",
      sources: ["Ref.md"],
      apply: true,
    });
    expect(res["applied"]).toBe(true);
    expect(readFileSync(join(vault, "Projects/Missing.md"), "utf8")).toContain("[[Ref]]");
  });
});

describe("arguments that belong to the other action (D)", () => {
  test("list refuses write's arguments instead of ignoring them", async () => {
    const attempt = call({ action: "list", target: "Foo", apply: true });
    await expect(attempt).rejects.toThrow(MCPError);
    await expect(attempt).rejects.toMatchObject({
      data: { code: "argument_forbidden", action: "list" },
    });
  });

  test("the refusal names every offending argument, sorted", async () => {
    let seen: unknown = null;
    try {
      await call({ action: "list", target: "Foo", path: "Foo.md", apply: true, limit: 5 });
    } catch (err) {
      seen = (err as MCPError).data;
    }
    expect(seen).toMatchObject({ forbidden: ["apply", "path", "target"] });
  });

  test("write refuses list's argument", async () => {
    const attempt = call({ action: "write", target: "Foo", limit: 5 });
    await expect(attempt).rejects.toMatchObject({
      data: { code: "argument_forbidden", action: "write", forbidden: ["limit"] },
    });
  });

  test("each action still accepts its own arguments", async () => {
    const listed = await call({ action: "list", limit: 3 });
    expect(listed["action"]).toBe("list");

    const planned = await call({ action: "write", target: "Projects/Missing", sources: [] });
    expect(planned["applied"]).toBe(false);
    expect(planned["path"]).toBe("Projects/Missing.md");
  });

  test("an explicit null is not an argument, so it is not refused", async () => {
    // A client that spells "absent" as `null` is sending the same
    // request as one that omits the key; refusing it would make the two
    // spellings mean different things.
    const res = await call({ action: "list", target: null, apply: null });
    expect(res["action"]).toBe("list");
  });
});

/**
 * The `limit` capped the scan BEFORE the ownership filter ran, so a
 * scoped caller silently received fewer rows than it asked for and than
 * the vault holds - and the shortfall is proportional to how much the
 * other owner wrote, which is a row count read as an existence signal.
 */
describe("limit is applied after the ownership filter", () => {
  test("a scoped caller gets the limit it asked for, not the limit minus what was hidden", async () => {
    const { indexVault, resolveSearchConfig } = await import("../../src/core/search/index.ts");
    const configPath = ctx.configPath!;

    // Three dangling targets from an owner-A note, sorting FIRST, plus
    // three from a shared note. With the limit applied before the filter
    // a scoped caller sees zero of the three it is entitled to.
    writeFileSync(
      join(vault, "aaa-owned.md"),
      "---\nowner: agent-a\n---\n\n[[aaa-1]] [[aaa-2]] [[aaa-3]]\n",
    );
    writeFileSync(join(vault, "zzz-shared.md"), "[[zzz-1]] [[zzz-2]] [[zzz-3]]\n");
    atomicWriteFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: fail\n",
    );
    await indexVault(resolveSearchConfig({ vault, configPath }), { force: true });

    const scoped = (await tool.handler(
      { ...ctx, agentName: "agent-b" },
      {
        action: "list",
        limit: 3,
      },
    )) as { state: string; targets: Array<{ target: string }> };

    expect(scoped.state).toBe("measured");
    expect(scoped.targets.map((t) => t.target).toSorted()).toEqual(["zzz-1", "zzz-2", "zzz-3"]);
  });
});
