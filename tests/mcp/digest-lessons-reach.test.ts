/**
 * The activity digest and the lessons digest answer at the caller's reach.
 *
 * `brain_brief view=digest`, the `osb://digest/latest` resource and the
 * `osb://lessons` resource all render preference records. A preference,
 * retired record or dead-end reserved against remote reads must be absent
 * from what a remote caller receives: its principle, its rows and every
 * count it would move.
 *
 * Vault A holds a confirmed preference, a retired record and a dead-end,
 * each reserved, plus an applied event for the preference; vault B never
 * had them. Both vaults carry the same public preference with its own
 * applied event, so a remote answer is never empty. The same remote read
 * must answer identically in both once vault paths and timestamps are
 * normalised, and a local read must still name the reserved principle.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { regenerateLessons } from "../../src/core/brain/lessons.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { createTriggers, readTriggers } from "../../src/core/brain/triggers/store.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { vaultRelative } from "../../src/core/path-safety.ts";
import { readResource } from "../../src/mcp/resources.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const MARKER = "zzwithheldprinciplezz";
const PRIVATE_SLUG = "withheld";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
const PRIVATE_RETIRED = `ret-${PRIVATE_SLUG}`;
const SHARED_SLUG = "shared";
const SHARED_PRINCIPLE = "Prefer short sentences.";
const LATE_SLUG = "late";
const LATE_PRINCIPLE = "Prefer late rules.";
/** A contradicted topic with no preference file on disk. */
const OPEN_SLUG = "commit-style";
const DIGEST_URI = "osb://digest/latest";
const LESSONS_URI = "osb://lessons";
const SNAPSHOTS_ON = "report_snapshots_enabled: true";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Inside the 30-day most-applied window and the lessons decay, outside
 * the digest's default 24-hour activity window.
 */
const EVIDENCE_AGE_MS = 3 * DAY_MS;
/** Inside the digest's 24-hour activity window, so the agent summary counts the event. */
const RECENT_EVIDENCE_AGE_MS = DAY_MS / 24;
/** Any ISO-8601 instant, date or minute stamp: the two vaults are built seconds apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Fixture {
  readonly base: string;
  readonly configPath: string;
  readonly vault: string;
}

function confirmed(vault: string, slug: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
}

/** Insert the reserve line into the frontmatter of an artifact already on disk. */
function reserve(vault: string, rel: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function applied(vault: string, slug: string, at: string): void {
  appendLogEvent(
    vault,
    {
      timestamp: at,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        path: `Brain/preferences/pref-${slug}.md`,
        preference: `[[pref-${slug}]]`,
        artifact: `[[Notes/${slug}-artifact]]`,
        result: "applied",
      },
    },
    { deviceId: "" },
  );
}

function fixture(withPrivate: boolean, evidenceAgeMs = EVIDENCE_AGE_MS): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-digest-lessons-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  const evidenceAt = new Date(Date.now() - evidenceAgeMs).toISOString();
  confirmed(vault, SHARED_SLUG, SHARED_PRINCIPLE);
  applied(vault, SHARED_SLUG, evidenceAt);
  if (withPrivate) {
    confirmed(vault, PRIVATE_SLUG, `Mention ${MARKER} first.`);
    reserve(vault, PRIVATE_PATH);
    applied(vault, PRIVATE_SLUG, evidenceAt);
    writeFileSync(
      join(brainDirs(vault).retired, `${PRIVATE_RETIRED}.md`),
      [
        "---",
        "kind: brain-retired",
        `id: ${PRIVATE_RETIRED}`,
        RESERVE_LINE,
        "created_at: 2026-05-01T00:00:00Z",
        "tags: []",
        `topic: ${MARKER}`,
        "principle: retired principle",
        "provenance: observed",
        "retired_at: 2026-05-03T00:00:00Z",
        `retired_by: "[[pref-${SHARED_SLUG}]]"`,
        "retired_reason: superseded-by-context",
        "_status: retired",
        "_evidenced_by: []",
        "---",
        "",
        `${MARKER} retired.`,
        "",
      ].join("\n"),
    );
    const deadEnd = recordDeadEnd(vault, {
      approach: `Try the ${MARKER} route`,
      reason: "it failed",
      agent: "claude",
      now: new Date(),
    });
    reserve(vault, vaultRelative(deadEnd.entry.path, vault));
  }
  regenerateLessons(vault);
  return { base, configPath, vault };
}

function server(f: Fixture, reach: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  return new MCPServer({ vault: f.vault, configPath: f.configPath }, { reach });
}

/**
 * Vault paths are replaced in their raw and JSON-escaped forms; on
 * Windows a path inside a JSON string inside a JSON string is escaped
 * twice, so the escaped form is escaped once more as well.
 */
function normalise(f: Fixture, text: string): string {
  let out = text;
  for (const [path, label] of [
    [f.vault, "<V>"],
    [f.base, "<B>"],
  ] as const) {
    const once = JSON.stringify(path).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    out = out.split(twice).join(label).split(once).join(label).split(path).join(label);
  }
  return out.replace(STAMP_RE, "<T>");
}

