/**
 * The shared vault pair of the log-reader reach A/B tests.
 *
 * Vault A holds a reserved confirmed preference with applied and violated
 * evidence inside both the 24-hour and the 30-day windows, a lifecycle
 * event outside a dream naming it, and a reserved preference a dream
 * confirmed and then retired inside the window (only `ret-bygone` is on
 * disk), with evidence logged before it was retired, so the event names
 * it only as `pref-bygone`, inside both windows. Vault B never had either. Both carry the same public preference
 * with its own evidence and a dream confirming it (shared in vault A with
 * the reserved record), so a remote answer is never empty.
 */

import { readFileSync, writeFileSync } from "node:fs";
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
import type { TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { MCPServer } from "../../src/mcp/server.ts";

export const PRIVATE_SLUG = "withheld";
export const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
/** Confirmed and then retired by a dream inside the window; only `ret-` is on disk. */
export const RETIRED_SLUG = "bygone";
export const SHARED_SLUG = "shared";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Inside the 24-hour window (and the daily brief's calendar day). */
const RECENT_AGE_MS = HOUR_MS;
/** Outside the 24-hour window, inside the 30-day one and the weekly window. */
const OLDER_AGE_MS = 3 * DAY_MS;
/** Any ISO-8601 instant or date: the two vaults are built moments apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
/** The opaque per-vault handle `vault_path` carries: it differs between any two vaults. */
const VAULT_HANDLE_RE = /vault:\/\/[0-9a-f]+/g;

export interface ReachLogFixture {
  readonly base: string;
  readonly configPath: string;
  readonly vault: string;
  /** The calendar day of the recent events. */
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

/**
 * Vault A (`withPrivate`) or vault B under `base`; `configLines` are
 * appended to the config file.
 */
export function buildReachLogFixture(
  base: string,
  withPrivate: boolean,
  configLines: ReadonlyArray<string> = [],
): ReachLogFixture {
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(
    configPath,
    [`vault: ${vault}`, "agent_name: claude", ...configLines, ""].join("\n"),
  );
  bootstrapBrain(vault, { configPath });
  const now = Date.now();
  const recent = new Date(now - RECENT_AGE_MS).toISOString();
  const older = new Date(now - OLDER_AGE_MS).toISOString();
  confirmed(vault, SHARED_SLUG);
  evidence(vault, SHARED_SLUG, recent, "applied");
  evidence(vault, SHARED_SLUG, older, "applied");
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
    for (const at of [recent, older]) {
      // Written as apply-evidence writes it: a wikilink with the principle, no path.
      log(vault, at, BRAIN_LOG_EVENT_KIND.applyEvidence, {
        preference: `[[pref-${RETIRED_SLUG}|Rule ${RETIRED_SLUG}.]]`,
        artifact: `[[Notes/${RETIRED_SLUG}-applied]]`,
        result: "applied",
      });
    }
    log(vault, recent, BRAIN_LOG_EVENT_KIND.forceConfirmed, {
      path: PRIVATE_PATH,
      preference: `[[pref-${PRIVATE_SLUG}]]`,
    });
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

/** A server at the reach given, or with no reach minted at all (a remote caller). */
export function reachServer(f: ReachLogFixture, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const config = { vault: f.vault, configPath: f.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

/** `value` as JSON with the fixture's paths, the vault handle and every instant replaced. */
export function maskVolatile(f: ReachLogFixture, value: unknown): string {
  let out = JSON.stringify(value);
  for (const [path, label] of [
    [f.vault, "<V>"],
    [f.base, "<B>"],
  ] as const) {
    const once = JSON.stringify(path).slice(1, -1);
    out = out.split(once).join(label).split(path).join(label);
  }
  return out.replace(VAULT_HANDLE_RE, "vault://<V>").replace(STAMP_RE, "<T>");
}
