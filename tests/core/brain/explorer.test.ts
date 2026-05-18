/**
 * Tests for the §14 explorer data collector. We exercise:
 *   - empty Brain → empty graph
 *   - mixed preferences (unconfirmed, confirmed, quarantine) plus
 *     retired entries appear as nodes with the expected status
 *   - supersedes edges from `superseded_by`
 *   - inline wikilink edges from body / frontmatter dedup
 *   - signal / log refs are filtered out of the edge list
 *   - byte-identical JSON across two runs on the same vault
 *   - legacy `confidence_value: null` surfaces as `null` (not zero)
 *   - `backlink_count` matches the index in `backlinks.ts`
 *
 * The render side (template + JSON inlining) gets its own task.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  buildBacklinkIndex,
  backlinkCount,
} from "../../../src/core/brain/backlinks.ts";
import {
  collectExplorerData,
  EXPLORER_SCHEMA_VERSION,
  renderExportedHtml,
} from "../../../src/core/brain/explorer.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-explorer-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: slug,
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence: BRAIN_CONFIDENCE.low,
    confidence_value: 0,
    pinned: false,
    ...overrides,
  };
}

describe("collectExplorerData", () => {
  test("empty Brain → 0 nodes, 0 edges, schema_version 1", () => {
    const g = collectExplorerData(vault);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.schema_version).toBe(1);
    expect(EXPLORER_SCHEMA_VERSION).toBe(1);
    expect(typeof g.generated_at).toBe("string");
  });

  test("nodes include confirmed, unconfirmed, quarantine, retired", () => {
    writePreference(
      vault,
      basePref("conf", { status: BRAIN_PREFERENCE_STATUS.confirmed, applied_count: 5, confidence: BRAIN_CONFIDENCE.high }),
    );
    writePreference(
      vault,
      basePref("trial", {
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
      }),
    );
    writePreference(
      vault,
      basePref("quar", {
        status: BRAIN_PREFERENCE_STATUS.quarantine,
        applied_count: 2,
        violated_count: 3,
      }),
    );
    // Create a fourth pref and retire it.
    writePreference(vault, basePref("dead"));
    const deadPath = join(vault, "Brain", "preferences", "pref-dead.md");
    moveToRetired(vault, deadPath, BRAIN_RETIRED_REASON.staleNoEvidence, {
      now: new Date("2026-05-10T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-10]]",
    });

    const g = collectExplorerData(vault);
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["pref-conf", "pref-quar", "pref-trial", "ret-dead"]);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get("pref-conf")!.status).toBe("confirmed");
    expect(byId.get("pref-trial")!.status).toBe("unconfirmed");
    expect(byId.get("pref-quar")!.status).toBe("quarantine");
    expect(byId.get("ret-dead")!.status).toBe("retired");
    expect(byId.get("ret-dead")!.kind).toBe("retired");
    expect(byId.get("pref-conf")!.kind).toBe("preference");
  });

  test("supersedes edge: from a pref pointing at a retired", () => {
    // First, write a base pref and retire it.
    writePreference(vault, basePref("old", { topic: "shared" }));
    moveToRetired(
      vault,
      join(vault, "Brain", "preferences", "pref-old.md"),
      BRAIN_RETIRED_REASON.rebutted,
      {
        now: new Date("2026-05-05T00:00:00Z"),
        retired_by: "[[Brain/log/2026-05-05]]",
      },
    );
    // Then write a successor that names the retired pref via `supersedes`.
    writePreference(
      vault,
      basePref("new", {
        topic: "shared",
        supersedes: "[[ret-old]]",
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        confirmed_at: null,
      }),
    );
    const g = collectExplorerData(vault);
    const supersedesEdges = g.edges.filter((e) => e.kind === "supersedes");
    expect(supersedesEdges.length).toBeGreaterThanOrEqual(1);
    const e = supersedesEdges.find(
      (x) => x.source === "pref-new" && x.target === "ret-old",
    );
    expect(e).toBeDefined();
  });

  test("wikilink edges between preferences land as kind 'wikilink'; signal refs excluded", () => {
    writePreference(vault, basePref("a"));
    // Cross-pref wikilink via `evidenced_by` — `principle` is a
    // frontmatter field, not body content, so wikilinks inside it
    // do not feed the backlink index. Real cross-pref refs in this
    // project flow through `evidenced_by`, `supersedes`, or body
    // sections.
    writePreference(
      vault,
      basePref("b", {
        evidenced_by: ["[[pref-a]]", "[[sig-foo]]"],
      }),
    );
    const g = collectExplorerData(vault);
    const wlEdges = g.edges.filter((e) => e.kind === "wikilink");
    const bToA = wlEdges.find(
      (e) => e.source === "pref-b" && e.target === "pref-a",
    );
    expect(bToA).toBeDefined();
    // No edge to the signal — sig-foo is not in the node set.
    expect(g.edges.find((e) => e.target === "sig-foo")).toBeUndefined();
    // No edge to a non-existent target.
    expect(g.edges.find((e) => e.target === "pref-nope")).toBeUndefined();
  });

  test("output is byte-identical across two runs (modulo generated_at)", () => {
    writePreference(vault, basePref("alpha", { applied_count: 2 }));
    writePreference(vault, basePref("beta"));
    const g1 = collectExplorerData(vault);
    const g2 = collectExplorerData(vault);
    // Strip the timestamp before comparing.
    const stripped = (g: { generated_at: string }): string =>
      JSON.stringify({ ...g, generated_at: "" });
    expect(stripped(g1)).toBe(stripped(g2));
  });

  test("legacy null confidence_value surfaces as null, not zero", () => {
    // `writePreference` with `confidence_value: null` writes the
    // legacy on-disk shape that pre-v0.10.3 dream passes left behind.
    writePreference(
      vault,
      basePref("legacy", {
        applied_count: 1,
        last_evidence_at: null,
        confidence: BRAIN_CONFIDENCE.low,
        confidence_value: null,
      }),
    );
    const g = collectExplorerData(vault);
    const node = g.nodes.find((n) => n.id === "pref-legacy");
    expect(node).toBeDefined();
    expect(node!.confidence_value).toBeNull();
  });

  test("backlink_count matches buildBacklinkIndex output", () => {
    writePreference(vault, basePref("target"));
    // Two sources, both reaching target via `evidenced_by` (the
    // canonical inter-pref reference field).
    writePreference(
      vault,
      basePref("source1", { evidenced_by: ["[[pref-target]]"] }),
    );
    writePreference(
      vault,
      basePref("source2", { evidenced_by: ["[[pref-target]]"] }),
    );
    const g = collectExplorerData(vault);
    const node = g.nodes.find((n) => n.id === "pref-target");
    const expected = backlinkCount(buildBacklinkIndex(vault), "pref-target");
    expect(node!.backlink_count).toBe(expected);
    expect(node!.backlink_count).toBeGreaterThanOrEqual(2);
  });

  test("vault_basename equals the last path segment", () => {
    const g = collectExplorerData(vault);
    expect(g.vault_basename).toBe(basename(vault));
  });

  test("stable ordering: nodes by (kind, id); edges by (source, target, kind)", () => {
    writePreference(vault, basePref("b-pref"));
    writePreference(vault, basePref("a-pref"));
    writePreference(vault, basePref("c-pref"));
    moveToRetired(
      vault,
      join(vault, "Brain", "preferences", "pref-c-pref.md"),
      BRAIN_RETIRED_REASON.rebutted,
      {
        now: new Date("2026-05-10T00:00:00Z"),
        retired_by: "[[Brain/log/2026-05-10]]",
      },
    );
    const g = collectExplorerData(vault);
    // Preferences come first (kind 'preference' < 'retired' lexically),
    // then retired. Within each kind, ids ascend.
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toEqual(["preference", "preference", "retired"]);
    const prefIds = g.nodes.filter((n) => n.kind === "preference").map((n) => n.id);
    expect(prefIds).toEqual([...prefIds].sort());
  });
});

describe("renderExportedHtml", () => {
  test("substitutes the placeholder exactly once with parseable JSON", () => {
    writePreference(vault, basePref("foo"));
    const g = collectExplorerData(vault);
    const html = renderExportedHtml(g);
    expect(html.includes("__GRAPH_JSON__")).toBe(false);
    const match = html.match(
      /<script type="application\/json" id="brain-data">([\s\S]+?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!);
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBe(1);
    expect(parsed.nodes[0].id).toBe("pref-foo");
  });

  test("survives `$` in principle bodies (no $&/$1 injection)", () => {
    writePreference(
      vault,
      basePref("dollars", {
        principle: "Money is $100 or $$abc — keep this exact",
      }),
    );
    const g = collectExplorerData(vault);
    const html = renderExportedHtml(g);
    const match = html.match(
      /<script type="application\/json" id="brain-data">([\s\S]+?)<\/script>/,
    );
    const parsed = JSON.parse(match![1]!);
    const node = parsed.nodes.find((n: { id: string }) => n.id === "pref-dollars");
    expect(node.principle).toBe("Money is $100 or $$abc — keep this exact");
  });

  test("escapes script-closing text in inline JSON", () => {
    writePreference(
      vault,
      basePref("script-close", {
        principle: "Never let </script><script>bad()</script> split the data block",
      }),
    );
    const g = collectExplorerData(vault);
    const html = renderExportedHtml(g);
    expect(html).not.toContain("</script><script>bad()");
    const match = html.match(
      /<script type="application\/json" id="brain-data">([\s\S]+?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!);
    const node = parsed.nodes.find((n: { id: string }) => n.id === "pref-script-close");
    expect(node.principle).toBe("Never let </script><script>bad()</script> split the data block");
  });

  // §14 polish (v0.10.6) — the keyboard-accessible listbox markup and
  // localStorage hooks must travel with every exported HTML body.
  // These tests guard against accidental DOM removal during future
  // template edits.
  test("template ships keyboard-accessible listbox markup", () => {
    writePreference(vault, basePref("a11y"));
    const html = renderExportedHtml(collectExplorerData(vault));
    expect(html).toContain('id="node-list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-activedescendant=""');
    expect(html).toContain('id="reset-layout"');
    expect(html).toContain('id="details-body"');
  });

  test("template wires localStorage layout persistence", () => {
    writePreference(vault, basePref("store"));
    const html = renderExportedHtml(collectExplorerData(vault));
    expect(html).toContain("osb-explorer-layout:");
    expect(html).toContain("STORAGE_KEY");
    expect(html).toContain("saveLayout");
  });

  // Smoke guard against the v0.10.6 regression where the simplify
  // pass dropped `focusedNodeId` and `visibleNodesSorted()` but left
  // the keyboard-handler callsites pointing at them (Home / End /
  // Enter / Space threw ReferenceError at runtime). Without a JS
  // execution test, this regex check is the cheapest way to keep
  // the rename honest.
  test("keyboard handlers reference only live identifiers", () => {
    writePreference(vault, basePref("kb"));
    const html = renderExportedHtml(collectExplorerData(vault));
    expect(html).not.toContain("visibleNodesSorted(");
    expect(html).not.toContain("focusedNodeId");
    // The cache + canonical selection variable must both be present
    // because the handlers consume them.
    expect(html).toContain("visibleSortedCache");
    expect(html).toContain("selectedId");
  });
});
