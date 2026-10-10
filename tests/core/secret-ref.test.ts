import { describe, expect, test } from "bun:test";

import {
  listSecretReferences,
  parseSecretReference,
  redactKnownSecretValues,
  resolveSecretReference,
  storeSecretName,
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

  test("parses dashed and digit-led bodies so store-slug names are spellable", () => {
    // The store's name grammar is a lowercase slug with `-`/`_` allowed, so
    // `set openai-key` stores a name the reference grammar must be able to
    // spell (write-side trust review: the old grammar refused it outright).
    expect(parseSecretReference("$secret:openai-key")?.name).toBe("openai-key");
    expect(parseSecretReference("$secret:2fa-token")?.name).toBe("2fa-token");
    expect(parseSecretReference("$secret:BRAVE")?.name).toBe("BRAVE");
    // Still not spellable: an empty body, or characters no store name or env
    // name carries.
    expect(parseSecretReference("$secret:has space")).toBeNull();
    expect(parseSecretReference("$secret:has.dot")).toBeNull();
  });

  test("storeSecretName normalizes for the store leg only", () => {
    expect(storeSecretName("BRAVE")).toBe("brave");
    expect(storeSecretName("openai-key")).toBe("openai-key");
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
    // Both literals clear the minimum redaction length; SHORT is a suffix of
    // LONG, so a shortest-first substitution would destroy LONG's match.
    const out = redactKnownSecretValues("token=abcdefghij", ["$secret:SHORT", "$secret:LONG"], {
      SHORT: "abcdefgh",
      LONG: "abcdefghij",
    });

    expect(out).toBe("token=***REDACTED***");
  });

  test("a literal below the minimum redaction length is not substituted", () => {
    // The over-redaction guard: a 2-char stored value used to blank every
    // occurrence of those characters in the surrounding text (write-side
    // trust review). The trade-off is stated in the source: such a value is
    // NOT scrubbed.
    const out = redactKnownSecretValues("key=ok token=ok end", ["$secret:TINY"], {
      TINY: "ok",
    });

    expect(out).toBe("key=ok token=ok end");
    expect(out).not.toContain("***REDACTED***");
  });
});
