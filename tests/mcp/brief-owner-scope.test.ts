/**
 * The `brain_brief` views that build their envelopes themselves - daily,
 * weekly, monthly and today - answer at the caller's enforced ownership
 * scope, not at the transport reach alone.
 *
 * The digest and morning views thread `agent_scope` through their
 * builders, and `monthly`/`today` reach the ownership rule through the
 * request's readable predicate. The daily and weekly envelopes had no
 * such seam at local reach: the per-request row view short-circuited at
 * `TRANSPORT_REACH.local` and returned the builder's own envelope, so
 * under `integrity.owner_scope_delivery: fail` a caller with an enforced
 * identity received another owner's preference ids, transition reasons
 * and source pointers from `retired`, `contradictions` and
 * `status_transitions` while every section beside them was already
 * narrowed.
 *
 * The report snapshot follows the same rule: a caller the enforced scope
 * narrows renders one owner's slice, so it neither takes a snapshot of
 * that slice under the shared date key nor is shown a delta whose key
 * paths were computed against another caller's render - the same
 * position a reader below local reach is already in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { renderDigest } from "../../src/core/brain/digest.ts";
import { brainConfigPath, brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { GATE_MODE } from "../../src/core/integrity/stamp.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { readResource } from "../../src/mcp/resources.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
/** The private page: delivered to its owner, withheld from every other scope. */
const OWNED_BY_A = "owned-by-a";
/** The ownerless page: delivered to every scope, so a scoped answer is never empty. */
const SHARED = "shared";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-brief-owner-scope-"));
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function setGate(mode: string | null): void {
  const body = mode === null ? "" : `integrity:\n  owner_scope_delivery: ${mode}\n`;
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

function makePref(slug: string, owner?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
  });
}

function log(
  timestamp: string,
  eventType: string,
  body: Record<string, unknown>,
  agent?: string,
): void {
  appendLogEvent(
    vault,
    { timestamp, eventType, ...(agent !== undefined ? { agent } : {}), body } as Parameters<
      typeof appendLogEvent
    >[1],
    { deviceId: "" },
  );
}

/**
 * Two preferences and the events that name them: a dream confirming both
 * and retiring the private one (a promotion and a retirement row each),
 * plus violated evidence on the private one (a contradiction row and a
 * source pointer naming its artifact).
 */
function seedTwoOwnerActivity(): string {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  makePref(SHARED);
  // Written while no gate is set, so the owner is the one this fixture
  // states rather than one a write-time gate stamped.
  makePref(OWNED_BY_A, OWNER_A);
  log(recent, BRAIN_LOG_EVENT_KIND.dream, {
    run_id: `run-${recent}`,
    confirmed: [`[[pref-${SHARED}|rule]]`, `[[pref-${OWNED_BY_A}|rule]]`],
    retired: [`[[ret-${OWNED_BY_A}|rule]] (superseded-by-context)`],
  });
  log(recent, BRAIN_LOG_EVENT_KIND.applyEvidence, {
    path: `Brain/preferences/pref-${OWNED_BY_A}.md`,
    preference: `[[pref-${OWNED_BY_A}]]`,
    artifact: `[[Notes/${OWNED_BY_A}-violated]]`,
    result: "violated",
  });
  return recent;
}

const BRIEF = buildToolTable("full").find((t) => t.name === "brain_brief") as ToolDefinition;

function ctx(agentName?: string): ServerContext {
  return { vault, configPath: null, repoRoot: null, agentName, reach: TRANSPORT_REACH.local };
}

async function call(
  args: Record<string, unknown>,
  agentName?: string,
): Promise<Record<string, unknown>> {
  return (await BRIEF.handler(ctx(agentName), args)) as Record<string, unknown>;
}

/** `value` as JSON with the per-render stamp fields replaced. */
function stableText(value: unknown): string {
  return JSON.stringify(value)
    .replace(/"generated_at":"[^"]*"/g, '"generated_at":"<T>"')
    .replace(/"local_time":"[^"]*"/g, '"local_time":"<T>"');
}

