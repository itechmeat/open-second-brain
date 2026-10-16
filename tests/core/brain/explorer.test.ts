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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildBacklinkIndex, backlinkCount } from "../../../src/core/brain/backlinks.ts";
import {
  buildLiveServer,
  collectExplorerData,
  EXPLORER_SCHEMA_VERSION,
  renderExportedHtml,
} from "../../../src/core/brain/explorer.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { emitRecallTelemetry } from "../../../src/core/brain/recall-telemetry.ts";
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
      basePref("conf", {
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        applied_count: 5,
        confidence: BRAIN_CONFIDENCE.high,
      }),
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
    const ids = g.nodes.map((n) => n.id).toSorted();
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
    const e = supersedesEdges.find((x) => x.source === "pref-new" && x.target === "ret-old");
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
    const bToA = wlEdges.find((e) => e.source === "pref-b" && e.target === "pref-a");
    expect(bToA).toBeDefined();
    // No edge to the signal — sig-foo is not in the node set.
    expect(g.edges.find((e) => e.target === "sig-foo")).toBeUndefined();
    // No edge to a non-existent target.
    expect(g.edges.find((e) => e.target === "pref-nope")).toBeUndefined();
  });

  test("typed semantics metadata projects onto explorer nodes and edges", () => {
    writePreference(vault, basePref("base"));
    writePreference(
      vault,
      basePref("semantic", {
        memory_layer: "L2",
        memory_branch: "research",
        depends_on: ["[[pref-base]]"],
      }),
    );

    const g = collectExplorerData(vault);
    const node = g.nodes.find((n) => n.id === "pref-semantic");
    expect(node).toBeDefined();
    expect(node!.memory_layer).toBe("L2");
    expect(node!.memory_branch).toBe("research");

    const edge = g.edges.find((e) => e.source === "pref-semantic" && e.target === "pref-base");
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe("wikilink");
    expect(edge!.relation).toBe("depends_on");
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
    writePreference(vault, basePref("source1", { evidenced_by: ["[[pref-target]]"] }));
    writePreference(vault, basePref("source2", { evidenced_by: ["[[pref-target]]"] }));
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
    expect(prefIds).toEqual([...prefIds].toSorted());
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

describe("buildLiveServer JSON routes", () => {
  const REPORT_SNAPSHOTS_ENV = "OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS";
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env[REPORT_SNAPSHOTS_ENV];
    delete process.env[REPORT_SNAPSHOTS_ENV];
  });
  afterEach(() => {
    if (previousEnv === undefined) delete process.env[REPORT_SNAPSHOTS_ENV];
    else process.env[REPORT_SNAPSHOTS_ENV] = previousEnv;
  });

  test("serves /counts.json from the console collector, re-read per GET", async () => {
    emitRecallTelemetry(vault, {
      host: "unit-test",
      channel: "cli",
      mode: "search",
      status: "ok",
      durationMs: 1,
      resultCount: 1,
      topArtifacts: [{ id: "pref-seed" }],
    });
    const server = buildLiveServer(vault, 0);
    try {
      const first = await fetch(new URL("/counts.json", server.url));
      expect(first.ok).toBe(true);
      const body = JSON.parse(await first.text()) as {
        schema_version: number;
        telemetry: { total: number };
        written_per_day: ReadonlyArray<unknown>;
        report_snapshots: unknown;
      };
      expect(body.schema_version).toBe(1);
      expect(body.telemetry.total).toBe(1);
      expect(body.written_per_day.length).toBe(30);
      expect(body.report_snapshots).toEqual({ status: "disabled" });
      // A second GET re-reads: a record appended between requests is
      // visible without restarting the server.
      emitRecallTelemetry(vault, {
        host: "unit-test",
        channel: "cli",
        mode: "query",
        status: "empty",
        durationMs: 1,
        resultCount: 0,
      });
      const second = await fetch(new URL("/counts.json", server.url));
      const again = JSON.parse(await second.text()) as { telemetry: { total: number } };
      expect(again.telemetry.total).toBe(2);
    } finally {
      await server.close();
    }
  });

  test("serves /status.json from the operator snapshot with configPath threaded through", async () => {
    writePreference(vault, basePref("routed"));
    // The active profile is read from the profiles registry beside the
    // config path, so it is the observable for the additive options
    // object reaching buildOperatorSnapshot.
    const configPath = join(vault, "config.yaml");
    writeFileSync(
      join(vault, "profiles.json"),
      JSON.stringify({ active: "work", profiles: { work: { vault } } }),
    );
    const server = buildLiveServer(vault, 0, { configPath });
    try {
      const res = await fetch(new URL("/status.json", server.url));
      expect(res.ok).toBe(true);
      const body = JSON.parse(await res.text()) as {
        activeProfile: string | null;
        healthy: boolean;
        counts: { preferences: number };
      };
      expect(body.activeProfile).toBe("work");
      expect(typeof body.healthy).toBe("boolean");
      expect(body.counts.preferences).toBe(1);
    } finally {
      await server.close();
    }
    // Without the options object no config path reaches the snapshot,
    // so the profile lookup reads as none.
    const bare = buildLiveServer(vault, 0);
    try {
      const res = await fetch(new URL("/status.json", bare.url));
      const body = JSON.parse(await res.text()) as { activeProfile: string | null };
      expect(body.activeProfile).toBeNull();
    } finally {
      await bare.close();
    }
  });

  test("unknown routes still answer 404", async () => {
    const server = buildLiveServer(vault, 0);
    try {
      const res = await fetch(new URL("/nope.json", server.url));
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  test("a broken counts section surfaces by name as a 500 JSON error", async () => {
    // With snapshots enabled the collector lists Brain/reports; a FILE
    // parked at that path makes the listing throw, and the route must
    // answer with the error message rather than an empty payload.
    process.env[REPORT_SNAPSHOTS_ENV] = "true";
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(join(vault, "Brain", "reports"), "not a directory");
    const server = buildLiveServer(vault, 0);
    try {
      const res = await fetch(new URL("/counts.json", server.url));
      expect(res.status).toBe(500);
      const body = JSON.parse(await res.text()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("reports");
    } finally {
      await server.close();
    }
  });

  test("a non-loopback Host header is refused with a named 403 on every route", async () => {
    // The loopback BIND is not a browser boundary: a DNS-rebinding page
    // resolves an attacker hostname to 127.0.0.1 and the request arrives
    // carrying that hostname. The server itself must refuse it, on the
    // graph route and the new JSON routes alike.
    const server = buildLiveServer(vault, 0);
    try {
      const refusedOn = async (route: string): Promise<{ status: number; error: string }> => {
        const res = await fetch(new URL(route, server.url), {
          headers: { host: "attacker.example" },
        });
        const body = JSON.parse(await res.text()) as { error: string };
        return { status: res.status, error: body.error };
      };
      const forHtml = await refusedOn("/");
      expect(forHtml.status).toBe(403);
      expect(forHtml.error).toContain("loopback");
      const forGraph = await refusedOn("/data.json");
      expect(forGraph.status).toBe(403);
      expect(forGraph.error).toContain("loopback");
      const forCounts = await refusedOn("/counts.json");
      expect(forCounts.status).toBe(403);
      expect(forCounts.error).toContain("loopback");
      const forStatus = await refusedOn("/status.json");
      expect(forStatus.status).toBe(403);
      expect(forStatus.error).toContain("loopback");
    } finally {
      await server.close();
    }
  });

  test("a loopback Host name with any port is accepted", async () => {
    writePreference(vault, basePref("hosted"));
    const server = buildLiveServer(vault, 0);
    try {
      const servedWith = async (host: string): Promise<number> => {
        const res = await fetch(new URL("/counts.json", server.url), {
          headers: { host },
        });
        const body = JSON.parse(await res.text()) as { schema_version: number };
        return res.ok ? body.schema_version : -1;
      };
      // The default request already carries 127.0.0.1:<port>.
      const direct = await fetch(new URL("/counts.json", server.url));
      expect(direct.ok).toBe(true);
      // The other loopback spellings, port included, are the allowlist.
      expect(await servedWith(`localhost:${server.port}`)).toBe(1);
      expect(await servedWith(`[::1]:${server.port}`)).toBe(1);
    } finally {
      await server.close();
    }
  });
});
