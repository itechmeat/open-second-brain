/**
 * `brain_dead_ends` answers at the caller's reach.
 *
 * Vault A holds a dead end withheld from a remote caller by visibility
 * beside a readable one; vault B holds only the readable one. A server
 * with no reach minted is a remote caller: `list` must read alike over
 * both vaults, and `record` must name no archived id nor move a withheld
 * page into the archive when it trims the active set. The local control
 * proves the withheld dead end is there to list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEAD_END_MAX_ACTIVE, recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_dead_ends";
const PRIVATE_APPROACH = "Try the withheld route";
const PRIVATE_REASON = "Withheld reason text.";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(
    path,
    `${text.slice(0, close)}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]${text.slice(close)}`,
  );
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-dead-ends-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  const now = new Date("2026-05-03T00:00:00Z");
  recordDeadEnd(f.vault, {
    approach: "Try the readable route",
    reason: "Readable reason.",
    agent: "claude",
    now,
  });
  if (withPrivate) {
    const { entry } = recordDeadEnd(f.vault, {
      approach: PRIVATE_APPROACH,
      reason: PRIVATE_REASON,
      agent: "claude",
      now,
    });
    reserve(entry.path);
  }
  return f;
}

/** A vault holding a full active set whose oldest dead end is withheld. */
function fullFixture(): { f: Fixture; oldest: string } {
  const base = mkdtempSync(join(tmpdir(), "o2b-dead-ends-reach-full-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  const { entry } = recordDeadEnd(f.vault, {
    approach: PRIVATE_APPROACH,
    reason: PRIVATE_REASON,
    agent: "claude",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  reserve(entry.path);
  for (let i = 1; i < DEAD_END_MAX_ACTIVE; i += 1) {
    recordDeadEnd(f.vault, {
      approach: `Readable route ${i}`,
      reason: "Readable reason.",
      agent: "claude",
      now: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
    });
  }
  return { f, oldest: entry.path };
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

describe("brain_dead_ends answers at the caller's reach", () => {
  test("remote reach: list reads as in a vault without the withheld dead end", async () => {
    const args = { operation: "list" };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain("Try the readable route");
    expect(withheld).not.toContain(PRIVATE_REASON);
  });

  test("remote reach: record names no archived id", async () => {
    const args = { operation: "record", approach: "A new route", reason: "New reason." };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).not.toContain("archived");
  });

  test("remote reach: the overflow trim leaves a withheld dead end in place", async () => {
    const { f, oldest } = fullFixture();
    const bytes = readFileSync(oldest, "utf8");
    await answer(f, { operation: "record", approach: "A new route", reason: "New reason." });
    expect(existsSync(oldest)).toBe(true);
    expect(readFileSync(oldest, "utf8")).toBe(bytes);
  });

  test("local reach: the overflow trim archives the oldest dead end", async () => {
    const { f, oldest } = fullFixture();
    const local = await answer(
      f,
      { operation: "record", approach: "A new route", reason: "New reason." },
      TRANSPORT_REACH.local,
    );
    expect(existsSync(oldest)).toBe(false);
    expect(local).toContain("archived");
  });

  test("local reach: list carries the withheld dead end", async () => {
    const local = await answer(fixture(true), { operation: "list" }, TRANSPORT_REACH.local);
    expect(local).toContain(PRIVATE_REASON);
  });
});
