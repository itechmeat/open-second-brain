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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { isPathReadableAtReach } from "../../../src/core/search/result-filters.ts";
import { listVaultPages } from "../../../src/core/vault.ts";

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

// --- The informal marker at the two path roots -------------------------------
//
// `access: private` and its siblings are not visibility tokens (see
// graph/privacy-markers.ts): no caller scope can name them, and they never
// enter `pageVisibility`. What they do is reserve the page against a remote
// read, at the same two roots that enforce the reserved token - the by-path
// verdict (`isPathReadableAtReach`, root A/C) and the vault walk
// (`listVaultPages`, root B).

describe("an informal privacy marker at the read roots", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "remote-readability-"));
    writeFileSync(join(vault, "open.md"), "---\ntitle: Open\n---\n\nordinary body");
    writeFileSync(
      join(vault, "access.md"),
      "---\ntitle: Access\ntags: [imported]\naccess: private\n---\n\nmarked body",
    );
    writeFileSync(
      join(vault, "confidentiality.md"),
      "---\ntitle: Confidentiality\nconfidentiality: [Secret]\n---\n\nmarked body",
    );
    writeFileSync(
      join(vault, "sensitivity.md"),
      "---\ntitle: Sensitivity\nsensitivity: confidential\nvisibility: [team]\n---\n\nmarked body",
    );
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  const readable = (rel: string, reach: (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH]) =>
    isPathReadableAtReach(vault, rel, reach, new Map());

  test("a marker-only page is withheld by path at remote reach", () => {
    expect(readable("access.md", TRANSPORT_REACH.remote)).toBe(false);
    expect(readable("confidentiality.md", TRANSPORT_REACH.remote)).toBe(false);
  });

  test("a marker-only page stays readable by path at local reach", () => {
    // Local reach is byte-identical to before the marker rule: the
    // operator can open the file directly anyway.
    for (const rel of ["open.md", "access.md", "confidentiality.md", "sensitivity.md"]) {
      expect(readable(rel, TRANSPORT_REACH.local)).toBe(true);
    }
  });

  test("a marker beside a caller-liftable token is still remote-denied", () => {
    // `visibility: [team]` would be readable at remote reach on its own;
    // the marker dominates, exactly as the reserved token does.
    expect(readable("sensitivity.md", TRANSPORT_REACH.remote)).toBe(false);
  });

  test("an unmarked non-reserved page keeps today's verdict at both reaches", () => {
    expect(readable("open.md", TRANSPORT_REACH.remote)).toBe(true);
    expect(readable("open.md", TRANSPORT_REACH.local)).toBe(true);
  });

  test("the indexed tokens are honoured beside a marker in the file", () => {
    // Either measurement reserving the page withholds it; the index
    // decides for bytes captured while reserved.
    expect(
      isPathReadableAtReach(vault, "open.md", TRANSPORT_REACH.remote, new Map(), [
        REMOTE_DENY_VISIBILITY_TOKEN,
      ]),
    ).toBe(false);
  });

  test("listVaultPages withholds every marker page at remote reach", () => {
    const titles = listVaultPages(vault, { reach: TRANSPORT_REACH.remote }).map((p) => p.title);
    expect(titles.toSorted()).toEqual(["Open"]);
  });

  test("listVaultPages keeps every page at local reach, marker or not", () => {
    const titles = listVaultPages(vault, { reach: TRANSPORT_REACH.local }).map((p) => p.title);
    expect(titles.toSorted()).toEqual(["Access", "Confidentiality", "Open", "Sensitivity"]);
  });
});
