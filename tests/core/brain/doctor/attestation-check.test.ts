/**
 * The attestation doctor check (delivery trust, Lane D task D6).
 *
 * A failSoft liveness check over the attestation family: a MISSING KEY
 * matters only when attestations exist (a vault that never attests owes
 * no key), a STALE newest attestation past a named window matters because
 * the point it vouches for recedes, and a DIVERGED shard matters most.
 * All three fold into ONE warning under one code, naming the next
 * command, because the operator's action is the same either way: run
 * `o2b brain attest verify` (or keygen, then sign). A vault with no
 * attestations at all is silent - there is no expectation to have missed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectAttestationManifest } from "../../../../src/core/brain/attestation/digest.ts";
import {
  attestationsDir,
  buildAttestationRecord,
  writeAttestationRecord,
} from "../../../../src/core/brain/attestation/record.ts";
import {
  attestationKeyPaths,
  generateAttestationKeypair,
  signAttestationRecord,
} from "../../../../src/core/brain/attestation/signing.ts";
import {
  ATTESTATION_STALE_DAYS,
  attestationCheck,
} from "../../../../src/core/brain/doctor/attestation-check.ts";
import type {
  DoctorCheckContext,
  DoctorFindings,
} from "../../../../src/core/brain/doctor/check.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { writeVaultIdentity } from "../../../../src/core/brain/vault-identity.ts";

const DATE = "2026-06-03";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-attest-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function append(count: number): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      {},
    );
  }
}

function fixtureContext(now: Date): DoctorCheckContext {
  return {
    vault,
    now,
    config: undefined,
    dbPath: undefined,
    configPath: undefined,
    knownBasenames: new Set(),
    idIndex: new Map(),
    preferences: [],
    logs: [],
  };
}

function runCheck(now: Date): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  attestationCheck.run(fixtureContext(now), out);
  return out;
}

/** Keygen, sign and write one attestation stamped at the given instant. */
function writeAttestationAt(instant: Date): void {
  generateAttestationKeypair(vault);
  const record = buildAttestationRecord(vault, collectAttestationManifest(vault), { now: instant });
  writeAttestationRecord(vault, signAttestationRecord(record, vault));
}

test("a vault with no attestations is silent, with or without a key", () => {
  expect(runCheck(new Date("2026-06-04T00:00:00Z")).issues).toEqual([]);
  generateAttestationKeypair(vault);
  expect(runCheck(new Date("2026-06-04T00:00:00Z")).issues).toEqual([]);
});

test("a missing key is reported only when attestations exist", () => {
  append(2);
  writeAttestationAt(new Date("2026-06-03T10:05:00Z"));
  const { privatePath } = attestationKeyPaths(vault);
  expect(existsSync(privatePath)).toBe(true);
  unlinkSync(privatePath);

  const issues = runCheck(new Date("2026-06-04T00:00:00Z")).issues;
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("attestation-stale-or-diverged");
  expect(issues[0]!.severity).toBe("warning");
  // The fact states what is actually lost - the ability to sign. While
  // the exported public half survives, every past attestation still
  // verifies against it, and keygen itself refuses while either half
  // exists, so the advice never destroys evidence and never points at a
  // refusal: the surviving half makes verify the answer.
  expect(issues[0]!.message).toContain("the surviving public half");
  expect(issues[0]!.message).not.toContain("unverifiable");
  expect(issues[0]!.message).toContain("attest verify");

  // With BOTH halves gone there is nothing to inspect against: keygen is
  // the remedy again.
  unlinkSync(join(vault, ".open-second-brain", "keys", "attestation", "attestation.pub"));
  const bothGone = runCheck(new Date("2026-06-04T00:00:00Z")).issues;
  expect(bothGone).toHaveLength(1);
  expect(bothGone[0]!.message).toContain("attest keygen");
});

test("a fresh attestation with its key and an untouched store is silent", () => {
  append(2);
  writeAttestationAt(new Date("2026-06-03T10:05:00Z"));
  expect(runCheck(new Date("2026-06-04T00:00:00Z")).issues).toEqual([]);
});

test(`a newest attestation older than ${ATTESTATION_STALE_DAYS} days is reported once`, () => {
  append(2);
  writeAttestationAt(new Date("2026-01-01T10:05:00Z"));
  const msPerDay = 24 * 60 * 60 * 1000;
  const boundary = new Date(
    new Date("2026-01-01T10:05:00Z").getTime() + ATTESTATION_STALE_DAYS * msPerDay,
  );
  // Inside the window: silent. Past it: exactly one warning.
  expect(runCheck(boundary).issues).toEqual([]);
  const issues = runCheck(new Date(boundary.getTime() + msPerDay)).issues;
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("attestation-stale-or-diverged");
  expect(issues[0]!.message).toContain(`past the ${ATTESTATION_STALE_DAYS}-day window`);
  expect(issues[0]!.message).toContain("o2b brain attest sign");
});

test("a diverged shard from the newest attestation is reported, appended is not", () => {
  append(2);
  writeAttestationAt(new Date("2026-06-03T10:05:00Z"));
  // Legitimate append: a store that MOVED, not one that broke. Silent.
  append(2);
  expect(runCheck(new Date("2026-06-04T00:00:00Z")).issues).toEqual([]);

  // Forge the newest row: the forward walk's hash recompute fails.
  const shardPath = join(vault, "Brain", "log", `${DATE}.jsonl`);
  const lines = readFileSync(shardPath, "utf8").trim().split("\n");
  const row = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  (row["payload"] as Record<string, unknown>)["text"] = "forged after signing";
  lines[lines.length - 1] = JSON.stringify(row);
  writeFileSync(shardPath, `${lines.join("\n")}\n`, "utf8");

  const issues = runCheck(new Date("2026-06-04T00:00:00Z")).issues;
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("attestation-stale-or-diverged");
  expect(issues[0]!.message).toContain("diverged");
  expect(issues[0]!.message).toContain("o2b brain attest verify");
});

test("the check never throws and never writes", () => {
  // A vault whose attestations directory holds garbage must reach the
  // uncertain stream, not the exception path.
  append(2);
  mkdirSync(attestationsDir(vault), { recursive: true });
  writeFileSync(join(attestationsDir(vault), "attest-not-a-record.json"), "{", "utf8");
  const out = runCheck(new Date("2026-06-04T00:00:00Z"));
  expect(out.issues).toEqual([]);
  expect(out.uncertain.length).toBe(1);
});