interface TransitionRow {
  readonly kind: string;
  readonly prefId: string;
}

describe("brain_brief views honour the caller's enforced owner scope", () => {
  const weekEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  // A pinned instant one hour ahead, so the digest's window ([until-24h,
  // until]) covers the fixtures' now-1h events and the rendered markdown
  // carries no moving timestamp between two calls.
  const digestUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  test("view=weekly hides another owner's rows under fail and keeps the caller's own", async () => {
    seedTwoOwnerActivity();
    setGate(GATE_MODE.fail);

    const asB = await call({ view: "weekly", week_end: weekEnd }, OWNER_B);
    expect(stableText(asB)).not.toContain(OWNED_BY_A);
    // The shared half still travels, so the absence is the ownership rule
    // and not an empty window.
    expect(stableText(asB)).toContain(`pref-${SHARED}`);
    expect(asB["retired"]).toEqual([]);
    expect(asB["contradictions"]).toEqual([]);
    expect(asB["source_pointers"]).toEqual([]);
    expect((asB["status_transitions"] as TransitionRow[]).map((t) => t.prefId)).toEqual([
      `pref-${SHARED}`,
    ]);
    // The counts are recomputed from the same selection, so the withheld
    // rows move none of them.
    expect(asB["events_by_kind"]).toEqual({ dream: 1 });
    expect(asB["vault_delta"]).toMatchObject({ newPromotions: 1, newRetired: 0 });

    // No over-filtering: its own owner still sees every row.
    const asA = await call({ view: "weekly", week_end: weekEnd }, OWNER_A);
    expect((asA["retired"] as Array<{ prefId: string }>).map((r) => r.prefId)).toEqual([
      `ret-${OWNED_BY_A}`,
    ]);
    expect(stableText(asA)).toContain(OWNED_BY_A);
  });

  test("view=daily hides another owner's rows under fail and keeps the caller's own", async () => {
    seedTwoOwnerActivity();
    setGate(GATE_MODE.fail);

    const asB = await call({ view: "daily" }, OWNER_B);
    expect(stableText(asB)).not.toContain(OWNED_BY_A);
    expect(asB["source_pointers"]).toEqual([]);
    expect((asB["status_transitions"] as TransitionRow[]).map((t) => t.prefId)).toEqual([
      `pref-${SHARED}`,
    ]);
    expect(asB["vault_delta"]).toMatchObject({ newPromotions: 1, newRetired: 0 });

    const asA = await call({ view: "daily" }, OWNER_A);
    expect(stableText(asA)).toContain(OWNED_BY_A);
    expect((asA["status_transitions"] as TransitionRow[]).map((t) => t.prefId)).toContain(
      `pref-${OWNED_BY_A}`,
    );
  });

  test("view=monthly counts only the events the caller may see under fail", async () => {
    seedTwoOwnerActivity();
    setGate(GATE_MODE.fail);

    const asB = (await call({ view: "monthly", month }, OWNER_B))["summary"] as Record<
      string,
      number
    >;
    // The dream is shared by construction, so it stays with the private
    // transitions trimmed out; the violated evidence is dropped whole.
    expect(asB).toMatchObject({ events: 1, status_transitions: 1, retired: 0, contradictions: 0 });

    const asA = (await call({ view: "monthly", month }, OWNER_A))["summary"] as Record<
      string,
      number
    >;
    expect(asA).toMatchObject({ events: 2, status_transitions: 3, retired: 1, contradictions: 1 });
  });

  test("view=today shows another owner's activity only to its owner under fail", async () => {
    seedTwoOwnerActivity();
    setGate(GATE_MODE.fail);

    const asB = await call({ view: "today" }, OWNER_B);
    expect(stableText(asB)).not.toContain(OWNED_BY_A);
    const activityB = asB["recent_activity"] as { total: number; bullets: string[] };
    expect(activityB.total).toBe(1);
    expect(activityB.bullets.join("\n")).toContain("confirmed=1");

    const asA = await call({ view: "today" }, OWNER_A);
    expect(stableText(asA)).toContain(OWNED_BY_A);
    expect((asA["recent_activity"] as { total: number }).total).toBe(2);
  });

  // The load-bearing convention of the delivery surfaces: a gate that
  // withholds nothing must change nothing, so a vault that never opted in
  // (or only set `warn`) is byte-identical whether or not an identity is
  // resolved.
  for (const mode of [null, GATE_MODE.off, GATE_MODE.warn] as const) {
    test(`a resolved identity changes no view under ${mode ?? "an absent gate"}`, async () => {
      seedTwoOwnerActivity();
      setGate(mode);

      const unscoped = {
        weekly: await call({ view: "weekly", week_end: weekEnd }),
        daily: await call({ view: "daily" }),
        monthly: await call({ view: "monthly", month }),
        today: await call({ view: "today" }),
        digest: await call({ view: "digest", until: digestUntil }),
      };
      // Not vacuous: the private rows really are on the unscoped envelopes.
      expect(stableText(unscoped.weekly)).toContain(OWNED_BY_A);
      expect(stableText(unscoped.digest)).toContain(OWNED_BY_A);

      const scoped = {
        weekly: await call({ view: "weekly", week_end: weekEnd }, OWNER_B),
        daily: await call({ view: "daily" }, OWNER_B),
        monthly: await call({ view: "monthly", month }, OWNER_B),
        today: await call({ view: "today" }, OWNER_B),
        digest: await call({ view: "digest", until: digestUntil }, OWNER_B),
      };
      expect(stableText(scoped.weekly)).toBe(stableText(unscoped.weekly));
      expect(stableText(scoped.daily)).toBe(stableText(unscoped.daily));
      expect(stableText(scoped.monthly)).toBe(stableText(unscoped.monthly));
      expect(stableText(scoped.today)).toBe(stableText(unscoped.today));
      expect(stableText(scoped.digest)).toBe(stableText(unscoped.digest));
    });
  }
});

