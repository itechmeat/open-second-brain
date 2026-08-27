/**
 * Deny-by-default remote readability (private-is-not-a-suggestion, unit 1).
 *
 * One reserved visibility token means "not readable by a caller that only
 * reached this server over the network". The predicate that answers it is
 * the single spelling of that rule; every other visibility token keeps
 * exactly the caller-liftable scoping semantics `isVisible` already gives
 * it.
 *
 * The reserved token is a controlled-vocabulary identifier, in the same
 * sense as `kind: entity` or an entity `status` value - not a
 * natural-language phrase, and not a closed list of them.
 */

import { describe, expect, test } from "bun:test";

import {
  REMOTE_DENY_VISIBILITY_TOKEN,
  isRemotelyReadable,
  isVisible,
  normalizeVisibilityScope,
  pageVisibility,
} from "../../../src/core/graph/visibility.ts";
import {
  TRANSPORT_REACH,
  TRANSPORT_REACHES,
  isTransportReach,
} from "../../../src/core/graph/transport-reach.ts";

/** A token that is NOT the reserved one, for the "unaffected" arm. */
const ORDINARY_TOKEN = "team";

describe("the transport reach vocabulary", () => {
  test("is closed, and its membership list matches the object", () => {
    expect([...TRANSPORT_REACHES].toSorted()).toEqual(Object.values(TRANSPORT_REACH).toSorted());
  });

  test("narrows only its own members", () => {
    for (const reach of TRANSPORT_REACHES) expect(isTransportReach(reach)).toBe(true);
    for (const other of ["", "full", "reduced", "LOCAL", 0, null, undefined, {}]) {
      expect(isTransportReach(other)).toBe(false);
    }
  });
});

describe("the reserved token", () => {
  test("is already in the normal form page tags are read into", () => {
    // A second spelling of the reserved token would be a second rule.
    expect(pageVisibility({ visibility: REMOTE_DENY_VISIBILITY_TOKEN })).toEqual([
      REMOTE_DENY_VISIBILITY_TOKEN,
    ]);
  });

  test("is matched through the same NFC + lower-case normalisation", () => {
    const upper = REMOTE_DENY_VISIBILITY_TOKEN.toUpperCase();
    expect(
      isRemotelyReadable(pageVisibility({ visibility: `  ${upper} ` }), TRANSPORT_REACH.remote),
    ).toBe(false);
  });
});

describe("isRemotelyReadable truth table", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tags: ReadonlyArray<string>;
    readonly local: boolean;
    readonly remote: boolean;
  }> = [
    { name: "untagged", tags: [], local: true, remote: true },
    {
      name: "the reserved token alone",
      tags: [REMOTE_DENY_VISIBILITY_TOKEN],
      local: true,
      remote: false,
    },
    { name: "a non-reserved token alone", tags: [ORDINARY_TOKEN], local: true, remote: true },
    {
      name: "the reserved token beside a non-reserved one",
      tags: [ORDINARY_TOKEN, REMOTE_DENY_VISIBILITY_TOKEN],
      local: true,
      remote: false,
    },
  ];

  for (const c of cases) {
    test(`${c.name} is ${c.local ? "readable" : "withheld"} at local reach`, () => {
      expect(isRemotelyReadable(c.tags, TRANSPORT_REACH.local)).toBe(c.local);
    });
    test(`${c.name} is ${c.remote ? "readable" : "withheld"} at remote reach`, () => {
      expect(isRemotelyReadable(c.tags, TRANSPORT_REACH.remote)).toBe(c.remote);
    });
  }
});

describe("the predicate is independent of the caller's requested scope", () => {
  /**
   * The caller argument keeps narrowing and can no longer lift: a scope
   * naming the reserved token satisfies `isVisible` and is still withheld
   * at remote reach.
   */
  test("a requested scope naming the reserved token does not lift it", () => {
    const tags = pageVisibility({ visibility: [REMOTE_DENY_VISIBILITY_TOKEN] });
    const scope = normalizeVisibilityScope([REMOTE_DENY_VISIBILITY_TOKEN]);
    expect(isVisible(tags, scope)).toBe(true);
    expect(isRemotelyReadable(tags, TRANSPORT_REACH.remote)).toBe(false);
  });

  test("a non-reserved token still needs the caller to ask for it", () => {
    const tags = pageVisibility({ visibility: [ORDINARY_TOKEN] });
    expect(isRemotelyReadable(tags, TRANSPORT_REACH.remote)).toBe(true);
    expect(isVisible(tags, normalizeVisibilityScope([]))).toBe(false);
    expect(isVisible(tags, normalizeVisibilityScope([ORDINARY_TOKEN]))).toBe(true);
  });
});
