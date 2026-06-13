/**
 * Derived-fact synthesis with premise provenance (Knowledge Provenance suite).
 * The agent reasons the conclusion; OSB validates premises and commits the
 * derived fact with a deduced/inferred provenance level and premise links.
 * Tests cover the deterministic plumbing (provenance round-trip, premise
 * validation, trust ordering) - never model-generated reasoning text.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { writePreference, parsePreference } from "../../../src/core/brain/preference.ts";
import { deriveFact, DeriveFactError } from "../../../src/core/brain/derived-fact.ts";
import { sortByProvenanceTrust } from "../../../src/core/brain/provenance/trust-order.ts";
import type { BrainPreference } from "../../../src/core/brain/types.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-derive-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-derive-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedPremise(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `premise ${slug}`,
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-07-01T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
  });
}

describe("provenance round-trips through write/parse", () => {
  test("an inferred level persists; absent reads as undefined (i.e. stated)", () => {
    writePreference(vault, {
      slug: "derived",
      topic: "derived-topic",
      principle: "derived rule",
      created_at: "2026-06-13T12:00:00Z",
      unconfirmed_until: "2026-07-13T12:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[pref-a]]"],
      provenance: "inferred",
    });
    expect(parsePreference(preferencePath(vault, "derived")).provenance).toBe("inferred");

    seedPremise("plain");
    expect(parsePreference(preferencePath(vault, "plain")).provenance).toBeUndefined();
  });
});

describe("deriveFact", () => {
  test("commits a derived fact with premise links and the provenance level", () => {
    seedPremise("a");
    seedPremise("b");
    const res = deriveFact(
      vault,
      {
        slug: "because-a-and-b",
        topic: "derived",
        principle: "Therefore C",
        premises: ["pref-a", "b"],
        level: "deduced",
      },
      { now: NOW },
    );
    expect(res.id).toBe("pref-because-a-and-b");
    const pref = parsePreference(preferencePath(vault, "because-a-and-b"));
    expect(pref.provenance).toBe("deduced");
    expect(pref.status).toBe("unconfirmed");
    expect(pref.evidenced_by).toEqual(["[[pref-a]]", "[[pref-b]]"]);
  });

  test("rejects a missing premise with no write", () => {
    seedPremise("a");
    expect(() =>
      deriveFact(
        vault,
        { slug: "d", topic: "t", principle: "p", premises: ["pref-a", "ghost"], level: "inferred" },
        { now: NOW },
      ),
    ).toThrow(DeriveFactError);
  });

  test("rejects a 'stated' level (a derived fact is never operator-stated)", () => {
    seedPremise("a");
    expect(() =>
      deriveFact(
        vault,
        { slug: "d", topic: "t", principle: "p", premises: ["pref-a"], level: "stated" },
        { now: NOW },
      ),
    ).toThrow(DeriveFactError);
  });
});

const mk = (
  id: string,
  provenance?: BrainPreference["provenance"],
): { id: string; provenance?: BrainPreference["provenance"] } =>
  provenance !== undefined ? { id, provenance } : { id };

describe("sortByProvenanceTrust", () => {
  test("disabled: returns the input order unchanged (byte-identical)", () => {
    const input = [mk("x", "inferred"), mk("y", "stated")];
    expect(sortByProvenanceTrust(input, false).map((r) => r.id)).toEqual(["x", "y"]);
  });

  test("enabled: ranks stated above deduced above inferred, stably", () => {
    const input = [
      mk("inf", "inferred"),
      mk("stated-implicit"),
      mk("ded", "deduced"),
      mk("stated-explicit", "stated"),
    ];
    expect(sortByProvenanceTrust(input, true).map((r) => r.id)).toEqual([
      "stated-implicit",
      "stated-explicit",
      "ded",
      "inf",
    ]);
  });
});
