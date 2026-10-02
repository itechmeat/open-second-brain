/**
 * `readableAtContextReach` binds the visibility rule and the gated
 * ownership rule to one request. It answers for vault files the caller
 * names as a source, so a page withheld at the caller's reach must read
 * as unreadable here exactly as it does on every read surface.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { readableAtContextReach } from "../../src/mcp/brain/reach-readable.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { pinHome, tempDirs } from "../helpers/temp-dir.ts";

const mkTemp = tempDirs();
pinHome("o2b-reach-readable-home-");

let vault: string;

beforeEach(() => {
  vault = mkTemp("o2b-reach-readable-vault-");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Notes", "open.md"), "---\ntitle: open\n---\nbody\n");
  writeFileSync(join(vault, "Notes", "secret.md"), "---\nvisibility: private\n---\nbody\n");
  writeFileSync(join(vault, "Notes", "theirs.md"), "---\nowner: other-agent\n---\nbody\n");
});

function ctx(reach: ServerContext["reach"], agentName = "me-agent"): ServerContext {
  return { vault, configPath: null, repoRoot: null, agentName, ...(reach ? { reach } : {}) };
}

function setOwnerGate(mode: string): void {
  writeFileSync(
    brainConfigPath(vault),
    `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${mode}\n`,
  );
}

describe("readableAtContextReach", () => {
  test("a private page is unreadable at remote reach and readable at local reach", () => {
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.remote))("Notes/secret.md")).toBe(false);
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.local))("Notes/secret.md")).toBe(true);
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.remote))("Notes/open.md")).toBe(true);
  });

  test("a context with no minted reach answers as remote", () => {
    expect(readableAtContextReach(ctx(undefined))("Notes/secret.md")).toBe(false);
  });

  test("another owner's page is unreadable only when the ownership gate fails closed", () => {
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.local))("Notes/theirs.md")).toBe(true);
    setOwnerGate("warn");
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.local))("Notes/theirs.md")).toBe(true);
    setOwnerGate("fail");
    expect(readableAtContextReach(ctx(TRANSPORT_REACH.local))("Notes/theirs.md")).toBe(false);
    expect(
      readableAtContextReach(ctx(TRANSPORT_REACH.local, "other-agent"))("Notes/theirs.md"),
    ).toBe(true);
  });
});
