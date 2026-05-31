import { describe, expect, test } from "bun:test";

import {
  listSecretReferences,
  parseSecretReference,
  redactKnownSecretValues,
  resolveSecretReference,
  SecretReferenceError,
} from "../../src/core/secret-ref.ts";

describe("secret references", () => {
  test("parses $secret references without accepting raw values", () => {
    expect(parseSecretReference("$secret:GITHUB_TOKEN")?.name).toBe("GITHUB_TOKEN");
    expect(parseSecretReference("ghp_raw_token")).toBeNull();
    expect(parseSecretReference("$secret:")).toBeNull();
  });

  test("resolves through a trusted local provider only", () => {
    const value = resolveSecretReference("$secret:GITHUB_TOKEN", {
      GITHUB_TOKEN: "ghp_secret_value",
    });

    expect(value).toBe("ghp_secret_value");
  });

  test("missing secrets fail explicitly", () => {
    expect(() => resolveSecretReference("$secret:MISSING", {})).toThrow(SecretReferenceError);
    expect(() => resolveSecretReference("$secret:MISSING", {})).toThrow(
      "missing secret provider value: MISSING",
    );
  });

  test("lists config references without resolved values", () => {
    const refs = listSecretReferences(
      { github_token: "$secret:GITHUB_TOKEN", plain: "visible" },
      { GITHUB_TOKEN: "ghp_secret_value" },
    );

    expect(refs).toEqual([
      {
        configKey: "github_token",
        name: "GITHUB_TOKEN",
        available: true,
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("ghp_secret_value");
  });

  test("redacts known resolved values from diagnostics", () => {
    const out = redactKnownSecretValues(
      "connector failed with Authorization: Bearer ghp_secret_value",
      ["$secret:GITHUB_TOKEN"],
      { GITHUB_TOKEN: "ghp_secret_value" },
    );

    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("ghp_secret_value");
  });
});
