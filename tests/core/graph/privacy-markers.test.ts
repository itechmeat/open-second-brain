/**
 * Informal privacy markers (write-honesty, F1 unit 1).
 *
 * A vault written before `visibility:` was the only reservation spelling
 * tends to say `access: private`, `confidentiality: secret` or
 * `sensitivity: confidential` instead. The visibility layer reads only the
 * `visibility` key (see `graph/visibility.ts`), so those pages resolve to
 * default visibility and are handed to remote readers.
 *
 * This module is the predicate that recognises the informal spelling. It
 * answers one question - does this frontmatter contain a privacy-denying
 * marker value - and returns the reserved token to union into the
 * `visibility:` set. It deliberately does NOT widen `pageVisibility` or
 * `isVisible`: an informal marker is not a caller-scope token, so a caller
 * asking for the `private` scope must not lift it. Enforcement happens at
 * the read roots (`result-filters.ts`, `vault.ts`) and in the indexed
 * visibility column.
 */

import { describe, expect, test } from "bun:test";

import {
  PRIVACY_DENY_MARKER_VALUES,
  PRIVACY_MARKER_KEYS,
  hasPrivacyDenyMarker,
  markerDenyTokens,
  remoteDenyVisibilityTokens,
} from "../../../src/core/graph/privacy-markers.ts";
import type { FrontmatterMap } from "../../../src/core/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  REMOTE_DENY_VISIBILITY_TOKEN,
  isRemotelyReadable,
  isVisible,
  normalizeVisibilityScope,
  normToken,
  pageVisibility,
} from "../../../src/core/graph/visibility.ts";

describe("the marker vocabulary", () => {
  test("names the three informal keys and the three deny values", () => {
    expect([...PRIVACY_MARKER_KEYS]).toEqual(["access", "confidentiality", "sensitivity"]);
    expect([...PRIVACY_DENY_MARKER_VALUES]).toEqual(["private", "secret", "confidential"]);
  });

  test("every deny value is already in the normal form the predicate compares", () => {
    for (const value of PRIVACY_DENY_MARKER_VALUES) expect(normToken(value)).toBe(value);
  });
});

