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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
