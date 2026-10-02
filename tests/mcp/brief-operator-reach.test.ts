/**
 * `brain_brief view=operator` answers its doctor, digest, top-action and
 * trust-verdict fields at the caller's reach.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts: vault A holds a
 * reserved preference with evidence inside both the 24-hour and the
 * 30-day windows and a reserved retired record; vault B never had them.
 * Vault A also holds two withheld near-duplicate preferences, which the
 * maintenance scan ranks as a merge action naming one of them. A server
 * with no reach minted is a remote caller: the fields over the two
 * vaults must be identical, the verification entries the dry-run dream
 * yields over the twins included. The dream's own warning, uncertain and
 * quarantined counts (`dream_summary`) name no record and are not
 * compared. The local control proves the withheld records are there
 * to count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TWIN_SLUGS = ["zzwithheld-twin-a", "zzwithheld-twin-b"] as const;
const COMPARED = [
  "trust_verdict",
  "digest_summary",
  "doctor_summary",
  "top_actions",
  "verification_delta",
] as const;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

/** A withheld confirmed preference whose principle its twin repeats. */
function withheldTwin(vault: string, slug: string): void {
  const path = writePreference(vault, {
    slug,
    topic: "twin",
    principle: "Always run the formatter before every commit in this repository.",
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
  const abs =
    typeof path === "string" ? path : join(vault, "Brain", "preferences", `pref-${slug}.md`);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(
    abs,
    `${text.slice(0, close)}\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]${text.slice(close)}`,
  );
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-brief-operator-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  if (withPrivate) for (const slug of TWIN_SLUGS) withheldTwin(f.vault, slug);
  return f;
}

async function operator(f: Fixture, reach?: TransportReach): Promise<Record<string, unknown>> {
  const result = (await reachServer(f, reach).callTool("brain_brief", {
    view: "operator",
  })) as Record<string, unknown>;
  const body = (result["structuredContent"] ?? result) as Record<string, unknown>;
  return JSON.parse(maskVolatile(f, body)) as Record<string, unknown>;
}

function compared(answer: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(COMPARED.map((key) => [key, answer[key]]));
}

describe("brain_brief view=operator answers at the caller's reach", () => {
  test("remote reach: the withheld records move no compared field", async () => {
    const withheld = compared(await operator(fixture(true)));
    const absent = compared(await operator(fixture(false)));
    expect(withheld).toEqual(absent);
    expect(JSON.stringify(withheld)).not.toContain("zzwithheld");
  });

  test("local control: the operator's own shell counts the withheld records", async () => {
    const a = compared(await operator(fixture(true), TRANSPORT_REACH.local));
    const b = compared(await operator(fixture(false), TRANSPORT_REACH.local));
    const digestA = a["digest_summary"] as Record<string, number>;
    const digestB = b["digest_summary"] as Record<string, number>;
    expect(digestA["preference_count"]).toBeGreaterThan(digestB["preference_count"]!);
    expect(digestA["retired_count"]).toBeGreaterThan(digestB["retired_count"]!);
    const doctorA = a["doctor_summary"] as Record<string, number>;
    const doctorB = b["doctor_summary"] as Record<string, number>;
    expect(doctorA["warning_count"]).toBeGreaterThan(doctorB["warning_count"]!);
    expect(JSON.stringify(a["top_actions"])).toContain("zzwithheld");
    expect(JSON.stringify(a["verification_delta"])).toContain("zzwithheld");
  });
});
