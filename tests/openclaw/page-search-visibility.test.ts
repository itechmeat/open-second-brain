/**
 * The OpenClaw page walker is inside the boundary
 * (private-is-not-a-suggestion, unit 4).
 *
 * `tests/core/architecture/visibility-surface-census.test.ts` named this
 * surface as an un-swept page search, and it was: `second_brain_query`
 * listed pages filtered by entity status alone. It is a tool a model
 * calls, not a command an operator types, so it adopts the narrowest
 * reach - see `OPENCLAW_TRANSPORT_REACH`.
 *
 * The aggregate is asserted alongside the listing, because a count that
 * still included the withheld page would be an existence oracle: it would
 * answer "there is one more page here than I am showing you".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";

/** The plugin SDK is an external at build time and absent at test time. */
mock.module("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

interface RegisteredTool {
  readonly name: string;
  execute(id: string, params: Record<string, unknown>): Promise<unknown>;
}

interface PageSearchResult {
  readonly total_pages: number;
  readonly returned: number;
  readonly pages: ReadonlyArray<{ readonly title: string; readonly path: string }>;
}

/** The listing tool's registered name, as the census knows it. */
const PAGE_SEARCH_TOOL = "second_brain_query";

/** A marker present only in the reserved page, in every field it has. */
const RESERVED_MARKER = "zzreservedmarkerzz";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "openclaw-vis-"));
  writeFileSync(join(vault, "open.md"), "---\ntitle: Open page\n---\n\nordinary body");
  writeFileSync(
    join(vault, `${RESERVED_MARKER}.md`),
    `---\ntitle: ${RESERVED_MARKER}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n${RESERVED_MARKER} body`,
  );
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

async function pageSearch(params: Record<string, unknown>): Promise<PageSearchResult> {
  const tools: RegisteredTool[] = [];
  const entry = (await import("../../src/openclaw/index.ts")).default as {
    register(api: unknown): void;
  };
  entry.register({
    pluginConfig: { vault },
    on: () => undefined,
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  });
  const tool = tools.find((t) => t.name === PAGE_SEARCH_TOOL);
  if (tool === undefined) throw new Error(`${PAGE_SEARCH_TOOL} was not registered`);
  const out = (await tool.execute("1", params)) as {
    content: ReadonlyArray<{ readonly text: string }>;
  };
  const text = out.content[0]?.text;
  if (text === undefined) throw new Error(`${PAGE_SEARCH_TOOL} returned no text content`);
  return JSON.parse(text) as PageSearchResult;
}

describe(PAGE_SEARCH_TOOL, () => {
  test("does not list a page carrying the reserved token", async () => {
    const result = await pageSearch({});
    expect(result.pages.map((p) => p.title)).toEqual(["Open page"]);
    expect(JSON.stringify(result)).not.toContain(RESERVED_MARKER);
  });

  test("does not count it either, so the aggregate is not an existence oracle", async () => {
    const result = await pageSearch({});
    expect(result.total_pages).toBe(1);
    expect(result.returned).toBe(1);
  });

  test("a title pattern naming it matches nothing", async () => {
    const result = await pageSearch({ pattern: RESERVED_MARKER });
    expect(result.pages).toEqual([]);
    expect(result.returned).toBe(0);
  });
});