async function briefDigest(
  f: Fixture,
  reach: TransportReach,
  format: "markdown" | "json",
): Promise<string> {
  const result = await server(f, reach).callTool("brain_brief", { view: "digest", format });
  return normalise(f, JSON.stringify(result));
}

/** The apply-evidence events the digest's agent summary counts, over every agent. */
async function appliedEventsCounted(f: Fixture, reach: TransportReach): Promise<number> {
  const result = await server(f, reach).callTool("brain_brief", { view: "digest", format: "json" });
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const digest = JSON.parse(String(structured?.["content"])) as {
    agent_summary: ReadonlyArray<{ apply_evidence_count: number }>;
  };
  return digest.agent_summary.reduce((n, row) => n + row.apply_evidence_count, 0);
}

function resource(f: Fixture, reach: TransportReach, uri: string): string {
  return normalise(f, readResource({ vault: f.vault, agentName: "claude", reach }, uri).text);
}

describe("the activity and lessons digests treat a withheld record as absent at remote reach", () => {
  for (const format of ["markdown", "json"] as const) {
    test(`brain_brief view=digest format=${format} answers identically with and without the reserved records`, async () => {
      const withheld = await briefDigest(fixture(true), TRANSPORT_REACH.remote, format);
      const absent = await briefDigest(fixture(false), TRANSPORT_REACH.remote, format);
      expect(withheld).not.toContain(MARKER);
      expect(withheld).toContain(`pref-${SHARED_SLUG}`);
      expect(withheld).toBe(absent);
    });
  }

  test("the agent summary of brain_brief view=digest leaves out an event about a reserved record", async () => {
    const withheld = fixture(true, RECENT_EVIDENCE_AGE_MS);
    const absent = fixture(false, RECENT_EVIDENCE_AGE_MS);
    expect(await briefDigest(withheld, TRANSPORT_REACH.remote, "json")).toBe(
      await briefDigest(absent, TRANSPORT_REACH.remote, "json"),
    );
    // The shared event is counted at remote reach and the reserved one is
    // counted locally, so the summary is neither empty nor blind to it.
    expect(await appliedEventsCounted(withheld, TRANSPORT_REACH.remote)).toBe(1);
    expect(await appliedEventsCounted(withheld, TRANSPORT_REACH.local)).toBe(2);
  });

  test("a remote digest takes no report snapshot and reports no delta", async () => {
    const f = fixture(true);
    atomicWriteFileSync(f.configPath, `${readFileSync(f.configPath, "utf8")}${SNAPSHOTS_ON}\n`);
    const deltaAt = async (reach: TransportReach): Promise<unknown> => {
      const result = await server(f, reach).callTool("brain_brief", { view: "digest" });
      return (result.structuredContent as Record<string, unknown> | undefined)?.["delta"];
    };
    expect(await deltaAt(TRANSPORT_REACH.remote)).toBeUndefined();
    // The local run is the first snapshot: the remote run wrote none.
    expect(await deltaAt(TRANSPORT_REACH.local)).toMatchObject({ prior_date: null });
  });

  test("brain_brief view=morning answers identically with and without the reserved records", async () => {
    const morning = async (f: Fixture, reach: TransportReach): Promise<string> =>
      normalise(
        f,
        JSON.stringify(await server(f, reach).callTool("brain_brief", { view: "morning" })),
      );
    const withheld = await morning(fixture(true), TRANSPORT_REACH.remote);
    const absent = await morning(fixture(false), TRANSPORT_REACH.remote);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toContain(SHARED_PRINCIPLE);
    expect(withheld).toBe(absent);
    expect(await morning(fixture(true), TRANSPORT_REACH.local)).toContain(MARKER);
  });

  test("a remote morning brief shows no pending trigger and leaves the queue undelivered", async () => {
    const now = new Date();
    const withheld = fixture(true);
    // The stale-claim trigger a health scan builds for the reserved preference.
    createTriggers(
      withheld.vault,
      [
        {
          kind: "stale_claim",
          urgency: "medium",
          reason: `pref-${PRIVATE_SLUG} has had no fresh evidence for 40 days`,
          suggestedAction: "Re-evidence the preference or let the dream pass retire it",
          sourceArtifacts: [`[[pref-${PRIVATE_SLUG}]]`],
          contextSnippets: [],
          cooldownKey: `stale_claim:pref-${PRIVATE_SLUG}`,
        },
      ],
      { now },
    );
    const morning = async (f: Fixture, reach: TransportReach): Promise<string> =>
      normalise(
        f,
        JSON.stringify(await server(f, reach).callTool("brain_brief", { view: "morning" })),
      );
    const statuses = (): ReadonlyArray<string> =>
      readTriggers(withheld.vault, { now }).records.map((record) => record.status);
    expect(await morning(withheld, TRANSPORT_REACH.remote)).toBe(
      await morning(fixture(false), TRANSPORT_REACH.remote),
    );
    expect(statuses()).toEqual(["pending"]);
    // A local caller is the operator: the trigger is shown and delivered.
    expect(await morning(withheld, TRANSPORT_REACH.local)).toContain(`pref-${PRIVATE_SLUG}`);
    expect(statuses()).toEqual(["delivered"]);
  });

  test("an open question on a reserved preference's topic is absent from a remote morning brief and digest", async () => {
    const withheld = fixture(true, RECENT_EVIDENCE_AGE_MS);
    appendLogEvent(
      withheld.vault,
      {
        timestamp: new Date().toISOString(),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: { topic: PRIVATE_SLUG, domain: "general", positives: "1", negatives: "1" },
      },
      { deviceId: "" },
    );
    const absent = fixture(false, RECENT_EVIDENCE_AGE_MS);
    const morning = async (f: Fixture, reach: TransportReach): Promise<string> =>
      normalise(
        f,
        JSON.stringify(await server(f, reach).callTool("brain_brief", { view: "morning" })),
      );
    expect(await morning(withheld, TRANSPORT_REACH.remote)).toBe(
      await morning(absent, TRANSPORT_REACH.remote),
    );
    expect(await briefDigest(withheld, TRANSPORT_REACH.remote, "json")).toBe(
      await briefDigest(absent, TRANSPORT_REACH.remote, "json"),
    );
    // A local caller still sees the open question.
    expect(await morning(withheld, TRANSPORT_REACH.local)).toContain(`"topic":"${PRIVATE_SLUG}"`);
  });

  test("an open question on a topic with no preference file reaches a remote morning brief", async () => {
    const f = fixture(false, RECENT_EVIDENCE_AGE_MS);
    appendLogEvent(
      f.vault,
      {
        timestamp: new Date().toISOString(),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: { topic: OPEN_SLUG, domain: "general", positives: "1", negatives: "1" },
      },
      { deviceId: "" },
    );
    const morning = async (reach: TransportReach): Promise<string> =>
      JSON.stringify(await server(f, reach).callTool("brain_brief", { view: "morning" }));
    const remote = await morning(TRANSPORT_REACH.remote);
    expect(remote).toContain(`"topic":"${OPEN_SLUG}"`);
    expect(remote).toBe(await morning(TRANSPORT_REACH.local));
  });

  test("the osb://digest/latest resource answers identically", () => {
    const withheld = resource(fixture(true), TRANSPORT_REACH.remote, DIGEST_URI);
    const absent = resource(fixture(false), TRANSPORT_REACH.remote, DIGEST_URI);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toContain(SHARED_PRINCIPLE);
    expect(withheld).toBe(absent);
  });

  test("the osb://lessons resource answers identically", () => {
    const withheld = resource(fixture(true), TRANSPORT_REACH.remote, LESSONS_URI);
    const absent = resource(fixture(false), TRANSPORT_REACH.remote, LESSONS_URI);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toContain(SHARED_PRINCIPLE);
    expect(withheld).toBe(absent);
  });

  test("the osb://lessons resource answers identically when the file on disk is stale", () => {
    // A shared preference with evidence lands after the last regeneration:
    // the remote render is built from the records, not from the stale file.
    const late = (f: Fixture): string => {
      confirmed(f.vault, LATE_SLUG, LATE_PRINCIPLE);
      applied(f.vault, LATE_SLUG, new Date(Date.now() - EVIDENCE_AGE_MS).toISOString());
      return resource(f, TRANSPORT_REACH.remote, LESSONS_URI);
    };
    const withheld = late(fixture(true));
    const absent = late(fixture(false));
    expect(withheld).toContain(LATE_PRINCIPLE);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toBe(absent);
  });

  test("a remote lessons read carries the generation stamp on disk", () => {
    const f = fixture(false);
    const onDisk = readFileSync(join(f.vault, "Brain", "lessons.md"), "utf8");
    const stamp = /^generated_at: .+$/m.exec(onDisk)![0];
    const remote = readResource(
      { vault: f.vault, agentName: "claude", reach: TRANSPORT_REACH.remote },
      LESSONS_URI,
    ).text;
    expect(remote).toContain(stamp);
  });

  test("a local caller still reads the reserved principle in all three", async () => {
    const f = fixture(true);
    expect(await briefDigest(f, TRANSPORT_REACH.local, "markdown")).toContain(MARKER);
    expect(resource(f, TRANSPORT_REACH.local, DIGEST_URI)).toContain(MARKER);
    const lessons = readResource(
      { vault: f.vault, agentName: "claude", reach: TRANSPORT_REACH.local },
      LESSONS_URI,
    ).text;
    expect(lessons).toContain(MARKER);
    expect(lessons).toBe(readFileSync(join(f.vault, "Brain", "lessons.md"), "utf8"));
  });
});
