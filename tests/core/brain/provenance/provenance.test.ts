/**
 * Provenance / citation primitive (shared lib b of the Knowledge Provenance
 * suite). Every generation-bearing feature (ingest, research report, derived
 * facts) stamps its output through this one module so source links, premise
 * links, and the stated/deduced/inferred trust level have a single canonical
 * representation, renderer, and ordering.
 *
 * The module owns the level type, its narrowing guard, the trust ranking used
 * by recall, the body-section renderer, and a deterministic source-identity
 * hash. It deliberately does NOT know any page's frontmatter schema - each
 * consumer (preference, entity page, report) serializes the level itself via
 * asProvenanceLevel, so the primitive stays decoupled and reusable.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  asProvenanceLevel,
  provenanceTrustRank,
  renderProvenanceSection,
  sourceIdentityHash,
  PROVENANCE_LEVELS,
  type Provenance,
} from "../../../../src/core/brain/provenance/provenance.ts";

describe("asProvenanceLevel", () => {
  test("accepts the three canonical levels", () => {
    expect(asProvenanceLevel("stated")).toBe("stated");
    expect(asProvenanceLevel("deduced")).toBe("deduced");
    expect(asProvenanceLevel("inferred")).toBe("inferred");
  });

  test("normalizes case and surrounding whitespace", () => {
    expect(asProvenanceLevel("  Stated ")).toBe("stated");
    expect(asProvenanceLevel("INFERRED")).toBe("inferred");
  });

  test("returns null for an unknown token", () => {
    expect(asProvenanceLevel("guessed")).toBeNull();
    expect(asProvenanceLevel("")).toBeNull();
    expect(asProvenanceLevel("   ")).toBeNull();
  });

  test("returns null for a non-string value (no cast crutch)", () => {
    expect(asProvenanceLevel(42)).toBeNull();
    expect(asProvenanceLevel(null)).toBeNull();
    expect(asProvenanceLevel(undefined)).toBeNull();
    expect(asProvenanceLevel(["stated"])).toBeNull();
  });

  test("PROVENANCE_LEVELS lists every level exactly once, most-trusted first", () => {
    expect(PROVENANCE_LEVELS).toEqual(["stated", "deduced", "inferred"]);
    for (const level of PROVENANCE_LEVELS) {
      expect(asProvenanceLevel(level)).toBe(level);
    }
  });
});

describe("provenanceTrustRank", () => {
  test("ranks stated above deduced above inferred (lower rank = more trusted)", () => {
    expect(provenanceTrustRank("stated")).toBeLessThan(provenanceTrustRank("deduced"));
    expect(provenanceTrustRank("deduced")).toBeLessThan(provenanceTrustRank("inferred"));
  });

  test("rank is the position in PROVENANCE_LEVELS", () => {
    expect(provenanceTrustRank("stated")).toBe(0);
    expect(provenanceTrustRank("inferred")).toBe(PROVENANCE_LEVELS.length - 1);
  });
});

describe("sourceIdentityHash", () => {
  test("is a 64-char lowercase hex sha256, deterministic for the same parts", () => {
    const h = sourceIdentityHash(["Articles/x.md", "section-2"]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceIdentityHash(["Articles/x.md", "section-2"])).toBe(h);
  });

  test("matches a direct sha256 over the trimmed, newline-joined parts", () => {
    const parts = [" Articles/x.md ", "section-2 "];
    const expected = createHash("sha256").update("Articles/x.md\nsection-2", "utf8").digest("hex");
    expect(sourceIdentityHash(parts)).toBe(expected);
  });

  test("different parts produce different hashes", () => {
    expect(sourceIdentityHash(["a"])).not.toBe(sourceIdentityHash(["b"]));
  });
});

describe("renderProvenanceSection", () => {
  test("renders a Sources section with one wikilink bullet per source", () => {
    const prov: Provenance = {
      level: "stated",
      sources: ["[[Articles/x.md]]", "[[Articles/y.md]]"],
      premises: [],
    };
    expect(renderProvenanceSection(prov)).toBe(
      ["## Sources", "", "- [[Articles/x.md]]", "- [[Articles/y.md]]"].join("\n"),
    );
  });

  test("renders a Premises section with the trust level when premises are present", () => {
    const prov: Provenance = {
      level: "inferred",
      sources: [],
      premises: ["[[pref-a]]", "[[pref-b]]"],
    };
    expect(renderProvenanceSection(prov)).toBe(
      ["## Premises (inferred)", "", "- [[pref-a]]", "- [[pref-b]]"].join("\n"),
    );
  });

  test("renders both sections, Sources before Premises, separated by a blank line", () => {
    const prov: Provenance = {
      level: "deduced",
      sources: ["[[s.md]]"],
      premises: ["[[pref-a]]"],
    };
    expect(renderProvenanceSection(prov)).toBe(
      ["## Sources", "", "- [[s.md]]", "", "## Premises (deduced)", "", "- [[pref-a]]"].join("\n"),
    );
  });

  test("returns an empty string when there are no sources and no premises", () => {
    const prov: Provenance = { level: "stated", sources: [], premises: [] };
    expect(renderProvenanceSection(prov)).toBe("");
  });

  test("is deterministic and idempotent on identical input", () => {
    const prov: Provenance = {
      level: "inferred",
      sources: ["[[s.md]]"],
      premises: ["[[pref-a]]"],
    };
    expect(renderProvenanceSection(prov)).toBe(renderProvenanceSection(prov));
  });

  test("preserves caller ordering of sources and premises (no implicit sort)", () => {
    const prov: Provenance = {
      level: "stated",
      sources: ["[[z.md]]", "[[a.md]]"],
      premises: [],
    };
    expect(renderProvenanceSection(prov)).toBe(
      ["## Sources", "", "- [[z.md]]", "- [[a.md]]"].join("\n"),
    );
  });
});
