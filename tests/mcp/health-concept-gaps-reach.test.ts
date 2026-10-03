/**
 * The semantic-health readers count concept gaps over the principles the
 * caller may read.
 *
 * Vault A holds six confirmed preferences withheld from a remote caller
 * by visibility, whose principles repeat one marker phrase, so the
 * concept-gap detector reports the phrase as a recurring term no topic
 * covers; vault B never had them. Both carry the log of
 * tests/helpers/reach-log-fixture.ts. A server with no reach minted is a
 * remote caller: `brain_health`, `brain_doctor` and `brain_trigger
 * operation=scan` over the two vaults must answer identically once the
 * volatile parts are masked. The local control proves the withheld
 * principles are there to count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signalPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

/** The phrase the withheld principles repeat, so it surfaces as a concept gap. */
const MARKER = "zzquartz harbor";
const WITHHELD_COUNT = 6;
/** The doctor code a recurring uncovered term is reported under. */
const CONCEPT_GAP_CODE = "concept-gap";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function withheldPreference(vault: string, index: number): void {
  const slug = `zzgap-${index}`;
  writePreference(vault, {
    slug,
    topic: `misc-${index}`,
    principle: `Route builds via Zzquartz Harbor ${index}.`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

/** The phrase the withheld signals repeat, so it surfaces as a concept gap. */
const SIGNAL_MARKER = "zzbasalt quay";

/** A withheld inbox signal whose principle carries {@link SIGNAL_MARKER}. */
function withheldSignal(vault: string, index: number): void {
  const date = "2026-05-01";
  const slug = `zzgap-signal-${index}`;
  writeSignal(vault, {
    topic: `misc-signal-${index}`,
    signal: "positive",
    agent: "test",
    principle: `Ship releases via Zzbasalt Quay ${index}.`,
    created_at: `${date}T00:00:00Z`,
    date,
    slug,
  });
  const path = signalPath(vault, date, slug);
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function fixture(withPrivate: boolean, withheldSignals = false): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-health-gaps-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  if (withPrivate) for (let i = 0; i < WITHHELD_COUNT; i++) withheldPreference(f.vault, i);
  if (withPrivate && withheldSignals) {
    for (let i = 0; i < WITHHELD_COUNT; i++) withheldSignal(f.vault, i);
  }
  return f;
}

async function answer(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  const result = await reachServer(f, reach).callTool(tool, args);
  return maskVolatile(f, result["structuredContent"] ?? result);
}

/** The remote answers over vault A and vault B, whole and masked. */
async function remotePair(
  tool: string,
  args: Record<string, unknown>,
): Promise<readonly [string, string]> {
  const withheld = await answer(fixture(true), tool, args);
  const absent = await answer(fixture(false), tool, args);
  return [withheld, absent];
}

describe("concept gaps answer at the caller's reach", () => {
  test("remote reach: brain_health names no term only withheld principles carry", async () => {
    const [withheld, absent] = await remotePair("brain_health", {});
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(MARKER);
  });

  test("remote reach: brain_doctor raises no concept gap from withheld principles", async () => {
    const [withheld, absent] = await remotePair("brain_doctor", {});
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(MARKER);
  });

  test("remote reach: the brain_doctor repair preview counts no concept gap from withheld principles", async () => {
    const [withheld, absent] = await remotePair("brain_doctor", { repair: true, format: "json" });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(CONCEPT_GAP_CODE);
  });

  test("remote reach: brain_trigger scan counts no candidate from withheld records", async () => {
    const [withheld, absent] = await remotePair("brain_trigger", { operation: "scan" });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain("zzgap");
  });

  test("local control: the operator's own shell sees the recurring term", async () => {
    const a = fixture(true);
    expect(await answer(a, "brain_health", {}, TRANSPORT_REACH.local)).toContain(MARKER);
    expect(await answer(a, "brain_doctor", {}, TRANSPORT_REACH.local)).toContain(MARKER);
    const preview = { repair: true, format: "json" };
    expect(await answer(a, "brain_doctor", preview, TRANSPORT_REACH.local)).toContain(
      CONCEPT_GAP_CODE,
    );
  });

  test("remote reach: withheld signal principles add no concept gap", async () => {
    const withheld = await answer(fixture(true, true), "brain_health", {});
    const absent = await answer(fixture(false, true), "brain_health", {});
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(SIGNAL_MARKER);
  });

  test("local control: the operator's brain_health names the withheld signals' term", async () => {
    const local = await answer(fixture(true, true), "brain_health", {}, TRANSPORT_REACH.local);
    expect(local).toContain(SIGNAL_MARKER);
  });
});
