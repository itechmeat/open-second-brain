/**
 * `brain_diarize` answers at the caller's reach.
 *
 * Vault A holds a source page and a subject page withheld from a remote
 * caller by visibility beside readable ones; vault B never had them. A
 * server with no reach minted is a remote caller: the readable subject's
 * profile must read alike over both vaults (no withheld source path,
 * digest or count), and the withheld subject must answer as an unknown
 * entity. The local control proves the withheld pages are there to read.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_diarize";
const NOW = new Date("2026-07-19T10:00:00Z");
const READABLE_SUBJECT = "Ada Lovelace";
const PRIVATE_SUBJECT = "Grace Hopper";
const PRIVATE_SOURCE = "src-letters";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function writeSourcePage(vault: string, slug: string, body: string, reserved: boolean): void {
  const dir = join(vault, "Brain", "sources");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      "---",
      "kind: brain-source",
      `source_path: ${slug}.txt`,
      "source_hash: deadbeef",
      "created_at: 2026-07-10T00:00:00Z",
      "updated_at: 2026-07-10T00:00:00Z",
      ...(reserved ? [RESERVE_LINE] : []),
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-diarize-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  upsertEntity(f.vault, {
    category: "person",
    name: READABLE_SUBJECT,
    agent: "test",
    now: NOW,
    body: "Ada Lovelace designed an early programming method.",
  });
  writeSourcePage(f.vault, "src-lecture", "Ada Lovelace attended a lecture.", false);
  if (withPrivate) {
    writeSourcePage(f.vault, PRIVATE_SOURCE, "Ada Lovelace wrote withheld letters.", true);
    const { entity } = upsertEntity(f.vault, {
      category: "person",
      name: PRIVATE_SUBJECT,
      agent: "test",
      now: NOW,
      body: "Grace Hopper kept a withheld notebook.",
    });
    reserve(entity.path);
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
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (error) {
    return maskVolatile(f, { error: (error as Error).message });
  }
}

describe("brain_diarize answers at the caller's reach", () => {
  test("remote reach: a readable subject's profile counts no withheld source", async () => {
    const args = { entity: READABLE_SUBJECT };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).not.toContain(PRIVATE_SOURCE);
  });

  test("remote reach: a withheld subject answers as an unknown entity", async () => {
    const args = { entity: PRIVATE_SUBJECT };
    const withheld = await answer(fixture(true), args);
    expect(withheld).toBe(await answer(fixture(false), args));
    expect(withheld).toContain("unknown entity");
  });

  test("local reach: the withheld source and subject are there to read", async () => {
    const f = fixture(true);
    const local = await answer(f, { entity: READABLE_SUBJECT }, TRANSPORT_REACH.local);
    expect(local).toContain(PRIVATE_SOURCE);
    const subject = await answer(f, { entity: PRIVATE_SUBJECT }, TRANSPORT_REACH.local);
    expect(subject).toContain("withheld notebook");
  });
});
