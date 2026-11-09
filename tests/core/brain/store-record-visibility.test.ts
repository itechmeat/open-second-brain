/**
 * The reach and ownership views judge a store record by its own partition
 * and fields once switched (task 2.10, design D14 item 18): a shared
 * preference is visible at remote reach like an open page, a private one
 * is not, and an owned one only to its owner. At local reach everything is
 * visible. The answers equal those an unswitched machine gives for the
 * same preferences written as pages.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ownerScopeView } from "../../../src/core/brain/owner-scope-view.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import {
  existingPreferencePageText,
  writePreferencePageText,
} from "../../../src/core/brain/preference-page-write.ts";
import { reachView } from "../../../src/core/brain/reach-view.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { formatFrontmatter, parseFrontmatterText } from "../../../src/core/vault.ts";
import { laneVaultRoot, writeLaneText } from "../../../src/core/store/lane-pages.ts";
import { makeStoreEnv } from "../store/fixtures/store-env.ts";
import { withMemoryFixture, type MemoryMode } from "./fixtures/memory-twins.ts";

const pref = (slug: string) => ({
  slug,
  topic: slug,
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-30T00:00:00Z",
  status: "unconfirmed" as const,
  evidenced_by: [] as string[],
});

/** Rewrite `pref-<slug>`'s page with `extra` frontmatter keys. */
function withKeys(vault: string, slug: string, extra: Record<string, string>): void {
  const text = existingPreferencePageText(vault, slug, (p) => readFileSync(p, "utf8"));
  if (text === null) throw new Error("no preference");
  const [meta, body] = parseFrontmatterText(text);
  writePreferencePageText(vault, slug, formatFrontmatter({ ...meta, ...extra }, body));
}

const REFS = ["pref-open", "pref-secret", "pref-owned", "[[pref-open]]", "pref-absent"];

function answers(mode: MemoryMode) {
  return withMemoryFixture(
    mode,
    (env) => {
      for (const slug of ["open", "secret", "owned"]) {
        writePreference(env.vault, pref(slug), { authority: "agent" });
      }
      withKeys(env.vault, "secret", { visibility: "private" });
      withKeys(env.vault, "owned", { owner: "alice" });
      const remote = reachView(env.vault, TRANSPORT_REACH.remote);
      const local = reachView(env.vault, TRANSPORT_REACH.local);
      const alice = ownerScopeView(env.vault, "alice");
      const bob = ownerScopeView(env.vault, "bob");
      return {
        remote: REFS.map((r) => remote.visible(r)),
        local: REFS.map((r) => local.visible(r)),
        alice: REFS.map((r) => alice.visible(r)),
        bob: REFS.map((r) => bob.visible(r)),
      };
    },
    { seed: false },
  );
}

describe("store record visibility", () => {
  const legacy = answers("legacy");
  const switched = answers("switched");

  test("remote reach: a shared record is visible, a private one is not", () => {
    expect(switched.remote).toEqual([true, false, true, true, true]);
  });

  test("local reach: every record is visible", () => {
    expect(switched.local).toEqual([true, true, true, true, true]);
  });

  test("owner scope: an owned record only to its owner", () => {
    expect(switched.alice).toEqual([true, true, true, true, true]);
    expect(switched.bob).toEqual([true, true, false, true, true]);
  });

  test("the answers equal the unswitched machine's for the same pages", () => {
    expect(switched).toEqual(legacy);
  });
});

describe("store record visibility with no vault", () => {
  test("a retired private preference spelled pref-x is hidden; lane pages by their record", () => {
    const env = makeStoreEnv("osb-visibility-novault-", {
      legacyTree: false,
      configureVault: false,
    });
    try {
      const written = writePreference(
        null,
        { ...pref("hush"), principle: "keep <private>this</private> to me" },
        { authority: "agent" },
      );
      moveToRetired(null, written.path, "stale-no-evidence", {
        now: new Date("2026-11-07T12:00:00Z"),
        retired_by: "@t",
      });
      const root = laneVaultRoot(null);
      writeLaneText(
        root,
        join(root, "Brain", "decisions", "open.md"),
        "---\nkind: d\n---\nOpen.\n",
      );
      writeLaneText(
        root,
        join(root, "Brain", "decisions", "held.md"),
        "---\nkind: d\nvisibility: [private]\n---\nHeld.\n",
      );
      const remote = reachView(null, TRANSPORT_REACH.remote);
      expect(remote.visible("[[ret-hush]]")).toBe(false);
      expect(remote.visible("[[pref-hush]]")).toBe(false);
      expect(remote.visible("Brain/decisions/open.md")).toBe(true);
      expect(remote.visible("Brain/decisions/held.md")).toBe(false);
      expect(remote.visible("Brain/decisions/gone.md")).toBe(false);
      expect(remote.visible("tension-unknown")).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("lane pages follow each view's own rule: reach, owner scope, containment", () => {
    const env = makeStoreEnv("osb-visibility-novault-lanes-", {
      legacyTree: false,
      configureVault: false,
    });
    try {
      const root = laneVaultRoot(null);
      writeLaneText(
        root,
        join(root, "Brain", "decisions", "held.md"),
        "---\nkind: d\nvisibility: [private]\n---\nHeld.\n",
      );
      writeLaneText(
        root,
        join(root, "Brain", "decisions", "bobs.md"),
        "---\nkind: d\nowner: bob\n---\nBob's.\n",
      );
      // A private page is readable at local reach, as a private record is.
      expect(reachView(null, TRANSPORT_REACH.local).visible("Brain/decisions/held.md")).toBe(true);
      // Another scope's page is hidden from alice, shown to bob.
      expect(ownerScopeView(null, "alice").visible("Brain/decisions/bobs.md")).toBe(false);
      expect(ownerScopeView(null, "bob").visible("Brain/decisions/bobs.md")).toBe(true);
      // A reference that climbs out of Brain/ names no lane page.
      writeFileSync(join(env.parent, "outside.md"), "---\nkind: d\n---\nOutside.\n");
      const climb = `Brain/${relative(join(root, "Brain"), join(env.parent, "outside.md"))
        .split(sep)
        .join("/")}`;
      expect(climb).toContain("..");
      expect(reachView(null, TRANSPORT_REACH.remote).visible(climb)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
