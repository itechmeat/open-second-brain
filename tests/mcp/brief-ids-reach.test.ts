/**
 * The daily and weekly brief views answer at the caller's reach.
 *
 * Both views name preference ids from log events: status transitions
 * from dream summaries, the weekly retired and contradiction lists, and
 * the evidence artifacts behind `source_pointers`. Below local reach a
 * row naming a record the caller cannot read is dropped, a source
 * pointer is kept only when it is cited by evidence the caller may see,
 * and no report snapshot is taken.
 *
 * Vault A holds a reserved confirmed preference with applied and
 * violated evidence inside both the 24-hour and the 30-day windows, and
 * a reserved preference a dream confirmed and then retired inside the
 * window; vault B never had either. Both carry the same public
 * preference with its own evidence and dream confirmation, so a remote
 * answer is never empty. The counts (`events_by_kind`, `vault_delta`)
 * still cover every event and are masked by the normaliser: that is the
 * residual the registry row states. A server with no reach minted is a
 * remote caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_SLUG = "withheld";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
/** Confirmed and then retired by a dream inside the window; only `ret-` is on disk. */
const RETIRED_SLUG = "bygone";
const SHARED_SLUG = "shared";
const SNAPSHOTS_ON = "report_snapshots_enabled: true";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Inside the 24-hour window (and the daily brief's calendar day). */
const RECENT_AGE_MS = HOUR_MS;
/** Outside the 24-hour window, inside the 30-day one and the weekly window. */
const OLDER_AGE_MS = 3 * DAY_MS;
/** Any ISO-8601 instant or date: the two vaults are built moments apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
/** The opaque per-vault handle `vault_path` carries: it differs between any two vaults. */
const VAULT_HANDLE_RE = /vault:\/\/[0-9a-f]+/g;
/** The count fields that still cover every event below local reach (the stated residual). */
const COUNT_KEYS = Object.freeze(["events_by_kind", "vault_delta"]);

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
  /** The daily brief's date: the calendar day of the recent events. */
  readonly date: string;
  /** The weekly window's end: the day after now, so the window holds every event. */
  readonly weekEnd: string;
}

