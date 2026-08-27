/**
 * Root B: the vault page walker honours the reserved visibility token
 * (private-is-not-a-suggestion, unit 4).
 *
 * `listVaultPages` is the second of the three roots every callable
 * surface reaches page content through. It already parses each page's
 * frontmatter, so the decision costs no extra read - the shape
 * `vaultPageInStatusScope` established for entity status.
 *
 * The reach is a REQUIRED option rather than a defaulted one: an internal
 * maintenance lane that quietly stopped seeing reserved pages would
 * corrupt the graph it repairs, and a read surface that quietly saw them
 * would be the boundary failing. Neither is a decision to make by
 * omission.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
import { listVaultPages } from "../../../src/core/vault.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "list-vault-pages-vis-"));
  writeFileSync(join(vault, "open.md"), "---\ntitle: Open\n---\n\nordinary body");
  writeFileSync(
    join(vault, "reserved.md"),
    `---\ntitle: Reserved\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\nreserved body`,
  );
  writeFileSync(join(vault, "team.md"), "---\ntitle: Team\nvisibility: [team]\n---\n\nteam body");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function titles(reach: (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH]): string[] {
  return listVaultPages(vault, { reach })
    .map((p) => p.title)
    .toSorted();
}

describe("listVaultPages", () => {
  test("withholds a page carrying the reserved token at remote reach", () => {
    expect(titles(TRANSPORT_REACH.remote)).toEqual(["Open", "Team"]);
  });

  test("lists every page at local reach", () => {
    expect(titles(TRANSPORT_REACH.local)).toEqual(["Open", "Reserved", "Team"]);
  });

  test("leaves a non-reserved token alone at both reaches", () => {
    // Non-reserved tokens keep exactly today's caller-liftable scoping
    // semantics; this walker defines no policy for them.
    for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote]) {
      expect(titles(reach)).toContain("Team");
    }
  });

  test("a vault that never wrote the token is identical at both reaches", () => {
    rmSync(join(vault, "reserved.md"));
    expect(titles(TRANSPORT_REACH.remote)).toEqual(titles(TRANSPORT_REACH.local));
  });
});

// --- The unmeasurable page: one rule, one fail direction ---------------------
//
// The three roots have to agree about the page they cannot read. Roots A
// and C substitute the reserved token for it (`isPathReadableAtReach`);
// root B used to read its empty parsed map as "declares nothing" and
// admit it at remote reach, which is the same rule failing in two
// directions on the same input.

describe("a page whose file cannot be read", () => {
  const unreadable = (): string => {
    const path = join(vault, "unreadable.md");
    writeFileSync(path, "---\ntitle: Unreadable\n---\n\nbody");
    chmodSync(path, 0o000);
    return path;
  };

  test("is withheld at remote reach, exactly as a reserved page is", () => {
    const path = unreadable();
    try {
      const titles = listVaultPages(vault, { reach: TRANSPORT_REACH.remote }).map((p) => p.title);
      expect(titles).not.toContain("unreadable");
      expect(titles).not.toContain("Unreadable");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("is kept at local reach, where the caller can open the file itself", () => {
    const path = unreadable();
    try {
      const titles = listVaultPages(vault, { reach: TRANSPORT_REACH.local }).map((p) => p.title);
      expect(titles).toContain("unreadable");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("a readable untagged page is unaffected at both reaches", () => {
    for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote] as const) {
      expect(listVaultPages(vault, { reach }).map((p) => p.title)).toContain("Open");
    }
  });
});
