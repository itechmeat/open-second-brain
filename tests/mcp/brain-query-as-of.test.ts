/**
 * `brain_query` point-in-time recall + honest time-filter descriptions
 * (what-the-index-already-knew, task J).
 *
 * `queryByTopic` has accepted a `now` option since C5 and the MCP handler
 * passed `{ showExpired }` and dropped it, so an agent could ask to SEE
 * lapsed memories but never to ask what the brain held at an instant.
 *
 * The second half of this file is about a description, which is the only
 * thing an agent reads before choosing a tool argument: since v1.43.0
 * `since` / `until` filter on EVENT time (declared validity window, then
 * body-declared anchor, with storage mtime as the last rung), while their
 * schema descriptions still said "documents modified".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal, type WriteSignalInput } from "../../src/core/brain/signal.ts";
import { PROPERTY_DESCRIPTION_MAX } from "../../src/mcp/registry-guard.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

const TOPIC = "deploy";
const LAPSED_EXPIRY = "2026-07-15";
const BEFORE_EXPIRY = "2026-06-01T00:00:00Z";
const AFTER_EXPIRY = "2026-08-01T00:00:00Z";
const LAPSED_PRINCIPLE = "Principle for lapsed";
const EVERGREEN_PRINCIPLE = "Principle for evergreen";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-query-as-of-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool(name: string): ToolDefinition {
  return findTool(buildToolTable("full"), name);
}

function signal(slug: string, overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: TOPIC,
    signal: "positive",
    agent: "tester",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
    ...overrides,
  };
}

function seed(): void {
  writeSignal(vault, signal("lapsed", { expiration_date: LAPSED_EXPIRY }));
  writeSignal(
    vault,
    signal("evergreen", { created_at: "2026-05-02T00:00:00Z", date: "2026-05-02" }),
  );
}

async function topicQuery(args: Record<string, unknown>): Promise<string[]> {
  const res = (await tool("brain_query").handler(ctx(), { topic: TOPIC, ...args })) as {
    signals: ReadonlyArray<{ principle: string }>;
  };
  return res.signals.map((s) => s.principle).toSorted();
}

describe("brain_query at", () => {
  test("recalls the memories live at the supplied instant", async () => {
    seed();
    expect(await topicQuery({ at: BEFORE_EXPIRY })).toEqual([
      EVERGREEN_PRINCIPLE,
      LAPSED_PRINCIPLE,
    ]);
  });

  test("an instant after the expiry drops the lapsed memory", async () => {
    seed();
    expect(await topicQuery({ at: AFTER_EXPIRY })).toEqual([EVERGREEN_PRINCIPLE]);
  });

  test("a date-only instant is accepted", async () => {
    seed();
    expect(await topicQuery({ at: "2026-06-01" })).toEqual([EVERGREEN_PRINCIPLE, LAPSED_PRINCIPLE]);
  });

  test("an unparseable instant is refused, never coerced to now", async () => {
    seed();
    await expect(topicQuery({ at: "last month" })).rejects.toThrow(
      /ISO-8601 instant or YYYY-MM-DD date/,
    );
  });

  test("'at' outside topic mode is refused rather than silently ignored", async () => {
    seed();
    await expect(
      tool("brain_query").handler(ctx(), { since: BEFORE_EXPIRY, at: BEFORE_EXPIRY }),
    ).rejects.toThrow(/topic/);
  });

  test("'show_expired' outside topic mode is refused on the same terms as 'at'", async () => {
    // Both arguments steer the one expiration filter, and that filter runs
    // in topic mode alone. Its schema already said so while the handler
    // read it in topic mode and ignored it elsewhere, so a caller asking
    // to see lapsed memories beside `since` got silence where it had been
    // promised the opposite. One scope, one refusal.
    seed();
    await expect(
      tool("brain_query").handler(ctx(), { since: BEFORE_EXPIRY, show_expired: true }),
    ).rejects.toThrow(/show_expired.*topic/);
    // Topic mode still accepts it.
    const ok = (await tool("brain_query").handler(ctx(), {
      topic: TOPIC,
      show_expired: true,
    })) as Record<string, unknown>;
    expect(ok["mode"]).toBe("topic");
  });

  test("absent 'at' leaves the default result untouched", async () => {
    seed();
    // The wall clock is past LAPSED_EXPIRY, so the default drops it.
    expect(await topicQuery({})).toEqual([EVERGREEN_PRINCIPLE]);
  });

  test("the input schema declares 'at' (additionalProperties is false)", () => {
    const schema = tool("brain_query").inputSchema as {
      properties: Record<string, { description?: string }>;
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toContain("at");
  });
});

describe("brain_search time-filter descriptions name event time", () => {
  function timeFilterDescription(key: "since" | "until"): string {
    const schema = tool("brain_search").inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    return schema.properties[key]?.description ?? "";
  }

  test("neither filter claims to select on modification time any more", () => {
    for (const key of ["since", "until"] as const) {
      const description = timeFilterDescription(key);
      expect(`${key}: ${description.includes("modified")}`).toBe(`${key}: false`);
    }
  });

  test("both name the axis they actually filter on", () => {
    for (const key of ["since", "until"] as const) {
      const description = timeFilterDescription(key);
      expect(`${key}: ${description.includes("event time")}`).toBe(`${key}: true`);
    }
  });

  test("both stay inside the registry-guard property cap", () => {
    for (const key of ["since", "until"] as const) {
      const length = timeFilterDescription(key).length;
      expect(`${key} within cap: ${length <= PROPERTY_DESCRIPTION_MAX} (${length})`).toBe(
        `${key} within cap: true (${length})`,
      );
    }
  });
});