function confirmed(vault: string, slug: string): void {
  writePreference(vault, {
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

function reserve(vault: string, rel: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function log(vault: string, timestamp: string, eventType: string, body: Record<string, unknown>) {
  appendLogEvent(vault, { timestamp, eventType, body } as Parameters<typeof appendLogEvent>[1], {
    deviceId: "",
  });
}

function evidence(vault: string, slug: string, at: string, result: "applied" | "violated") {
  log(vault, at, BRAIN_LOG_EVENT_KIND.applyEvidence, {
    path: `Brain/preferences/pref-${slug}.md`,
    preference: `[[pref-${slug}]]`,
    artifact: `[[Notes/${slug}-${result}]]`,
    result,
  });
}

function dream(vault: string, at: string, confirmedIds: string[], retiredIds: string[]) {
  log(vault, at, BRAIN_LOG_EVENT_KIND.dream, {
    run_id: `run-${at}`,
    ...(confirmedIds.length > 0 ? { confirmed: confirmedIds.map((id) => `[[${id}|rule]]`) } : {}),
    ...(retiredIds.length > 0
      ? { retired: retiredIds.map((id) => `[[${id}|rule]] (superseded-by-context)`) }
      : {}),
  });
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-brief-ids-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n${SNAPSHOTS_ON}\n`);
  bootstrapBrain(vault, { configPath });
  const now = Date.now();
  const recent = new Date(now - RECENT_AGE_MS).toISOString();
  const older = new Date(now - OLDER_AGE_MS).toISOString();
  confirmed(vault, SHARED_SLUG);
  evidence(vault, SHARED_SLUG, recent, "applied");
  evidence(vault, SHARED_SLUG, older, "applied");
  dream(vault, recent, [`pref-${SHARED_SLUG}`], []);
  if (withPrivate) {
    confirmed(vault, PRIVATE_SLUG);
    reserve(vault, PRIVATE_PATH);
    for (const at of [recent, older]) {
      evidence(vault, PRIVATE_SLUG, at, "applied");
      evidence(vault, PRIVATE_SLUG, at, "violated");
    }
    dream(vault, older, [`pref-${PRIVATE_SLUG}`, `pref-${RETIRED_SLUG}`], []);
    dream(vault, recent, [`pref-${RETIRED_SLUG}`], [`ret-${RETIRED_SLUG}`]);
    writeFileSync(
      join(brainDirs(vault).retired, `ret-${RETIRED_SLUG}.md`),
      [
        "---",
        "kind: brain-retired",
        `id: ret-${RETIRED_SLUG}`,
        RESERVE_LINE,
        "created_at: 2026-05-01T00:00:00Z",
        "tags: []",
        `topic: ${RETIRED_SLUG}`,
        "principle: retired principle",
        "provenance: observed",
        "retired_at: 2026-05-03T00:00:00Z",
        "retired_reason: superseded-by-context",
        "_status: retired",
        "_evidenced_by: []",
        "---",
        "",
        "Retired.",
        "",
      ].join("\n"),
    );
  }
  return {
    base,
    configPath,
    vault,
    date: recent.slice(0, 10),
    weekEnd: new Date(now + DAY_MS).toISOString().slice(0, 10),
  };
}

function server(f: Fixture, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const config = { vault: f.vault, configPath: f.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

type View = "daily" | "weekly";

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

async function brief(f: Fixture, view: View, reach?: TransportReach) {
  const args = view === "daily" ? { view, date: f.date } : { view, week_end: f.weekEnd };
  const result = await server(f, reach).callTool("brain_brief", args);
  return result.structuredContent as Record<string, unknown>;
}

/** Vault paths, handles and instants replaced, and the stated count residual masked. */
function normalise(f: Fixture, envelope: Record<string, unknown>): string {
  const masked = { ...envelope };
  for (const key of COUNT_KEYS) if (key in masked) masked[key] = "<counts>";
  let out = JSON.stringify(masked);
  for (const [path, label] of [
    [f.vault, "<V>"],
    [f.base, "<B>"],
  ] as const) {
    const once = JSON.stringify(path).slice(1, -1);
    out = out.split(once).join(label).split(path).join(label);
  }
  return out.replace(VAULT_HANDLE_RE, "vault://<V>").replace(STAMP_RE, "<T>");
}

describe("brain_brief daily and weekly at the caller's reach", () => {
  for (const view of ["daily", "weekly"] as const) {
    test(`view=${view} answers remotely as if the reserved records never existed`, async () => {
      const withheld = fixture(true);
      const absent = fixture(false);
      const remoteWithheld = await brief(withheld, view);
      const remoteAbsent = await brief(absent, view);
      expect(normalise(withheld, remoteWithheld)).toBe(normalise(absent, remoteAbsent));
      // Not vacuous: the public preference and its evidence are named.
      const text = JSON.stringify(remoteWithheld);
      expect(text).toContain(`pref-${SHARED_SLUG}`);
      expect(text).toContain(`Notes/${SHARED_SLUG}-applied`);
      expect(text).not.toContain(PRIVATE_SLUG);
      expect(text).not.toContain(RETIRED_SLUG);
      expect(remoteWithheld["delta"]).toBeUndefined();
    });

    test(`view=${view} still names the reserved records locally and captures the delta`, async () => {
      const f = fixture(true);
      const local = await brief(f, view, TRANSPORT_REACH.local);
      const text = JSON.stringify(local);
      expect(text).toContain(`pref-${RETIRED_SLUG}`);
      expect(text).toContain(`ret-${RETIRED_SLUG}`);
      expect(text).toContain(`Notes/${PRIVATE_SLUG}-applied`);
      expect(local["delta"]).toMatchObject({ prior_date: null });
    });
  }

  test("view=weekly names the reserved preference's own transition and contradiction locally", async () => {
    const local = await brief(fixture(true), "weekly", TRANSPORT_REACH.local);
    const contradictions = local["contradictions"] as ReadonlyArray<Record<string, unknown>>;
    expect(contradictions.map((row) => row["prefId"])).toContain(`pref-${PRIVATE_SLUG}`);
    expect(JSON.stringify(local["status_transitions"])).toContain(`pref-${PRIVATE_SLUG}`);
  });

  test("a remote run takes no report snapshot, so a later local run is the first", async () => {
    // The remote runs are dated a day earlier: a snapshot they took would
    // be the prior the later local run diffs against.
    const f = fixture(true);
    await server(f).callTool("brain_brief", { view: "daily", date: dayBefore(f.date) });
    await server(f).callTool("brain_brief", { view: "weekly", week_end: dayBefore(f.weekEnd) });
    expect((await brief(f, "daily", TRANSPORT_REACH.local))["delta"]).toMatchObject({
      prior_date: null,
    });
    expect((await brief(f, "weekly", TRANSPORT_REACH.local))["delta"]).toMatchObject({
      prior_date: null,
    });
  });
});
