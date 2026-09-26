import { describe, expect, test } from "bun:test";

import {
  listSecretReferences,
  parseSecretReference,
  redactKnownSecretValues,
  resolveSecretReference,
  SecretReferenceError,
} from "../../src/core/secret-ref.ts";
import { FAKE_GITHUB_SECRET } from "../helpers/fake-credentials.ts";

const GITHUB_REF = "$secret:GITHUB_TOKEN";
/** A reference with the prefix but no name. */
const EMPTY_REFERENCE = "$secret:";

describe("secret references", () => {
  test("parses $secret references without accepting raw values", () => {
    expect(parseSecretReference("$secret:GITHUB_TOKEN")?.name).toBe("GITHUB_TOKEN");
    expect(parseSecretReference("ghp_raw_token")).toBeNull();
    expect(parseSecretReference(EMPTY_REFERENCE)).toBeNull();
  });

  test("resolves through a trusted local provider only", () => {
    const value = resolveSecretReference("$secret:GITHUB_TOKEN", {
      GITHUB_TOKEN: FAKE_GITHUB_SECRET,
    });

    expect(value).toBe(FAKE_GITHUB_SECRET);
  });

  test("missing secrets fail explicitly", () => {
    expect(() => resolveSecretReference("$secret:MISSING", {})).toThrow(SecretReferenceError);
    expect(() => resolveSecretReference("$secret:MISSING", {})).toThrow(
      "missing secret provider value: MISSING",
    );
  });

  test("lists config references without resolved values", () => {
    const refs = listSecretReferences(
      { github_token: GITHUB_REF, plain: "visible" },
      { GITHUB_TOKEN: FAKE_GITHUB_SECRET },
    );

    expect(refs).toEqual([
      {
        configKey: "github_token",
        name: "GITHUB_TOKEN",
        available: true,
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain(FAKE_GITHUB_SECRET);
  });

  test("redacts known resolved values from diagnostics", () => {
    const out = redactKnownSecretValues(
      `connector failed with Authorization: Bearer ${FAKE_GITHUB_SECRET}`,
      ["$secret:GITHUB_TOKEN"],
      { GITHUB_TOKEN: FAKE_GITHUB_SECRET },
    );

    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain(FAKE_GITHUB_SECRET);
  });

  test("redacts overlapping values longest first", () => {
    const out = redactKnownSecretValues("token=abcdef", ["$secret:SHORT", "$secret:LONG"], {
      SHORT: "abc",
      LONG: "abcdef",
    });

    expect(out).toBe("token=***REDACTED***");
  });
});
