/**
 * `brain_hygiene` `refresh` answers at the caller's reach.
 *
 * Vault A holds a derived page withheld from a remote caller by visibility
 * whose every recorded source is gone (an orphan the recompile plan would
 * archive) beside a readable one; vault B holds only the readable one. A
 * server with no reach minted is a remote caller: the plan, the dry run
 * and the applied refresh must read alike over both vaults, and the
 * withheld page must stay where it is, byte for byte. The local control
 * proves the withheld page is there to plan.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_hygiene";
const READABLE_DERIVED = "Notes/derived-readable.md";
const PRIVATE_DERIVED = "Notes/derived-withheld.md";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function derivedPage(source: string, reserved: boolean): string {
  return [
    "---",
    "title: Derived",
    `source_paths: [${source}]`,
    "source_hashes: [sha256:0000]",
    ...(reserved ? [`visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`] : []),
    "---",
    "",
    "Derived body.",
    "",
  ].join("\n");
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-hygiene-refresh-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  mkdirSync(join(f.vault, "Notes"), { recursive: true });
  writeFileSync(join(f.vault, READABLE_DERIVED), derivedPage("Notes/gone-readable.md", false));
  if (withPrivate) {
    writeFileSync(join(f.vault, PRIVATE_DERIVED), derivedPage("Notes/gone-withheld.md", true));
  }
  return f;
}

async function answer(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool(TOOL, args);
    // Paths are compared with forward slashes on every platform.
    return maskVolatile(f, result["structuredContent"] ?? result).replaceAll("\\\\", "/");
  } catch (error) {
    return maskVolatile(f, { error: (error as Error).message });
  }
}

describe("brain_hygiene refresh answers at the caller's reach", () => {
  test("remote reach: the dry-run plan reads as in a vault without the withheld page", async () => {
    const args = { mode: "refresh", dry_run: true };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain(READABLE_DERIVED);
  });

  test("remote reach: an applied refresh leaves the withheld page in place", async () => {
    const a = fixture(true);
    const before = readFileSync(join(a.vault, PRIVATE_DERIVED), "utf8");
    const args = { mode: "refresh" };
    const withheld = await answer(a, args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(existsSync(join(a.vault, READABLE_DERIVED))).toBe(false);
    expect(readFileSync(join(a.vault, PRIVATE_DERIVED), "utf8")).toBe(before);
  });

  test("local reach: the plan includes the withheld page", async () => {
    const local = await answer(
      fixture(true),
      { mode: "refresh", dry_run: true },
      TRANSPORT_REACH.local,
    );
    expect(local).toContain(PRIVATE_DERIVED);
  });
});
