/**
 * Unit tests for `auditMoc`. Given a hub note id whose outbound
 * wikilinks form a cluster, classify each member into well-covered /
 * fragile / candidate-missing / suggested-next buckets.
 *
 * The MOC heuristic is purely structural: outbound link count + body
 * link-density must cross configured thresholds. No vocabulary
 * detection of "this looks like a MOC because the title says so".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditMoc, MocAuditError } from "../../../../src/core/brain/link-graph/moc-audit.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";

let vault: string;

const DERIVED_KEYS = new Set([
  "status",
  "applied_count",
  "violated_count",
  "last_evidence_at",
  "confidence",
  "confidence_value",
  "evidenced_by",
  "contradicted_by",
  "lifecycle",
  "confirmed_at",
]);

function writePref(slug: string, fm: Record<string, string>, body = ""): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    const key = DERIVED_KEYS.has(k) ? `_${k}` : k;
    lines.push(`${key}: ${v}`);
  }
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-moc-audit-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("auditMoc - MOC detection threshold", () => {
  test("note with too few outbound links is rejected as non-MOC", () => {
    writePref(
      "pref-not-moc",
      {
        kind: "preference",
        topic: "n",
        status: "confirmed",
        principle: "p",
      },
      "Just [[pref-a]] and [[pref-b]] here.",
    );
    expect(() => auditMoc(vault, "pref-not-moc")).toThrow(MocAuditError);
  });

  test("note with high outbound link count + link density qualifies", () => {
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref("pref-f", { kind: "preference", topic: "f", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      {
        kind: "preference",
        topic: "hub",
        status: "confirmed",
        principle: "p",
      },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-f]]",
    );
    const r = auditMoc(vault, "pref-hub");
    expect(r.hubId).toBe("pref-hub");
    expect(r.outboundCount).toBe(6);
  });
});

describe("auditMoc - bucket classification", () => {
  test("well-covered: cluster member with multiple backlinks + body above floor", () => {
    // Hub references pref-popular. Two other prefs also reference pref-popular.
    // Body of pref-popular is long.
    const longBody = "Long body content. ".repeat(20);
    writePref(
      "pref-popular",
      { kind: "preference", topic: "p", status: "confirmed", principle: "p" },
      longBody,
    );
    writePref(
      "pref-a",
      { kind: "preference", topic: "a", status: "confirmed", principle: "p" },
      "Refers to [[pref-popular]].",
    );
    writePref(
      "pref-b",
      { kind: "preference", topic: "b", status: "confirmed", principle: "p" },
      "Also [[pref-popular]].",
    );
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-popular]] [[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]]",
    );
    const r = auditMoc(vault, "pref-hub");
    const wellNames = r.wellCovered.map((c) => c.id);
    expect(wellNames).toContain("pref-popular");
  });

  test("fragile: cluster member with only one backlink and short body", () => {
    writePref(
      "pref-thin",
      { kind: "preference", topic: "t", status: "confirmed", principle: "p" },
      "short",
    );
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-thin]] [[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]]",
    );
    const r = auditMoc(vault, "pref-hub");
    const fragileNames = r.fragile.map((c) => c.id);
    expect(fragileNames).toContain("pref-thin");
  });

  test("candidate-missing: hub references a target with no on-disk artifact", () => {
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-missing]]",
    );
    const r = auditMoc(vault, "pref-hub");
    const missingNames = r.candidateMissing.map((c) => c.id);
    expect(missingNames).toContain("pref-missing");
  });

  test("suggested-next: highest-leverage candidate-missing (most mentions across cluster)", () => {
    // pref-popular-missing referenced from hub + 2 cluster members.
    // pref-rare-missing referenced from hub only.
    writePref(
      "pref-a",
      { kind: "preference", topic: "a", status: "confirmed", principle: "p" },
      "see [[pref-popular-missing]]",
    );
    writePref(
      "pref-b",
      { kind: "preference", topic: "b", status: "confirmed", principle: "p" },
      "again [[pref-popular-missing]]",
    );
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-popular-missing]] [[pref-rare-missing]]",
    );
    const r = auditMoc(vault, "pref-hub");
    expect(r.suggestedNext?.id).toBe("pref-popular-missing");
  });
});

describe("auditMoc - shape", () => {
  test("returned object is frozen", () => {
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-a]]",
    );
    const r = auditMoc(vault, "pref-hub");
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.wellCovered)).toBe(true);
    expect(Object.isFrozen(r.fragile)).toBe(true);
    expect(Object.isFrozen(r.candidateMissing)).toBe(true);
  });
});
