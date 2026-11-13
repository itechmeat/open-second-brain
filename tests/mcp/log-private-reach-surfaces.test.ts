/**
 * Every reader with a remote surface withholds the log events of the
 * store's `private` partition below local reach (change store-hardening,
 * design D1 and D2; spec `remote-log-reads`). Each case has one private
 * event that names nothing unless it says otherwise, and asserts the
 * remote answer and the local one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  existingPreferencePageText,
  writePreferencePageText,
} from "../../src/core/brain/preference-page-write.ts";
import { listRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { ledgerRowRecord } from "../../src/core/store/dual-write-records.ts";
import { withOperationPrivacy } from "../../src/core/store/operation-scope.ts";
import { routeWrite } from "../../src/core/store/store-write.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { recordNoteWrite, storeBeforeImage } from "../../src/core/brain/notes/write-record.ts";
import {
  computeTokenFootprint,
  TOKEN_WARN_THRESHOLD_DEFAULT,
} from "../../src/core/brain/token-footprint.ts";
import { readResource } from "../../src/mcp/resources.ts";
import { formatFrontmatter, parseFrontmatterText } from "../../src/core/vault.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

const SHARED_TEXT = "a shared note of the surfaces";
const PRIVATE_TEXT = "a private note that names nothing";

let env: StoreEnv;
beforeEach(() => {
  env = makeStoreEnv("osb-log-private-surfaces-");
  switchDevice(env.storeRoot);
});
afterEach(() => env.cleanup());

const REMOTE = TRANSPORT_REACH.remote;
const LOCAL = TRANSPORT_REACH.local;

async function call(
  tool: string,
  args: Record<string, unknown>,
  reach: TransportReach,
): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault: env.vault, configPath: env.configPath }, { reach });
  const result = (await server.callTool(tool, args)) as Record<string, unknown>;
  if (result["isError"] === true) throw new Error(`${tool} failed: ${JSON.stringify(result)}`);
  return (result["structuredContent"] ?? result) as Record<string, unknown>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** The widest offsets {@link recentStamp} takes: up to this much later than its base... */
const RECENT_LEAD_MS = 1_000;
/** ...and up to this much earlier. */
const RECENT_LAG_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Wait out the first seconds of a UTC day, in which {@link recentStamp}'s
 * base plus its lead would still be in the future. Run once before the
 * file's tests with a timeout longer than the wait, so no test's own
 * timeout pays for it; a test that crosses midnight still waits here.
 */
function awaitRecentWindow(): void {
  const now = Date.now();
  const earliest = now - (now % DAY_MS) + RECENT_LAG_MS + RECENT_LEAD_MS;
  if (now < earliest) Bun.sleepSync(earliest - now);
}

beforeAll(awaitRecentWindow, 3 * (RECENT_LAG_MS + RECENT_LEAD_MS));

/**
 * An instant about one minute before now, `offsetMs` earlier still (a
 * negative offset is later, up to {@link RECENT_LEAD_MS}), inside the
 * daily, weekly, monthly, today and timeline windows, and never after now.
 * In the first minute of a UTC day the base is clamped to
 * {@link RECENT_LAG_MS} past the day's start, so no window boundary falls
 * between the events; in the first seconds of the day, while that base plus
 * the lead would still be in the future, it first waits until it is not.
 */
function recentStamp(offsetMs = 0): string {
  if (offsetMs < -RECENT_LEAD_MS || offsetMs >= RECENT_LAG_MS) {
    throw new Error(`recentStamp offset ${offsetMs} is outside its window`);
  }
  awaitRecentWindow();
  const now = Date.now();
  const dayStart = now - (now % DAY_MS);
  const stamp = Math.max(dayStart + RECENT_LAG_MS, now - 60_000) - offsetMs;
  return new Date(Math.min(stamp, now)).toISOString();
}

function privately<T>(fn: () => T): T {
  return withOperationPrivacy(true, fn);
}

/** One shared and one private note inside the window. */
function twoNotes(): string {
  const at = recentStamp();
  appendLogEvent(env.vault, { timestamp: at, eventType: "note", body: { text: SHARED_TEXT } });
  privately(() =>
    appendLogEvent(env.vault, {
      timestamp: recentStamp(-1000),
      eventType: "note",
      body: { text: PRIVATE_TEXT },
    }),
  );
  return at.slice(0, 10);
}

