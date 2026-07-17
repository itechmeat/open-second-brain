/**
 * Owner-scoped canonical facts (Knowledge Provenance suite). A preference may
 * declare an owner; owner-scoped recall keeps each owner's facts separate
 * while shared (ownerless) facts stay visible. The rule reuses the v1.6
 * owner-visibility model. Default (no scope / flag off) is byte-identical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { writePreference, parsePreference } from "../../../src/core/brain/preference.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import {
  isPreferenceVisible,
  preferenceOwner,
} from "../../../src/core/brain/owner-scoped-facts.ts";
import { QUERY_TOOLS } from "../../../src/mcp/brain/query-tools.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-owner-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-owner-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeOwnedPref(slug: string, topic: string, owner?: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle: `principle for ${topic}`,
    created_at: "2026-06-13T12:00:00Z",
    unconfirmed_until: "2026-07-13T12:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    ...(owner !== undefined ? { owner } : {}),
  });
}

function enableOwnerScoping(): void {
  writeFileSync(
    brainConfigPath(vault),
    "schema_version: 1\nguardrails:\n  owner_scoped_facts: true\n",
  );
}

const queryHandler = QUERY_TOOLS.find((t) => t.name === "brain_query")!.handler;

describe("owner-visibility filter (pure)", () => {
  test("preferenceOwner normalizes and treats blank as null", () => {
    expect(preferenceOwner({ owner: "  Agent-A " })).toBe("agent-a");
    expect(preferenceOwner({ owner: "" })).toBeNull();
    expect(preferenceOwner({})).toBeNull();
  });

  test("no requested scope: everything visible (byte-identical default)", () => {
    expect(isPreferenceVisible({ owner: "agent-a" }, null)).toBe(true);
    expect(isPreferenceVisible({}, null)).toBe(true);
  });

  test("with a scope: ownerless shared, owned only to its owner", () => {
    expect(isPreferenceVisible({}, "agent-a")).toBe(true);
    expect(isPreferenceVisible({ owner: "agent-a" }, "agent-a")).toBe(true);
    expect(isPreferenceVisible({ owner: "agent-b" }, "agent-a")).toBe(false);
  });
});

describe("owner round-trips through write/parse", () => {
  test("the owner token persists in frontmatter", () => {
    writeOwnedPref("owned", "owned-topic", "Agent-A");
    const parsed = parsePreference(preferencePath(vault, "owned"));
    expect(parsed.owner).toBe("Agent-A");
    expect(preferenceOwner(parsed)).toBe("agent-a");
  });
});

describe("brain_query owner-scoped recall", () => {
  test("flag off: an owned fact is returned regardless of scope (byte-identical)", async () => {
    writeOwnedPref("owned", "owned-topic", "agent-b");
    const res = await queryHandler(ctx, { preference: "pref-owned", agent_scope: "agent-a" });
    expect(res).toMatchObject({ mode: "preference" });
  });

  test("flag on: an owned fact is hidden from a non-owner scope", async () => {
    writeOwnedPref("owned", "owned-topic", "agent-b");
    enableOwnerScoping();
    await expect(
      queryHandler(ctx, { preference: "pref-owned", agent_scope: "agent-a" }),
    ).rejects.toThrow();
  });

  test("flag on: the owner sees its own fact; shared facts always visible", async () => {
    writeOwnedPref("owned", "owned-topic", "agent-b");
    writeOwnedPref("shared", "shared-topic");
    enableOwnerScoping();
    const own = await queryHandler(ctx, { preference: "pref-owned", agent_scope: "agent-b" });
    expect(own).toMatchObject({ mode: "preference" });
    const shared = await queryHandler(ctx, { preference: "pref-shared", agent_scope: "agent-b" });
    expect(shared).toMatchObject({ mode: "preference" });
  });
});
