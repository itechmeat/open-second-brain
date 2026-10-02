/**
 * `readableAtContextReach` binds the visibility rule and the gated
 * ownership rule to one request. It answers for vault files the caller
 * names as a source, so a page withheld at the caller's reach must read
 * as unreadable here exactly as it does on every read surface.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { readableAtContextReach } from "../../src/mcp/brain/reach-readable.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";
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

/** A public page in a fresh directory beside the vault, and its path from the vault. */
function outside(): { dir: string; rel: string } {
  const dir = mkTemp("o2b-reach-readable-outside-");
  const rel = join("..", basename(dir), "sibling.md");
  writeFileSync(join(dir, "sibling.md"), "---\ntitle: sibling\n---\nbody\n");
  return { dir, rel };
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

  describe("a path that leaves the vault", () => {
    test("a public page beside the vault is not readable at remote reach", () => {
      const { rel } = outside();
      expect(readableAtContextReach(ctx(TRANSPORT_REACH.remote))(rel)).toBe(false);
    });

    test("an absolute path outside the vault is not readable at remote reach", () => {
      const { dir } = outside();
      expect(readableAtContextReach(ctx(TRANSPORT_REACH.remote))(join(dir, "sibling.md"))).toBe(
        false,
      );
    });

    test.skipIf(IS_WINDOWS)("a FIFO outside the vault is answered without reading it", () => {
      const dir = mkTemp("o2b-reach-readable-fifo-");
      const made = spawnSync("mkfifo", [join(dir, "pipe.md")]);
      expect(made.status).toBe(0);
      const rel = join("..", basename(dir), "pipe.md");
      // Before the containment check this read blocked the process for good.
      expect(readableAtContextReach(ctx(TRANSPORT_REACH.remote))(rel)).toBe(false);
    });
  });
});