// ----- the digest tool against the digest resource --------------------------

/**
 * One `## Heading` section of a digest markdown render, heading included:
 * the text from the heading through the line before the next one.
 */
function digestSection(digest: string, heading: string): string {
  const start = digest.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = digest.slice(start);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("brain_brief view=digest answers the same caller as the digest resource", () => {
  /**
   * The two-owner fixture whose rows the digest tool at local reach read
   * unfiltered: the retired record is a real file because
   * `connection_health` counts the retired directory directly, and the
   * events carry their author so `agent_summary` groups them per agent.
   */
  function seedDigestResourceFixture(): void {
    makePref(SHARED);
    makePref(OWNED_BY_A, OWNER_A);
    writeFileSync(
      join(brainDirs(vault).retired, `ret-${OWNED_BY_A}.md`),
      [
        "---",
        "kind: brain-retired",
        `id: ret-${OWNED_BY_A}`,
        `owner: ${OWNER_A}`,
        "created_at: 2026-05-01T00:00:00Z",
        "tags: []",
        `topic: ${OWNED_BY_A}`,
        "principle: retired private principle",
        "provenance: observed",
        "retired_at: 2026-05-03T00:00:00Z",
        `retired_by: "[[pref-${SHARED}]]"`,
        "retired_reason: superseded-by-context",
        "_status: retired",
        "_evidenced_by: []",
        "---",
        "",
        "retired.",
        "",
      ].join("\n"),
    );
    setGate(GATE_MODE.fail);
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i++) {
      log(
        recent,
        BRAIN_LOG_EVENT_KIND.applyEvidence,
        {
          path: `Brain/preferences/pref-${OWNED_BY_A}.md`,
          preference: `[[pref-${OWNED_BY_A}]]`,
          artifact: `[[Notes/${OWNED_BY_A}-applied-${i}]]`,
          result: "applied",
        },
        OWNER_A,
      );
    }
    log(
      recent,
      BRAIN_LOG_EVENT_KIND.applyEvidence,
      {
        path: `Brain/preferences/pref-${SHARED}.md`,
        preference: `[[pref-${SHARED}]]`,
        artifact: `[[Notes/${SHARED}-applied]]`,
        result: "applied",
      },
      OWNER_B,
    );
  }

  function digestResource(agentName: string): string {
    return readResource({ vault, agentName, reach: TRANSPORT_REACH.local }, "osb://digest/latest")
      .text;
  }

  test("at local reach under fail the tool's sections are the resource's", async () => {
    seedDigestResourceFixture();

    const toolMarkdown = String(
      (await call({ view: "digest", format: "markdown" }, OWNER_B))["content"],
    );
    const resourceMarkdown = digestResource(OWNER_B);

    // The sections whose rows and counts the unfiltered render filled from
    // the other owner's events and records must match, character for
    // character, what the resource hands the same caller.
    for (const heading of ["Agent summary", "Connection health", "Top referenced"]) {
      expect(digestSection(toolMarkdown, heading)).toBe(digestSection(resourceMarkdown, heading));
    }
    // Not vacuous: the caller's own activity and the shared record travel.
    expect(digestSection(toolMarkdown, "Agent summary")).toContain(OWNER_B);
    expect(digestSection(toolMarkdown, "Connection health")).toContain("Total nodes: 1");
    expect(digestSection(toolMarkdown, "Top referenced")).toContain(`pref-${SHARED}`);
    // The other owner's name and records are absent from the tool's answer.
    expect(toolMarkdown).not.toContain(OWNER_A);
    expect(toolMarkdown).not.toContain(OWNED_BY_A);
  });

  test("the scoped tool counts the caller's own events and none of the other owner's", async () => {
    seedDigestResourceFixture();

    const asB = JSON.parse(
      String((await call({ view: "digest", format: "json" }, OWNER_B))["content"]),
    );
    expect(asB["agent_summary"]).toEqual([
      {
        agent: OWNER_B,
        total_events: 1,
        feedback_count: 0,
        apply_evidence_count: 1,
        note_count: 0,
        confirmed_attributed: 0,
        retired_attributed: 0,
      },
    ]);
    // The shared preference is the only node left: the other owner's
    // retired record moves no count either.
    expect(asB["connection_health"]).toMatchObject({
      total_nodes: 1,
      linked_nodes: 1,
      orphan_nodes: 0,
    });

    // The records' own owner still counts both sides - the scope withholds,
    // it does not destroy: two preferences plus the retired record.
    const asA = JSON.parse(
      String((await call({ view: "digest", format: "json" }, OWNER_A))["content"]),
    );
    expect(asA["connection_health"]).toMatchObject({ total_nodes: 3 });
    expect((asA["agent_summary"] as ReadonlyArray<{ agent: string }>).map((r) => r.agent)).toEqual([
      OWNER_A,
      OWNER_B,
    ]);
  });

  test("an unscoped digest under fail stays byte-identical to the unfiltered render", async () => {
    seedDigestResourceFixture();
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const toolMarkdown = String((await call({ view: "digest", until }, undefined))["content"]);
    // Not vacuous: the unfiltered render really carries the other owner's rows.
    expect(toolMarkdown).toContain(OWNED_BY_A);
    // With no resolved identity nothing is narrowed, so the tool's render is
    // the renderer's own - the pre-gate output, byte for byte.
    expect(toolMarkdown).toBe(renderDigest(vault, { until: new Date(until) }).content);
  });
});