describe("D1: the timeline and the briefs built on requestRefView", () => {
  test("brain_analytics view=timeline", async () => {
    twoNotes();
    const remote = json(await call("brain_analytics", { view: "timeline" }, REMOTE));
    expect(remote).toContain(SHARED_TEXT);
    expect(remote).not.toContain(PRIVATE_TEXT);
    const local = json(await call("brain_analytics", { view: "timeline" }, LOCAL));
    expect(local).toContain(SHARED_TEXT);
    expect(local).toContain(PRIVATE_TEXT);
  });

  // The daily, weekly and monthly briefs render counts, not note text:
  // the remote count leaves the private note out, the local one counts it.
  test("brain_brief view=daily counts the shared note only", async () => {
    const date = twoNotes();
    const args = { view: "daily", date };
    expect(noteCount(await call("brain_brief", args, REMOTE))).toBe(1);
    expect(noteCount(await call("brain_brief", args, LOCAL))).toBe(2);
  });

  test("brain_brief view=weekly counts the shared note only", async () => {
    twoNotes();
    const weekEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const args = { view: "weekly", week_end: weekEnd };
    expect(noteCount(await call("brain_brief", args, REMOTE))).toBe(1);
    expect(noteCount(await call("brain_brief", args, LOCAL))).toBe(2);
  });

  test("brain_brief view=monthly counts the shared note only", async () => {
    const date = twoNotes();
    const args = { view: "monthly", month: date.slice(0, 7) };
    const events = async (reach: TransportReach): Promise<unknown> =>
      ((await call("brain_brief", args, reach))["summary"] as Record<string, unknown>)["events"];
    expect(await events(REMOTE)).toBe(1);
    expect(await events(LOCAL)).toBe(2);
  });

  test("brain_brief view=today", async () => {
    twoNotes();
    const remote = json(await call("brain_brief", { view: "today" }, REMOTE));
    expect(remote).toContain(SHARED_TEXT);
    expect(remote).not.toContain(PRIVATE_TEXT);
    const local = json(await call("brain_brief", { view: "today" }, LOCAL));
    expect(local).toContain(SHARED_TEXT);
    expect(local).toContain(PRIVATE_TEXT);
  });
});

/** A daily or weekly brief's count of note events. */
function noteCount(answer: Record<string, unknown>): number {
  return (answer["events_by_kind"] as Record<string, number>)["note"] ?? 0;
}

// ----- D2: the readers with a remote surface -------------------------------

const PREF_SLUG = "surfaced";
const PREF_ID = `pref-${PREF_SLUG}`;

