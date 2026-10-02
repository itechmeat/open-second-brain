/**
 * The readers of the Brain log answer at the caller's reach.
 *
 * The daily log names preference ids, retired ids and evidence artifacts
 * in its event bodies. Below local reach the log page itself is not
 * served by a generic page reader (search), and every reader that renders
 * log events (analytics timeline, belief evolution, concept synthesis,
 * the today dashboard, the digest view, the event trace, backlinks and the
 * doctor) answers as if a record the caller cannot read had never been
 * logged: an event naming one is dropped, and a dream is kept while one
 * of its transitions is readable, showing only those.
 *
 * Vault A holds a reserved confirmed preference with applied and violated
 * evidence inside both the 24-hour and the 30-day windows, a reserved
 * preference a dream confirmed and then retired inside the window (only
 * `ret-bygone` is on disk), and a dream shared with the public
 * preference. Vault B never had the reserved records. A server with no
 * reach minted is a remote caller; each row also carries a local control
 * proving the reserved record is there to hide.
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
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_SLUG = "withheld";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
/** Confirmed and then retired by a dream inside the window; only `ret-` is on disk. */
const RETIRED_SLUG = "bygone";
const SHARED_SLUG = "shared";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_AGE_MS = HOUR_MS;
const OLDER_AGE_MS = 3 * DAY_MS;
/** Any ISO-8601 instant or date: the two vaults are built moments apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
/** The opaque per-vault handle `vault_path` carries. */
const VAULT_HANDLE_RE = /vault:\/\/[0-9a-f]+/g;
/** Relative ages ("1h ago") and durations, which tick between the two builds. */
const AGE_RE = /\b\d+(?:ms|s|m|h|d)\b/g;

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
  /** The calendar day of the recent events. */
  readonly date: string;
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
    run_id: "run-fixture",
    ...(confirmedIds.length > 0 ? { confirmed: confirmedIds.map((id) => `[[${id}|rule]]`) } : {}),
    ...(retiredIds.length > 0
      ? { retired: retiredIds.map((id) => `[[${id}|rule]] (superseded-by-context)`) }
      : {}),
  });
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-log-readers-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  const now = Date.now();
  const recent = new Date(now - RECENT_AGE_MS).toISOString();
  const older = new Date(now - OLDER_AGE_MS).toISOString();
  confirmed(vault, SHARED_SLUG);
  evidence(vault, SHARED_SLUG, recent, "applied");
  evidence(vault, SHARED_SLUG, older, "applied");
  // One dream confirming the public preference, and in vault A the
  // reserved one too: the reader keeps it and shows the public transition.
  const sharedDream = [`pref-${SHARED_SLUG}`];
  dream(vault, recent, withPrivate ? [...sharedDream, `pref-${PRIVATE_SLUG}`] : sharedDream, []);
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
  return { base, configPath, vault, date: recent.slice(0, 10) };
}

function server(f: Fixture, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const config = { vault: f.vault, configPath: f.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

async function call(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<unknown> {
  const result = (await server(f, reach).callTool(tool, args)) as Record<string, unknown>;
  return result["structuredContent"] ?? result;
}

/** Vault paths, handles, instants and ages replaced. */
function normalise(f: Fixture, value: unknown): string {
  let out = JSON.stringify(value);
  for (const [path, label] of [
    [f.vault, "<V>"],
    [f.base, "<B>"],
  ] as const) {
    const once = JSON.stringify(path).slice(1, -1);
    out = out.split(once).join(label).split(path).join(label);
  }
  return out
    .replace(VAULT_HANDLE_RE, "vault://<V>")
    .replace(STAMP_RE, "<T>")
    .replace(AGE_RE, "<AGE>");
}

/** The remote answers of both vaults, normalised, plus vault A's local answer. */
async function abRow(
  tool: string,
  args: (f: Fixture) => Record<string, unknown>,
  prepare: (f: Fixture) => Promise<void> = async () => {},
): Promise<{ withheld: string; absent: string; local: string }> {
  const a = fixture(true);
  const b = fixture(false);
  await prepare(a);
  await prepare(b);
  return {
    withheld: normalise(a, await call(a, tool, args(a))),
    absent: normalise(b, await call(b, tool, args(b))),
    local: normalise(a, await call(a, tool, args(a), TRANSPORT_REACH.local)),
  };
}

async function indexed(f: Fixture): Promise<void> {
  await indexVault(resolveSearchConfig({ vault: f.vault, configPath: f.configPath }), {
    force: true,
  });
}

/** The page paths a search answer names, sorted (scores depend on the corpus). */
function searchPaths(normalised: string): ReadonlyArray<string> {
  const results = (JSON.parse(normalised) as { results?: ReadonlyArray<{ path: string }> }).results;
  return (results ?? []).map((r) => r.path).toSorted();
}

describe("brain_search does not serve the daily log below local reach", () => {
  for (const word of [PRIVATE_SLUG, RETIRED_SLUG]) {
    test(`query '${word}' answers remotely as if the record was never logged`, async () => {
      const row = await abRow("brain_search", () => ({ query: word }), indexed);
      expect(row.withheld).toBe(row.absent);
      // Control: a local caller still finds the log page naming the record.
      expect(row.local).toContain("Brain/log/");
      expect(row.local).toContain(word);
    });
  }

  test("query 'rule' names the same pages remotely and the log page only locally", async () => {
    const row = await abRow("brain_search", () => ({ query: "rule" }), indexed);
    expect(searchPaths(row.withheld)).toEqual(searchPaths(row.absent));
    expect(row.withheld).not.toContain("Brain/log/");
    expect(row.withheld).not.toContain(PRIVATE_SLUG);
    expect(row.withheld).not.toContain(RETIRED_SLUG);
    expect(searchPaths(row.local).some((p) => p.startsWith("Brain/log/"))).toBe(true);
  });
});
