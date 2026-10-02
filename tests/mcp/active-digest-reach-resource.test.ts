/**
 * The `osb://preferences/active` resource decides on the reader, not on
 * what the vault withholds.
 *
 * `Brain/active.md` is generated, then a shared preference lands without
 * a regeneration, so the file on disk is stale. Vault A also holds a
 * confirmed preference reserved against remote reads, with an applied
 * event; vault B never had it. Were the choice between the file's bytes
 * and a fresh render made on whether a record is withheld, vault B would
 * answer with the stale file and vault A with the render, and the
 * difference would tell a remote caller the reserved record exists. A
 * remote read must therefore be the render in both, stamped with the
 * file's `generated_at`, and the two must be identical once vault paths
 * and timestamps are normalised. A local read is still the file itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActive } from "../../src/core/brain/active.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainActivePath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { readResource } from "../../src/mcp/resources.ts";

const MARKER = "zzwithheldprinciplezz";
const PRIVATE_SLUG = "withheld";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
const LATE_PRINCIPLE = "Name the late rule.";
const ACTIVE_URI = "osb://preferences/active";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
/**
 * One stamp for every fixture event, taken once so the two vaults log the
 * same instant. It is near now because a remote read renders at read time:
 * an older event falls outside the 30-day most-applied window and the
 * list the test is about is never drawn.
 */
const EVENT_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
/** Generated a day after the event, inside the 30-day most-applied window. */
const GENERATED_AT = new Date("2026-05-03T00:00:00Z");
const GENERATED_AT_RE = /generated_at: (\S+)/;
/** Any ISO-8601 instant. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly base: string;
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

/** A vault whose active digest was generated before the late preference landed. */
function staleFixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-active-digest-resource-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  confirmed(vault, "shared", "Prefer short sentences.");
  appendLogEvent(
    vault,
    {
      timestamp: EVENT_AT,
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        path: "Brain/preferences/pref-shared.md",
        preference: "[[pref-shared]]",
        result: "applied",
      },
    },
    { deviceId: "" },
  );
  if (withPrivate) {
    confirmed(vault, PRIVATE_SLUG, `Mention ${MARKER} first.`);
    reserve(vault, PRIVATE_PATH);
    appendLogEvent(
      vault,
      {
        timestamp: EVENT_AT,
        eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
        body: { path: PRIVATE_PATH, preference: `[[pref-${PRIVATE_SLUG}]]`, result: "applied" },
      },
      { deviceId: "" },
    );
  }
  regenerateActive(vault, { now: GENERATED_AT });
  confirmed(vault, "late", LATE_PRINCIPLE);
  return { base, vault };
}

/** Escape a path the way a JSON string carries it. */
function jsonEscaped(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

/**
 * Vault paths are replaced in their raw, JSON-escaped and twice-escaped
 * forms (Windows separators double at each level), longest first.
 */
function normalise(f: Fixture, text: string): string {
  let out = text;
  for (const [path, label] of [
    [f.vault, "<V>"],
    [f.base, "<B>"],
  ] as const) {
    const once = jsonEscaped(path);
    out = out.split(jsonEscaped(once)).join(label).split(once).join(label).split(path).join(label);
  }
  return out.replace(STAMP_RE, "<T>");
}

function read(f: Fixture, reach: TransportReach): string {
  return readResource({ vault: f.vault, agentName: "claude", reach }, ACTIVE_URI).text;
}

describe("the active digest resource over a stale file", () => {
  test("answers identically at remote reach with and without a reserved record", () => {
    const withheld = normalise(...pair(true));
    const absent = normalise(...pair(false));
    expect(withheld).not.toContain(MARKER);
    expect(absent).toContain(LATE_PRINCIPLE);
    expect(absent).toContain("## Confirmed (2)");
    // The most-applied list is drawn, and counts only the shared record.
    expect(absent).toContain("## Most-applied (30d) (1)");
    expect(withheld).toBe(absent);
  });

  for (const withPrivate of [true, false]) {
    test(`a remote read is the render stamped with the file's generated_at (reserved record: ${withPrivate})`, () => {
      const f = staleFixture(withPrivate);
      const stamp = GENERATED_AT_RE.exec(readFileSync(brainActivePath(f.vault), "utf8"))![1]!;
      const remote = read(f, TRANSPORT_REACH.remote);
      expect(remote).toContain(`generated_at: ${stamp}`);
      expect(remote).toContain(LATE_PRINCIPLE);
    });
  }

  test("a local read is still the file's own bytes and names the reserved principle", () => {
    const f = staleFixture(true);
    const local = read(f, TRANSPORT_REACH.local);
    expect(local).toBe(readFileSync(brainActivePath(f.vault), "utf8"));
    expect(local).toContain(MARKER);
    expect(local).not.toContain(LATE_PRINCIPLE);
  });
});

function pair(withPrivate: boolean): [Fixture, string] {
  const f = staleFixture(withPrivate);
  return [f, read(f, TRANSPORT_REACH.remote)];
}
