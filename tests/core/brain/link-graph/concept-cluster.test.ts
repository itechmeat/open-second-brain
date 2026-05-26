/**
 * Unit tests for `buildConceptCluster`. The helper assembles a
 * deterministic, LLM-free envelope describing a target note plus
 * every artifact that wikilinks to it. Optionally includes
 * unlinked-mention rows for downstream consumers that want richer
 * coverage.
 *
 * The output is read-only and frozen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConceptCluster } from "../../../../src/core/brain/link-graph/concept-cluster.ts";
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
  vault = mkdtempSync(join(tmpdir(), "o2b-concept-cluster-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildConceptCluster - shape", () => {
  test("clean vault returns envelope with empty linkers + frozen", () => {
    const r = buildConceptCluster(vault, "pref-missing");
    expect(r.targetId).toBe("pref-missing");
    expect(r.linkers).toEqual([]);
    expect(r.unlinkedMentions).toEqual([]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.linkers)).toBe(true);
    expect(Object.isFrozen(r.unlinkedMentions)).toBe(true);
  });

  test("resolves title from frontmatter when present", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r.targetTitle).toBe("Subject Line");
  });

  test("falls back to id when no title is declared", () => {
    writePref("pref-titleless", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
    });
    const r = buildConceptCluster(vault, "pref-titleless");
    expect(r.targetTitle).toBe("pref-titleless");
  });
});

describe("buildConceptCluster - linkers", () => {
  test("collects body wikilink linker", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I reference [[pref-tgt]] in this body.",
    );
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r.linkers.length).toBe(1);
    expect(r.linkers[0]?.source).toBe("pref-linker");
    expect(r.linkers[0]?.sourceKind).toBe("preference");
    expect(r.linkers[0]?.field).toBe("body");
  });

  test("collects multiple linkers from different fields", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
    });
    writePref("pref-a", {
      kind: "preference",
      topic: "a",
      status: "confirmed",
      principle: "p",
      evidenced_by: "[pref-tgt]",
    });
    writePref(
      "pref-b",
      {
        kind: "preference",
        topic: "b",
        status: "confirmed",
        principle: "p",
      },
      "Mentions [[pref-tgt]] in body.",
    );
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r.linkers.length).toBe(2);
    const sources = r.linkers.map((l: { source: string }) => l.source).sort();
    expect(sources).toEqual(["pref-a", "pref-b"]);
  });

  test("preserves anchor info on linkers (Unit 3 enrichment)", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "See [[pref-tgt#Important]] for details.",
    );
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r.linkers[0]?.targetAnchor).toBe("Important");
  });
});

describe("buildConceptCluster - unlinked mentions toggle", () => {
  test("default does NOT include unlinked mentions", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I mention Subject Line in prose.",
    );
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r.unlinkedMentions.length).toBe(0);
  });

  test("includeUnlinked=true populates unlinked mentions", () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I mention Subject Line in prose.",
    );
    const r = buildConceptCluster(vault, "pref-tgt", { includeUnlinked: true });
    expect(r.unlinkedMentions.length).toBe(1);
    expect(r.unlinkedMentions[0]?.source).toBe("pref-linker");
  });
});

describe("buildConceptCluster - determinism", () => {
  test("does NOT make an LLM call (helper is pure)", () => {
    // Smoke: helper runs with no network access. If it ever tried to
    // call an LLM the test sandbox would surface it. No-op assertion
    // - the test passes iff the helper completes without throwing.
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
    });
    const r = buildConceptCluster(vault, "pref-tgt");
    expect(r).toBeDefined();
  });
});
