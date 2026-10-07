/**
 * The write-time advisories of `brain_feedback` answer at the caller's
 * reach.
 *
 * Vault A of tests/helpers/reach-log-fixture.ts holds a confirmed
 * preference withheld from a remote caller by visibility, and here also a
 * withheld inbox signal on a scope of its own; vault B never had either.
 * Both hold the same readable preference and a readable scoped signal. A
 * server with no reach minted is a remote caller: the conflict advisory
 * must not name the withheld preference, and the routing hint must not
 * count the withheld scope. The local control proves both are there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_SIGNAL_SIGN } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  PRIVATE_PATH,
  PRIVATE_SLUG,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_feedback";
const PUBLIC_SCOPE = "public-scope";
const WITHHELD_SCOPE = "withheld-scope";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function seedSignal(vault: string, slug: string, scope: string): string {
  return writeSignal(vault, {
    topic: slug,
    signal: BRAIN_SIGNAL_SIGN.positive,
    agent: "claude",
    principle: `Signal ${slug}.`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
    scope,
  }).path;
}

function reserveFile(abs: string): void {
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(
    abs,
    `${text.slice(0, close)}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]${text.slice(close)}`,
  );
}

/**
 * The shared fixture's `Rule <slug>.` principle is two tokens, under the
 * near-duplicate kernel's minimum, so the withheld preference gets a
 * principle long enough for the conflict advisory to score it.
 */
const PRIVATE_PRINCIPLE = `Rule ${PRIVATE_SLUG} governs every release checklist.`;

function lengthenPrivatePrinciple(vault: string): void {
  const abs = join(vault, PRIVATE_PATH);
  const text = readFileSync(abs, "utf8");
  expect(text).toContain(`Rule ${PRIVATE_SLUG}.`);
  writeFileSync(abs, text.replaceAll(`Rule ${PRIVATE_SLUG}.`, PRIVATE_PRINCIPLE));
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-feedback-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  if (withPrivate) lengthenPrivatePrinciple(f.vault);
  seedSignal(f.vault, "public-capture", PUBLIC_SCOPE);
  if (withPrivate) reserveFile(seedSignal(f.vault, "withheld-capture", WITHHELD_SCOPE));
  return f;
}

async function answer(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  const result = await reachServer(f, reach).callTool(TOOL, args);
  return maskVolatile(f, result["structuredContent"] ?? result);
}

/** A scope-less capture whose principle repeats the withheld rule word for word. */
const PROBE = { topic: "probe", signal: "positive", principle: PRIVATE_PRINCIPLE };

describe("brain_feedback advisories answer at the caller's reach", () => {
  test("remote reach: neither advisory names or counts a withheld record", async () => {
    const withheld = await answer(fixture(true), PROBE);
    expect(withheld).toBe(await answer(fixture(false), PROBE));
    expect(withheld).not.toContain(`pref-${PRIVATE_SLUG}`);
    expect(withheld).not.toContain(WITHHELD_SCOPE);
    expect(withheld).toContain(PUBLIC_SCOPE);
  });

  test("local control: the operator's shell sees both withheld records", async () => {
    const local = await answer(fixture(true), PROBE, TRANSPORT_REACH.local);
    expect(local).toContain(`pref-${PRIVATE_SLUG}`);
    expect(local).toContain(WITHHELD_SCOPE);
  });
});