// ----- the report snapshot --------------------------------------------------

describe("the brain_brief report snapshots follow the caller's scope", () => {
  const savedSnapshots = process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"];

  beforeEach(() => {
    process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"] = "true";
  });
  afterEach(() => {
    if (savedSnapshots === undefined) delete process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"];
    else process.env["OPEN_SECOND_BRAIN_REPORT_SNAPSHOTS"] = savedSnapshots;
  });

  /** The date key the digest snapshots under for this fixture's pinned `until`. */
  function digestFile(until: string): string {
    return join(vault, "Brain", "reports", "digest", `${until.slice(0, 10)}.json`);
  }

  /**
   * A digest fixture whose rows are inside the window, so the snapshot
   * payload really carries both owners' ids.
   */
  function seedWindowDigest(): string {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const [slug, owner] of [
      [SHARED, undefined],
      [OWNED_BY_A, OWNER_A],
    ] as const) {
      writePreference(vault, {
        slug,
        topic: slug,
        principle: `principle for ${slug}`,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        unconfirmed_until: until,
        status: BRAIN_PREFERENCE_STATUS.unconfirmed,
        evidenced_by: [`[[sig-${slug}]]`],
        ...(owner !== undefined ? { owner } : {}),
      });
    }
    return until;
  }

  function snapshotPayload(until: string): string {
    return readFileSync(digestFile(until), "utf8");
  }

  test("a scoped caller takes no digest snapshot and is shown no delta", async () => {
    const until = seedWindowDigest();

    // The first, unscoped run is the shared record: full render, first
    // snapshot, no prior.
    const first = await call({ view: "digest", until }, undefined);
    expect((first["delta"] as { prior_date: string | null }).prior_date).toBeNull();
    expect(snapshotPayload(until)).toContain(OWNED_BY_A);

    // A caller the enforced scope narrows renders one owner's slice: it
    // neither persists that slice under the shared date key nor receives
    // a delta whose key paths were diffed against the full render.
    setGate(GATE_MODE.fail);
    const asB = await call({ view: "digest", until }, OWNER_B);
    expect(asB["delta"]).toBeUndefined();
    expect(stableText(asB)).not.toContain(OWNED_BY_A);
    const asA = await call({ view: "digest", until }, OWNER_A);
    expect(asA["delta"]).toBeUndefined();
    // Both scoped runs left the shared record exactly as the unscoped
    // run wrote it, so the next full render diffs against a full render.
    expect(snapshotPayload(until)).toContain(OWNED_BY_A);
    expect(JSON.parse(snapshotPayload(until))["payload"]["new_unconfirmed"]).toHaveLength(2);
  });

  test("a scoped caller still snapshots when the gate delivers everything", async () => {
    const until = seedWindowDigest();
    setGate(GATE_MODE.off);

    const first = await call({ view: "digest", until }, undefined);
    expect((first["delta"] as { prior_date: string | null }).prior_date).toBeNull();

    const scoped = await call({ view: "digest", until }, OWNER_B);
    // Under `off` nothing is narrowed, so the scoped run is an ordinary
    // one: it takes the snapshot and reports the (empty) delta.
    expect(scoped["delta"]).toMatchObject({ prior_date: null, added: [], removed: [] });
    expect(existsSync(digestFile(until))).toBe(true);
  });

  test("a scoped caller takes no daily or weekly snapshot either", async () => {
    seedTwoOwnerActivity();
    setGate(GATE_MODE.fail);

    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dailyAsB = await call({ view: "daily" }, OWNER_B);
    expect(dailyAsB["delta"]).toBeUndefined();
    const weeklyAsB = await call({ view: "weekly", week_end: until }, OWNER_B);
    expect(weeklyAsB["delta"]).toBeUndefined();

    // A later unscoped run is still the first: no scoped slice was
    // persisted for it to diff against.
    const dailyFull = await call({ view: "daily" }, undefined);
    expect((dailyFull["delta"] as { prior_date: string | null }).prior_date).toBeNull();
    const weeklyFull = await call({ view: "weekly", week_end: until }, undefined);
    expect((weeklyFull["delta"] as { prior_date: string | null }).prior_date).toBeNull();
  });
});
