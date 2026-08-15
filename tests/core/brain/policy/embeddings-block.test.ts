/**
 * The `embeddings:` block — an operator's own record of a decommission
 * announcement, and the refusals that keep it meaningful.
 *
 * The block exists because the sunset survey is compiled into the binary
 * and goes stale between releases. It is an ADDITIONAL layer, never the
 * only source: a declaration on its own cannot distinguish "the operator
 * declared nothing" from "no shutdown exists", and that collapse is the
 * defect the sunset check was built to remove.
 *
 * Two refusals are pinned here rather than described. Half a declaration
 * is an error, because a date with no model would have to mean "whatever
 * is configured" and would re-target itself on the next model change; and
 * an unparseable date is an error, because the instant it meant is not
 * recoverable from the text - the same disposition `health.silence_before`
 * already takes.
 */

import { describe, expect, test } from "bun:test";

import { BrainConfigError } from "../../../../src/core/brain/policy/errors.ts";
import { resolveEmbeddingSunsetDeclaration } from "../../../../src/core/brain/policy/blocks/embeddings.ts";
import { validateBrainConfigDetailed } from "../../../../src/core/brain/policy/validate.ts";
import { parseBrainYaml } from "../../../../src/core/brain/yaml-parse.ts";
import type { BrainConfig } from "../../../../src/core/brain/types.ts";

function load(yaml: string): BrainConfig {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<unit>").config;
}

function warningsFor(yaml: string): ReadonlyArray<string> {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<unit>").warnings.map((w) =>
    typeof w === "string" ? w : JSON.stringify(w),
  );
}

const VALID = `schema_version: 1
embeddings:
  sunset_model: "text-embedding-3-small"
  sunset_at: "2027-03-01"
`;

describe("a complete declaration is read", () => {
  test("both keys land on the config", () => {
    const cfg = load(VALID);
    expect(cfg.embeddings?.sunset_model).toBe("text-embedding-3-small");
    expect(cfg.embeddings?.sunset_at).toBe("2027-03-01");
  });

  test("it resolves to the shape the classifier consumes", () => {
    expect(resolveEmbeddingSunsetDeclaration(load(VALID))).toEqual({
      model: "text-embedding-3-small",
      sunsetAt: "2027-03-01",
    });
  });

  test("an absent block declares nothing, which is not a claim either way", () => {
    expect(resolveEmbeddingSunsetDeclaration(load("schema_version: 1\n"))).toBeNull();
    expect(resolveEmbeddingSunsetDeclaration(undefined)).toBeNull();
  });
});

describe("half a declaration is refused, never dropped", () => {
  test("a date with no model fails hard", () => {
    // Silently ignoring it would leave an operator believing a setting is
    // in force when it is not.
    expect(() => load(`schema_version: 1\nembeddings:\n  sunset_at: "2027-03-01"\n`)).toThrow(
      BrainConfigError,
    );
  });

  test("a model with no date fails hard", () => {
    expect(() => load(`schema_version: 1\nembeddings:\n  sunset_model: "m"\n`)).toThrow(
      BrainConfigError,
    );
  });
});

describe("a malformed value is refused, never substituted", () => {
  test("a date that is not ISO-8601 fails hard", () => {
    expect(() =>
      load(`schema_version: 1\nembeddings:\n  sunset_model: "m"\n  sunset_at: "next tuesday"\n`),
    ).toThrow(BrainConfigError);
  });

  test("an empty model string fails hard", () => {
    expect(() =>
      load(`schema_version: 1\nembeddings:\n  sunset_model: ""\n  sunset_at: "2027-03-01"\n`),
    ).toThrow(BrainConfigError);
  });

  test("the error names the key an operator has to edit", () => {
    try {
      load(`schema_version: 1\nembeddings:\n  sunset_model: "m"\n  sunset_at: "nope"\n`);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as BrainConfigError).message).toContain("sunset_at");
    }
  });
});

describe("an unknown sub-key is a warning, not a refusal", () => {
  test("it is reported without losing the valid keys", () => {
    const yaml = `${VALID}  sunset_reason: "vendor email"\n`;
    expect(warningsFor(yaml).join("\n")).toContain("sunset_reason");
    expect(load(yaml).embeddings?.sunset_at).toBe("2027-03-01");
  });
});