describe("pages with no deny marker are unchanged", () => {
  test("keyless frontmatter declares nothing", () => {
    expect(hasPrivacyDenyMarker({})).toBe(false);
    expect(markerDenyTokens({})).toEqual([]);
    expect(remoteDenyVisibilityTokens({})).toEqual([]);
  });

  test("only-formal visibility is left exactly as it was", () => {
    const meta = { visibility: ["team", "ops"] };
    expect(hasPrivacyDenyMarker(meta)).toBe(false);
    expect(markerDenyTokens(meta)).toEqual([]);
    expect(remoteDenyVisibilityTokens(meta)).toEqual(["team", "ops"]);
  });

  test("a formal reservation is already the reserved token, not a marker", () => {
    const meta = { visibility: [REMOTE_DENY_VISIBILITY_TOKEN] };
    expect(hasPrivacyDenyMarker(meta)).toBe(false);
    expect(remoteDenyVisibilityTokens(meta)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("other keys carrying the same words are not privacy markers", () => {
    expect(hasPrivacyDenyMarker({ topic: "private" })).toBe(false);
    expect(hasPrivacyDenyMarker({ status: "confidential" })).toBe(false);
    expect(markerDenyTokens({ title: "secret" })).toEqual([]);
  });
});

describe("privacy-denying marker values are caught", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly meta: FrontmatterMap;
  }> = [
    { name: "access: private", meta: { access: "private" } },
    { name: "access: secret", meta: { access: "secret" } },
    { name: "access: confidential", meta: { access: "confidential" } },
    { name: "confidentiality: private", meta: { confidentiality: "private" } },
    { name: "confidentiality: secret", meta: { confidentiality: "secret" } },
    { name: "confidentiality: confidential", meta: { confidentiality: "confidential" } },
    { name: "sensitivity: private", meta: { sensitivity: "private" } },
    { name: "sensitivity: secret", meta: { sensitivity: "secret" } },
    { name: "sensitivity: confidential", meta: { sensitivity: "confidential" } },
    { name: "a single-element array", meta: { access: ["private"] } },
    { name: "an array beside a non-deny value", meta: { sensitivity: ["internal", "secret"] } },
  ];

  for (const c of cases) {
    test(`${c.name} denies remote reads`, () => {
      expect(hasPrivacyDenyMarker(c.meta)).toBe(true);
      expect(markerDenyTokens(c.meta)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
    });
  }
});

describe("normalisation is the visibility module's own", () => {
  test("case and surrounding whitespace variants are the same value", () => {
    expect(hasPrivacyDenyMarker({ access: "  PRIVATE  " })).toBe(true);
    expect(hasPrivacyDenyMarker({ confidentiality: "Secret" })).toBe(true);
    expect(hasPrivacyDenyMarker({ sensitivity: ["CONFIDENTIAL"] })).toBe(true);
  });

  test("comparison happens after NFC composition, not by stripping marks", () => {
    // `private` + a combining acute composes to a DIFFERENT token under
    // NFC. A normaliser that stripped the mark would answer "private".
    const composed = `private${String.fromCodePoint(0x0301)}`;
    expect(normToken(composed)).not.toBe("private");
    expect(hasPrivacyDenyMarker({ access: composed })).toBe(false);
    // The same value already in NFC keeps its own spelling.
    expect(hasPrivacyDenyMarker({ access: composed.normalize("NFC") })).toBe(false);
  });

  test("an NFC value equal to a deny value is caught", () => {
    expect(hasPrivacyDenyMarker({ access: "private".normalize("NFC") })).toBe(true);
  });
});

describe("non-privacy values are not denied", () => {
  for (const value of ["public", "shared", "internal", "team", "draft"]) {
    test(`access: ${value} keeps the page reachable`, () => {
      expect(hasPrivacyDenyMarker({ access: value })).toBe(false);
      expect(markerDenyTokens({ access: value })).toEqual([]);
    });
  }

  test("a non-marker scalar type declares nothing", () => {
    expect(hasPrivacyDenyMarker({ access: 42 })).toBe(false);
    expect(hasPrivacyDenyMarker({ access: true })).toBe(false);
  });

  test("an empty string and an empty array declare nothing", () => {
    expect(hasPrivacyDenyMarker({ access: "" })).toBe(false);
    expect(hasPrivacyDenyMarker({ access: [] })).toBe(false);
  });
});

describe("the marker is not a caller-scope token", () => {
  test("pageVisibility does not see the informal key", () => {
    const meta = { access: "private" };
    expect(pageVisibility(meta)).toEqual([]);
  });

  test("a caller asking for the reserved scope does not lift a marker page", () => {
    const tags = pageVisibility({ access: "private" });
    // isVisible answers the caller-scope question only: the marker is not
    // in the tag list, so it cannot be lifted by naming it.
    expect(isVisible(tags, normalizeVisibilityScope([]))).toBe(true);
    expect(isVisible(tags, normalizeVisibilityScope(["private"]))).toBe(true);
    // And isRemotelyReadable is unchanged by the marker: the read roots,
    // not this pure predicate, are where the marker denies.
    expect(isRemotelyReadable(tags, TRANSPORT_REACH.remote)).toBe(true);
  });
});

describe("the tokens to union with the declared visibility", () => {
  test("the reserved token is appended after the declared tokens", () => {
    expect(remoteDenyVisibilityTokens({ access: "secret", visibility: ["team"] })).toEqual([
      "team",
      REMOTE_DENY_VISIBILITY_TOKEN,
    ]);
  });

  test("a declared token is never dropped", () => {
    const tokens = remoteDenyVisibilityTokens({
      confidentiality: "confidential",
      visibility: ["agent:foo", "team"],
    });
    expect(tokens).toEqual(["agent:foo", "team", REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("a declaration already naming the reserved token is not duplicated", () => {
    expect(
      remoteDenyVisibilityTokens({
        sensitivity: "private",
        visibility: ["team", REMOTE_DENY_VISIBILITY_TOKEN],
      }),
    ).toEqual(["team", REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("a string declaration is normalised like an array declaration", () => {
    expect(remoteDenyVisibilityTokens({ access: "private", visibility: "Team" })).toEqual([
      "team",
      REMOTE_DENY_VISIBILITY_TOKEN,
    ]);
  });
});