/** A shared confirmed preference, as the reach fixture writes one. */
function confirmedPreference(slug = PREF_SLUG): void {
  writePreference(env.vault, {
    slug,
    topic: slug,
    principle: `Rule ${slug}.`,
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

function applied(at: string, artifact: string, slug = PREF_SLUG): void {
  appendLogEvent(env.vault, {
    timestamp: at,
    eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
    body: { preference: `[[pref-${slug}]]`, artifact: `[[${artifact}]]`, result: "applied" },
  } as Parameters<typeof appendLogEvent>[1]);
}

/** A vault page reserved against remote reads, as the reach fixture reserves one. */
function reservedPage(rel: string): void {
  mkdirSync(dirname(join(env.vault, rel)), { recursive: true });
  writeFileSync(
    join(env.vault, rel),
    `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\nReserved.\n`,
  );
}

describe("D2 row 1: brain_query preference mode", () => {
  test("the remote evidence is the shared event only, and telemetry counts it", async () => {
    confirmedPreference();
    reservedPage("Notes/reserved.md");
    applied(recentStamp(3000), "Notes/shared-artifact");
    privately(() => applied(recentStamp(2000), "Notes/private-artifact"));
    applied(recentStamp(1000), "Notes/reserved");
    const args = { preference: PREF_ID, telemetry: true };
    const artifacts = (answer: Record<string, unknown>): string[] =>
      (answer["evidence"] as Array<Record<string, unknown>>).map((e) => json(e));
    const remote = artifacts(await call("brain_query", args, REMOTE));
    expect(remote).toHaveLength(1);
    expect(remote[0]).toContain("Notes/shared-artifact");
    const rows = listRecallTelemetry(env.vault, { mode: "query" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload["result_count"]).toBe(1);
    expect(artifacts(await call("brain_query", args, LOCAL))).toHaveLength(3);
  });
});

describe("D2 row 2: most-applied", () => {
  test("remote brain_context, osb://preferences/active and osb://digest/latest count the shared event", async () => {
    confirmedPreference();
    applied(recentStamp(3000), "Notes/one");
    privately(() => {
      applied(recentStamp(2000), "Notes/two");
      applied(recentStamp(1000), "Notes/three");
    });
    expect(json(await call("brain_context", {}, REMOTE))).toContain("(applied_in_window: 1)");
    expect(json(await call("brain_context", {}, LOCAL))).toContain("(applied_in_window: 3)");
    const active = (reach: TransportReach): string =>
      readResource({ vault: env.vault, reach }, "osb://preferences/active").text;
    expect(active(REMOTE)).toContain("(applied_in_window: 1)");
    expect(active(LOCAL)).toContain("(applied_in_window: 3)");
    const digest = (reach: TransportReach): string =>
      readResource({ vault: env.vault, reach }, "osb://digest/latest").text;
    expect(digest(REMOTE)).toContain(`[[${PREF_ID}|Rule ${PREF_SLUG}.]] — —, 1 applied`);
    expect(digest(LOCAL)).toContain(`[[${PREF_ID}|Rule ${PREF_SLUG}.]] — —, 3 applied`);
  });
});

describe("D2 row 3: morning brief and idea discovery", () => {
  test("a private note and a private open question stay off remote answers", async () => {
    privately(() => {
      appendLogEvent(env.vault, {
        timestamp: recentStamp(2000),
        eventType: "note",
        body: { text: PRIVATE_TEXT },
      });
      appendLogEvent(env.vault, {
        timestamp: recentStamp(1000),
        eventType: BRAIN_LOG_EVENT_KIND.reconcile,
        body: { topic: "private-open-question", domain: "coding" },
      } as Parameters<typeof appendLogEvent>[1]);
    });
    const morning = { view: "morning" };
    const remote = json(await call("brain_brief", morning, REMOTE));
    expect(remote).not.toContain(PRIVATE_TEXT);
    expect(remote).not.toContain("private-open-question");
    const local = json(await call("brain_brief", morning, LOCAL));
    expect(local).toContain(PRIVATE_TEXT);
    expect(local).toContain("private-open-question");
    expect(json(await call("brain_idea_discovery", {}, REMOTE))).not.toContain(
      "private-open-question",
    );
    expect(json(await call("brain_idea_discovery", {}, LOCAL))).toContain("private-open-question");
  });
});

describe("D2 row 4: agent provenance", () => {
  test("an agent whose only event is private is absent from remote answers", async () => {
    appendLogEvent(env.vault, {
      timestamp: recentStamp(2000),
      eventType: "note",
      agent: "@open-agent",
      body: { text: SHARED_TEXT },
    });
    privately(() =>
      appendLogEvent(env.vault, {
        timestamp: recentStamp(1000),
        eventType: "note",
        agent: "@secret-agent",
        body: { text: PRIVATE_TEXT },
      }),
    );
    for (const tool of ["brain_agent_query", "brain_agent_diff"]) {
      const remote = json(await call(tool, {}, REMOTE));
      expect(remote).toContain("open-agent");
      expect(remote).not.toContain("secret-agent");
      expect(remote).not.toContain(PRIVATE_TEXT);
      expect(remote).not.toContain("fromPrivatePartition");
      const local = json(await call(tool, {}, LOCAL));
      expect(local).toContain("secret-agent");
      expect(local).not.toContain("fromPrivatePartition");
    }
    const counts = await Promise.all(
      ["brain_agent_query", "brain_agent_diff"].flatMap((tool) =>
        [REMOTE, LOCAL].map(async (reach) => (await call(tool, {}, reach))["total_matched"]),
      ),
    );
    expect(counts).toEqual([1, 2, 1, 2]);
  });
});

const HUB_SLUG = "hub";
const HUB_MEMBERS = ["member-a", "member-b", "member-c", "member-d"];

/** A shared preference whose body is a MOC over the default hub thresholds. */
function hubPreference(): void {
  for (const slug of HUB_MEMBERS) confirmedPreference(slug);
  confirmedPreference(HUB_SLUG);
  const existing = existingPreferencePageText(env.vault, HUB_SLUG, (p) => readFileSync(p, "utf8"));
  if (existing === null) throw new Error("fixture: hub preference missing");
  const [meta] = parseFrontmatterText(existing);
  const links = [PREF_ID, ...HUB_MEMBERS.map((s) => `pref-${s}`)].map((id) => `[[${id}]]`);
  writePreferencePageText(env.vault, HUB_SLUG, formatFrontmatter(meta, `${links.join(" ")}\n`));
}

describe("D2 row 5: backlinks and the link-derived answers", () => {
  beforeEach(() => {
    confirmedPreference();
    hubPreference();
    privately(() => {
      applied(recentStamp(2000), "Notes/private-artifact");
      appendLogEvent(env.vault, {
        timestamp: recentStamp(1000),
        eventType: "note",
        body: { text: "names a target", link: "[[pref-missing-target]]" },
      } as Parameters<typeof appendLogEvent>[1]);
    });
  });

  const logSources = (refs: unknown): string[] =>
    (refs as Array<Record<string, unknown>>)
      .map((r) => String(r["source"]))
      .filter((s) => s.startsWith("log-"));

  test("osb://backlinks and brain_backlinks list no log backlink remotely", async () => {
    const resource = (reach: TransportReach): string =>
      readResource({ vault: env.vault, reach }, `osb://backlinks/${PREF_ID}`).text;
    expect(resource(REMOTE)).not.toContain("## log-");
    expect(resource(REMOTE)).toContain("Total inbound references: 1");
    expect(resource(LOCAL)).toContain("## log-apply-evidence (1)");
    expect(resource(LOCAL)).toContain("Total inbound references: 2");
    const tool = async (reach: TransportReach): Promise<Record<string, unknown>> =>
      call("brain_backlinks", { id: PREF_ID }, reach);
    expect(logSources((await tool(REMOTE))["refs"])).toEqual([]);
    expect((await tool(REMOTE))["count"]).toBe(1);
    expect(logSources((await tool(LOCAL))["refs"])).toHaveLength(1);
  });

  test("the remote digest's inbound count ignores the private reference", () => {
    // A shared event in the window, so the remote digest is not "no changes".
    appendLogEvent(env.vault, {
      timestamp: recentStamp(),
      eventType: "note",
      body: { text: SHARED_TEXT },
    });
    const inbound = (reach: TransportReach): number => {
      const text = readResource({ vault: env.vault, reach }, "osb://digest/latest").text;
      const line = text
        .split("\n")
        .find((l) => l.includes(`[[${PREF_ID}|`) && l.includes("inbound"));
      return line === undefined ? 0 : Number(/(\d+) inbound/.exec(line)![1]);
    };
    expect(inbound(REMOTE)).toBe(1);
    expect(inbound(LOCAL)).toBe(2);
  });

  test("concept synthesis lists no log linker remotely", async () => {
    const linkers = async (reach: TransportReach): Promise<string[]> => {
      const answer = await call(
        "brain_analytics",
        { view: "concept_synthesis", id: PREF_ID },
        reach,
      );
      const cluster = (answer["cluster"] ?? answer) as Record<string, unknown>;
      return (cluster["linkers"] as Array<Record<string, unknown>>)
        .map((l) => String(l["sourceKind"] ?? l["source_kind"]))
        .filter((k) => k.startsWith("log-"));
    };
    expect(await linkers(REMOTE)).toEqual([]);
    expect(await linkers(LOCAL)).toHaveLength(1);
  });

  test("brain_moc_audit counts no private backlink remotely", async () => {
    const count = async (reach: TransportReach): Promise<number> => {
      const answer = await call("brain_moc_audit", { id: `pref-${HUB_SLUG}` }, reach);
      const members = [
        ...((answer["wellCovered"] ?? answer["well_covered"]) as Array<Record<string, unknown>>),
        ...(answer["fragile"] as Array<Record<string, unknown>>),
      ];
      const member = members.find((m) => m["id"] === PREF_ID);
      if (member === undefined) throw new Error(`no member in ${json(answer)}`);
      return Number(member["backlinkCount"] ?? member["backlink_count"]);
    };
    expect(await count(REMOTE)).toBe(0);
    expect(await count(LOCAL)).toBe(1);
  });

  test("brain_doctor and its repair preview ignore a private broken backlink remotely", async () => {
    const warned = async (reach: TransportReach): Promise<boolean> =>
      json((await call("brain_doctor", {}, reach))["warnings"]).includes("pref-missing-target");
    expect(await warned(REMOTE)).toBe(false);
    expect(await warned(LOCAL)).toBe(true);
    const unfixable = async (reach: TransportReach): Promise<number> => {
      const answer = await call("brain_doctor", { repair: true }, reach);
      const repair = answer["repair"] as Record<string, unknown>;
      const rows = repair["unfixable"] as Array<Record<string, unknown>>;
      return Number(rows.find((r) => r["code"] === "broken-backlinks")?.["count"] ?? 0);
    };
    expect(await unfixable(REMOTE)).toBe(0);
    expect(await unfixable(LOCAL)).toBe(1);
  });
});

describe("D2 row 6: status", () => {
  test("remote status shows the shared times and one log day fewer", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number): string =>
      new Date(Date.now() - daysAgo * dayMs).toISOString().slice(0, 10) + "T10:00:00.000Z";
    const sharedDream = at(3);
    const sharedEvidence = at(2);
    const privateEvidence = at(1);
    const privateDream = at(1).replace("T10:", "T11:");
    confirmedPreference();
    appendLogEvent(env.vault, {
      timestamp: sharedDream,
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: { run_id: "run-shared" },
    } as Parameters<typeof appendLogEvent>[1]);
    applied(sharedEvidence, "Notes/shared-artifact");
    privately(() => {
      applied(privateEvidence, "Notes/private-artifact");
      appendLogEvent(env.vault, {
        timestamp: privateDream,
        eventType: BRAIN_LOG_EVENT_KIND.dream,
        body: { run_id: "run-private" },
      } as Parameters<typeof appendLogEvent>[1]);
    });
    const tool = async (reach: TransportReach): Promise<Record<string, unknown>> =>
      (await call("second_brain_status", {}, reach))["brain"] as Record<string, unknown>;
    const resource = (reach: TransportReach): string =>
      readResource({ vault: env.vault, reach }, "osb://status").text;
    const remote = await tool(REMOTE);
    expect(remote["last_apply_evidence_at"]).toBe(sharedEvidence);
    expect(remote["last_dream_at"]).toBe(sharedDream);
    expect((remote["counts"] as Record<string, unknown>)["log_days"]).toBe(2);
    expect(resource(REMOTE)).toContain(`- last dream: ${sharedDream}`);
    expect(resource(REMOTE)).toContain(`- last apply-evidence: ${sharedEvidence}`);
    expect(resource(REMOTE)).toContain("- log days: 2");
    const local = await tool(LOCAL);
    expect(local["last_apply_evidence_at"]).toBe(privateEvidence);
    expect(local["last_dream_at"]).toBe(privateDream);
    expect((local["counts"] as Record<string, unknown>)["log_days"]).toBe(3);
    expect(resource(LOCAL)).toContain(`- last dream: ${privateDream}`);
    expect(resource(LOCAL)).toContain(`- last apply-evidence: ${privateEvidence}`);
    expect(resource(LOCAL)).toContain("- log days: 3");
    // The newest shared day holds no dream; the newest day of all holds a private one.
    expect((await call("brain_context", {}, REMOTE))["maintenance_overdue"]).toBe(true);
    expect((await call("brain_context", {}, LOCAL))["maintenance_overdue"]).toBe(false);
  });
});

describe("D2 row 7: the cost meter", () => {
  test("remote brain_recall_telemetry operation cost counts the shared write only", async () => {
    twoNotes();
    const writes = async (reach: TransportReach): Promise<unknown> => {
      const answer = await call("brain_recall_telemetry", { operation: "cost" }, reach);
      const meter = (answer["meter"] ?? answer) as Record<string, unknown>;
      return (meter["writes"] as Record<string, unknown>)["total"];
    };
    expect(await writes(REMOTE)).toBe(1);
    expect(await writes(LOCAL)).toBe(2);
  });
});

/** The brain_doctor suggested actions a caller at `reach` sees. */
async function doctorActions(reach: TransportReach): Promise<ReadonlyArray<{ category: string }>> {
  return (await call("brain_doctor", {}, reach))["suggested_actions"] as ReadonlyArray<{
    category: string;
  }>;
}

/** The revert plan of every write of the agent `claude`, as a caller at `reach` sees it. */
function claudeRevertPlan(reach: TransportReach): Promise<Record<string, unknown>> {
  return call("brain_writes", { action: "plan_revert", agent: "claude" }, reach);
}

/** The first entry of a revert plan. */
function firstEntry(answer: Record<string, unknown>): Record<string, unknown> {
  return (answer["entries"] as ReadonlyArray<Record<string, unknown>>)[0]!;
}

/** Three private notes of another device in one shard; returns its path. */
function privateShard(): string {
  const store = openStore({ root: env.storeRoot, device: "dev-b" });
  let path = "";
  for (const n of [1, 2, 3]) {
    path = appendRecord(store, {
      partition: "private",
      stream: "events",
      kind: "note",
      agent: "t",
      body: { n },
    }).path;
  }
  return path;
}

const storeShardIssues = (answer: Record<string, unknown>): string[] =>
  [
    ...(answer["errors"] as ReadonlyArray<Record<string, unknown>>),
    ...(answer["warnings"] as ReadonlyArray<Record<string, unknown>>),
  ]
    .filter((i) => String(i["code"]).startsWith("store-shard-"))
    .map((i) => json(i));

describe("D2 row 8: the token footprint", () => {
  const FOOTPRINT_TITLE = "Vault exceeds warn threshold";

  function logTokens(withholdsPrivate: boolean): number {
    const report = computeTokenFootprint(env.vault, { withholdsPrivate });
    return report.byCategory.find((c) => c.name === "log")?.tokens ?? 0;
  }

  /** One private note of about 2000 tokens. */
  function privateBulk(): void {
    privately(() =>
      appendLogEvent(env.vault, {
        timestamp: recentStamp(),
        eventType: "note",
        body: { text: "p".repeat(8000) },
      }),
    );
  }

  /**
   * Shared notes, each at most 60000 characters, until the footprint
   * without the private event sits just under the default threshold.
   */
  function fillToThreshold(): void {
    const total = (): number => computeTokenFootprint(env.vault, { withholdsPrivate: true }).total;
    const target = TOKEN_WARN_THRESHOLD_DEFAULT - 500;
    let now = total();
    while (now < TOKEN_WARN_THRESHOLD_DEFAULT - 1000) {
      const chars = Math.max(1, Math.min(60_000, (target - now) * 4 - 400));
      appendLogEvent(env.vault, {
        timestamp: recentStamp(),
        eventType: "note",
        body: { text: "s".repeat(chars) },
      });
      const next = total();
      expect(next).toBeGreaterThan(now);
      now = next;
    }
    expect(now).toBeGreaterThanOrEqual(TOKEN_WARN_THRESHOLD_DEFAULT - 1000);
    expect(now).toBeLessThanOrEqual(TOKEN_WARN_THRESHOLD_DEFAULT);
  }

  const hasFootprint = (actions: ReadonlyArray<{ category: string }>): boolean =>
    actions.some((a) => a.category === "token-footprint");

  test("the log bucket leaves out the private event's tokens only when withholding", () => {
    appendLogEvent(env.vault, {
      timestamp: recentStamp(),
      eventType: "note",
      body: { text: SHARED_TEXT },
    });
    const before = logTokens(false);
    privateBulk();
    expect(logTokens(true)).toBe(before);
    expect(logTokens(false)).toBeGreaterThan(before + 1900);
  });

  test("remote doctor, digest and operator brief carry no footprint action, local ones do", async () => {
    privateBulk();
    fillToThreshold();
    const digest = (reach: TransportReach): string =>
      readResource({ vault: env.vault, reach }, "osb://digest/latest").text;
    expect(digest(REMOTE)).not.toContain(FOOTPRINT_TITLE);
    expect(digest(LOCAL)).toContain(FOOTPRINT_TITLE);
    const brief = async (reach: TransportReach): Promise<string> =>
      json(await call("brain_brief", { view: "digest" }, reach));
    expect(await brief(REMOTE)).not.toContain(FOOTPRINT_TITLE);
    expect(await brief(LOCAL)).toContain(FOOTPRINT_TITLE);
    const topActions = async (
      reach: TransportReach,
    ): Promise<ReadonlyArray<{ category: string }>> =>
      (
        await call(
          "brain_brief",
          { view: "operator", include_dream: false, top_actions: 50 },
          reach,
        )
      )["top_actions"] as ReadonlyArray<{ category: string }>;
    expect(hasFootprint(await topActions(REMOTE))).toBe(false);
    expect(hasFootprint(await topActions(LOCAL))).toBe(true);
    expect(hasFootprint(await doctorActions(REMOTE))).toBe(false);
    expect(hasFootprint(await doctorActions(LOCAL))).toBe(true);
  });
});

describe("D2 row 9: the unfiltered timeline builders", () => {
  beforeEach(() => {
    const dayMs = 24 * 60 * 60 * 1000;
    confirmedPreference();
    // The shared evidence is past the 90-day stale threshold; only the
    // private one keeps the preference fresh.
    applied(new Date(Date.now() - 100 * dayMs).toISOString(), "Notes/shared-artifact");
    privately(() => {
      applied(recentStamp(2000), "Notes/private-artifact");
      appendLogEvent(env.vault, {
        timestamp: recentStamp(1000),
        eventType: "note",
        body: { text: "names a target", link: "[[pref-missing-target]]" },
      } as Parameters<typeof appendLogEvent>[1]);
    });
  });

  // A lineage answer lists transitions, not evidence: the evidence only
  // decides whether the preference has a lineage at all. A preference whose
  // only event is private has none remotely and one locally.
  test("remote brain_idea_lineage leaves out the private apply-evidence", async () => {
    confirmedPreference("lineage-only");
    privately(() => applied(recentStamp(3000), "Notes/private-artifact", "lineage-only"));
    const args = { id: "pref-lineage-only" };
    await expect(call("brain_idea_lineage", args, REMOTE)).rejects.toThrow("no belief lineage");
    expect(json(await call("brain_idea_lineage", args, LOCAL))).toContain("pref-lineage-only");
  });

  test("remote brain_stale_scan counts the preference the private event keeps fresh", async () => {
    const staleIds = async (reach: TransportReach): Promise<string[]> =>
      (
        (await call("brain_stale_scan", {}, reach))["stale_preferences"] as ReadonlyArray<{
          prefId: string;
        }>
      ).map((r) => r.prefId);
    expect(await staleIds(REMOTE)).toContain(PREF_ID);
    expect(await staleIds(LOCAL)).not.toContain(PREF_ID);
  });

  test("remote brain_status counts stale and doctor warnings without the private events", async () => {
    const status = (reach: TransportReach): Promise<Record<string, unknown>> =>
      call("brain_status", {}, reach);
    const warnings = (answer: Record<string, unknown>): number => {
      const row = (answer["problems"] as ReadonlyArray<{ code: string; detail: string }>).find(
        (p) => p.code === "doctor-warnings",
      );
      return row === undefined ? 0 : Number.parseInt(row.detail, 10);
    };
    const remote = await status(REMOTE);
    const local = await status(LOCAL);
    expect(remote["staleTotal"]).toBe((local["staleTotal"] as number) + 1);
    // Two private findings are withheld remotely: the broken backlink of the
    // private note, and the orphan evidence of the private apply-evidence.
    expect(warnings(local)).toBe(warnings(remote) + 2);
  });
});

/** Do what the write seams do: keep the before image, write, record. */
function writeNote(note: string, bytes: string, at: string, agent = "claude"): string {
  const abs = join(env.vault, note);
  let before: string | null = null;
  try {
    before = readFileSync(abs, "utf8");
  } catch {
    before = null;
  }
  mkdirSync(dirname(abs), { recursive: true });
  if (before !== null) storeBeforeImage(env.vault, before);
  writeFileSync(abs, bytes);
  const receipt = recordNoteWrite(env.vault, {
    op: before === null ? "create" : "update",
    target: note,
    before: before === null ? null : { bytes: before },
    after: { bytes },
    timestamp: at,
    agent,
  });
  return (receipt as { write_id: string }).write_id;
}

/** {@link recentStamp} to the second, the precision of a write record. */
const writeStamp = (offsetMs: number): string => recentStamp(offsetMs).replace(/\.\d+Z$/, "Z");

describe("D2 row 10: note writes", () => {
  const NOTE = "Notes/surfaced-note.md";

  let sharedWrite: string;
  let privateWrite: string;
  beforeEach(() => {
    sharedWrite = writeNote(NOTE, "first body\n", writeStamp(3000));
    privateWrite = privately(() => writeNote(NOTE, "second body\n", writeStamp(1000)));
  });

  test("remote brain_writes and brain_write_destinations leave out the private write", async () => {
    const writes = async (reach: TransportReach): Promise<Record<string, unknown>> =>
      call("brain_writes", { path: NOTE }, reach);
    const ids = (answer: Record<string, unknown>): string[] =>
      (answer["writes"] as ReadonlyArray<{ write_id: string }>).map((w) => w.write_id);
    const remote = await writes(REMOTE);
    expect(remote["total_matched"]).toBe(1);
    expect(ids(remote)).toEqual([sharedWrite]);
    const local = await writes(LOCAL);
    expect(local["total_matched"]).toBe(2);
    expect(ids(local)).toContain(privateWrite);
    const row = async (reach: TransportReach): Promise<Record<string, unknown>> => {
      const answer = await call("brain_write_destinations", { path: NOTE }, reach);
      return (answer["destinations"] as ReadonlyArray<Record<string, unknown>>)[0]!;
    };
    expect((await row(REMOTE))["note_writes"]).toBe(1);
    expect((await row(LOCAL))["note_writes"]).toBe(2);
  });

  test("the remote revert plan lists no write of the private operation", async () => {
    const plan = (reach: TransportReach): Promise<Record<string, unknown>> =>
      call("brain_writes", { action: "plan_revert", path: NOTE }, reach);
    const planned = (answer: Record<string, unknown>): string[] =>
      (answer["entries"] as ReadonlyArray<{ writes: ReadonlyArray<string> }>).flatMap(
        (e) => e.writes,
      );
    const remote = await plan(REMOTE);
    const local = await plan(LOCAL);
    expect(planned(remote)).not.toContain(privateWrite);
    expect(planned(local)).toContain(privateWrite);
    expect(remote["digest"]).not.toBe(local["digest"]);
  });
});

describe("D2 row 10: the revert plan's safety rules see every write", () => {
  const NOTE = "Notes/interleaved-note.md";
  const PRIVATE_BODY = "a private body between two shared ones\n";

  test("a private write between two selected shared writes refuses the remote plan", async () => {
    writeNote(NOTE, "origin\n", writeStamp(4000), "origin-agent");
    const first = writeNote(NOTE, "first\n", writeStamp(3000));
    const hidden = privately(() => writeNote(NOTE, PRIVATE_BODY, writeStamp(2000)));
    const last = writeNote(NOTE, "last\n", writeStamp(1000));
    // Locally all three writes are selected and nothing interleaves.
    const local = firstEntry(await claudeRevertPlan(LOCAL));
    expect(local["action"]).toBe("restore");
    expect(local["writes"]).toEqual([first, hidden, last]);
    // Remotely only the shared two are selected, and the private one
    // between them still refuses the plan; the refusal names neither it
    // nor its text.
    const remoteAnswer = await claudeRevertPlan(REMOTE);
    const remote = firstEntry(remoteAnswer);
    expect(remote["action"]).toBe("refuse");
    expect(remote["reason"]).toBe("interleaved");
    expect(remote["writes"]).toEqual([first, last]);
    expect(json(remoteAnswer)).not.toContain(hidden);
    expect(json(remoteAnswer)).not.toContain(PRIVATE_BODY.trim());
  });
});

describe("doctor: a failed private write", () => {
  test("remote brain_doctor shows no trace of it, local names it", async () => {
    // The path as either platform spells it, also escaped inside the JSON answer.
    const PRIVATE_LEDGERS = /private[\\/]+ledgers/;
    // A file where the private ledgers folder belongs: the append fails
    // with an error text that names the private path.
    writeFileSync(join(env.storeRoot, "private", "ledgers"), "not a folder\n");
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const routed = routeWrite({
        legacy: () => null,
        store: () => ledgerRowRecord("metrics", { n: 1 }, "private"),
        context: { vault: env.vault, configPath: env.configPath },
        failOpen: true,
      });
      expect(routed.mode === "store" && routed.failed !== undefined).toBe(true);
    } finally {
      quiet.mockRestore();
    }
    const remote = json(await call("brain_doctor", {}, REMOTE));
    expect(remote).not.toContain("store-write-fail-open");
    expect(remote).not.toMatch(PRIVATE_LEDGERS);
    const local = json(await call("brain_doctor", {}, LOCAL));
    expect(local).toContain("store-write-fail-open");
    // The answer masks the store root, so the path shows from the partition.
    expect(local).toMatch(PRIVATE_LEDGERS);
  });
});

describe("doctor: the evidence lints quote no private event", () => {
  const SHARED_ARTIFACT = "shared-orphan-artifact";
  const PRIVATE_ARTIFACT = "private-orphan-artifact";

  test("remote brain_doctor names neither the private artifact nor its time; local names both", async () => {
    confirmedPreference();
    const sharedAt = recentStamp(2000);
    const privateAt = recentStamp(1000);
    // A range that does not parse and a basename no file has: the private
    // event would raise both `malformed-evidence-range` and `orphan-evidence`.
    applied(sharedAt, `${SHARED_ARTIFACT}:9-3`);
    privately(() => applied(privateAt, `${PRIVATE_ARTIFACT}:9-3`));
    const lintRows = (answer: Record<string, unknown>): string[] =>
      (answer["warnings"] as ReadonlyArray<unknown>)
        .map((w) => json(w))
        .filter((w) => w.includes("orphan-evidence") || w.includes("malformed-evidence-range"));
    const remote = lintRows(await call("brain_doctor", {}, REMOTE));
    // The lints still run remotely: the shared event raises both findings.
    expect(remote.filter((w) => w.includes(SHARED_ARTIFACT))).toHaveLength(2);
    expect(remote.filter((w) => w.includes(PRIVATE_ARTIFACT) || w.includes(privateAt))).toEqual([]);
    const local = lintRows(await call("brain_doctor", {}, LOCAL));
    expect(local.filter((w) => w.includes(PRIVATE_ARTIFACT) && w.includes(privateAt))).toHaveLength(
      2,
    );
    expect(local.filter((w) => w.includes(SHARED_ARTIFACT))).toHaveLength(2);
  });
});

describe("doctor: a gap in a private shard", () => {
  const HOUR = 60 * 60 * 1000;

  /** A corrupt middle line, and a tail that has not verified for two hours. */
  function breakShard(path: string): void {
    const lines = readFileSync(path, "utf8").split("\n");
    lines[1] = lines[1]!.replace('"n":2', '"n":20');
    writeFileSync(path, lines.join("\n"));
    appendFileSync(path, '{"partial');
    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(path, old, old);
  }

  /** The shard's partition-relative folder, as every finding about it names it. */
  const PRIVATE_SHARD_DIR = "private/events/dev-b";

  test("remotely no finding names the private shard and ok and the counts are unchanged; locally it is named", async () => {
    const path = privateShard();
    const before = await call("brain_doctor", {}, REMOTE);
    breakShard(path);
    const remote = await call("brain_doctor", {}, REMOTE);
    expect(storeShardIssues(remote).filter((i) => i.includes("private"))).toEqual([]);
    expect(remote["ok"]).toBe(before["ok"]);
    expect(remote["trust_verdict"]).toEqual(before["trust_verdict"]);
    const counts = (answer: Record<string, unknown>) => [
      (answer["errors"] as ReadonlyArray<unknown>).length,
      (answer["warnings"] as ReadonlyArray<unknown>).length,
    ];
    expect(counts(remote)).toEqual(counts(before));
    const local = storeShardIssues(await call("brain_doctor", {}, LOCAL));
    expect(
      local.some((i) => i.includes("store-shard-corrupt-line") && i.includes("private/")),
    ).toBe(true);
    expect(local.some((i) => i.includes("store-shard-tail-held") && i.includes("private"))).toBe(
      true,
    );
  });

  test("remote brain_brief view=operator keeps its counts and trust verdict; local counts the gap", async () => {
    const path = privateShard();
    const brief = (reach: TransportReach) => call("brain_brief", { view: "operator" }, reach);
    const before = await brief(REMOTE);
    const localBefore = await brief(LOCAL);
    breakShard(path);
    const remote = await brief(REMOTE);
    expect(remote["doctor_summary"]).toEqual(before["doctor_summary"]);
    expect(remote["trust_verdict"]).toEqual(before["trust_verdict"]);
    expect(json(remote)).not.toContain(PRIVATE_SHARD_DIR);
    const local = await brief(LOCAL);
    const errorsOf = (answer: Record<string, unknown>) =>
      (answer["doctor_summary"] as { error_count: number }).error_count;
    expect(errorsOf(local)).toBeGreaterThan(errorsOf(localBefore));
  });

  test("remote brain_status keeps its doctor counts; local counts the gap", async () => {
    const path = privateShard();
    const doctorRows = async (reach: TransportReach) => {
      const answer = await call("brain_status", {}, reach);
      return {
        answer,
        rows: (answer["problems"] as ReadonlyArray<{ code: string; detail: string }>).filter((p) =>
          p.code.startsWith("doctor-"),
        ),
      };
    };
    const before = await doctorRows(REMOTE);
    const localBefore = await doctorRows(LOCAL);
    breakShard(path);
    const remote = await doctorRows(REMOTE);
    expect(remote.rows).toEqual(before.rows);
    expect(json(remote.answer)).not.toContain(PRIVATE_SHARD_DIR);
    const local = await doctorRows(LOCAL);
    expect(local.rows).not.toEqual(localBefore.rows);
    expect(local.rows.some((r) => r.code === "doctor-errors")).toBe(true);
  });
});

// ----- Timeline-derived rows: rows that are not events ----------------------
//
// These readers turn the timeline index into rows of their own (evidence
// with running counts, status transitions, retirements), which never pass
// `eventAtReach`. Every row names only the shared preference, so the
// reference view keeps it: the private event must not reach the index.

/** A private dream that confirmed the shared preference. */
function privateDreamConfirming(at: string): void {
  privately(() =>
    appendLogEvent(env.vault, {
      timestamp: at,
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: { run_id: "run-private", confirmed: [`[[${PREF_ID}]]`] },
    } as Parameters<typeof appendLogEvent>[1]),
  );
}

describe("timeline-derived rows withhold a private event naming a shared preference", () => {
  test("brain_analytics view=belief_evolution", async () => {
    confirmedPreference();
    applied(recentStamp(3000), "Notes/shared-artifact");
    const privateAt = recentStamp(2000);
    privately(() => applied(privateAt, "Notes/shared-artifact"));
    privateDreamConfirming(recentStamp(1000));
    const args = { view: "belief_evolution", pref_id: PREF_ID };
    const rows = (answer: Record<string, unknown>, key: string): ReadonlyArray<unknown> =>
      answer[key] as ReadonlyArray<unknown>;
    const remote = await call("brain_analytics", args, REMOTE);
    expect(rows(remote, "evidence")).toHaveLength(1);
    expect(rows(remote, "transitions")).toHaveLength(0);
    expect(json(remote)).not.toContain(privateAt);
    const local = await call("brain_analytics", args, LOCAL);
    expect(rows(local, "evidence")).toHaveLength(2);
    expect(rows(local, "transitions")).toHaveLength(1);
    expect(json(local)).toContain(privateAt);
  });

  test("brain_brief view=daily and view=weekly status transitions", async () => {
    confirmedPreference();
    const at = recentStamp();
    privateDreamConfirming(at);
    const weekEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const transitions = async (
      args: Record<string, unknown>,
      reach: TransportReach,
    ): Promise<ReadonlyArray<unknown>> =>
      (await call("brain_brief", args, reach))["status_transitions"] as ReadonlyArray<unknown>;
    for (const args of [
      { view: "daily", date: at.slice(0, 10) },
      { view: "weekly", week_end: weekEnd },
    ]) {
      expect(await transitions(args, REMOTE)).toHaveLength(0);
      expect(await transitions(args, LOCAL)).toHaveLength(1);
    }
  });
});
