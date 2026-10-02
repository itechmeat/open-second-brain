/**
 * The active-preferences digest answers at the caller's reach.
 *
 * `Brain/active.md` is one shared file, written unscoped. Its remote
 * readers - `brain_context`, the `osb://preferences/active` resource and
 * the `brain_pre_compress_pack` head and top-K walk - must treat a preference the caller cannot read at its reach as absent:
 * principle, counts and the most-applied list alike.
 *
 * Vault A holds a confirmed preference and a retired record reserved
 * against remote reads, plus an applied event for the preference; vault B
 * never had them. The same remote read must answer identically in both
 * once vault paths and the generation stamp are normalised, and a local
 * read must still name the reserved principle, so an identical pair is
 * not an empty surface. A vault with nothing withheld is served the
 * file's own bytes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainActivePath, brainDirs } from "../../src/core/brain/paths.ts";
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
import { MCPServer } from "../../src/mcp/server.ts";

const MARKER = "zzwithheldprinciplezz";
const PRIVATE_SLUG = "withheld";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
const PRIVATE_RETIRED = `ret-${PRIVATE_SLUG}`;
const ACTIVE_URI = "osb://preferences/active";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
/** Any ISO-8601 instant: the two vaults are generated seconds apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** The per-vault opaque handle `brain_context` names the vault by. */
const VAULT_HANDLE_RE = /vault:\/\/[0-9a-f]+/g;

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

/** Insert frontmatter lines into an artifact already on disk. */
function reserve(vault: string, rel: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-active-digest-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  confirmed(vault, "shared", "Prefer short sentences.");
  // Both vaults carry a log day, so the maintenance flag (an aggregate
  // over the newest day) reads the same in each.
  appendLogEvent(
    vault,
    {
      timestamp: new Date().toISOString(),
      eventType: BRAIN_LOG_EVENT_KIND.note,
      body: { text: "fixture" },
    },
    { deviceId: "" },
  );
  if (withPrivate) {
    confirmed(vault, PRIVATE_SLUG, `Mention ${MARKER} first.`);
    reserve(vault, PRIVATE_PATH);
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
        'retired_by: "[[pref-shared]]"',
        "retired_reason: superseded-by-context",
        "_status: retired",
        "_evidenced_by: []",
        "---",
        "",
        `${MARKER} retired.`,
        "",
      ].join("\n"),
    );
    appendLogEvent(
      vault,
      {
        timestamp: new Date().toISOString(),
        eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
        body: { path: PRIVATE_PATH, preference: `[[pref-${PRIVATE_SLUG}]]`, result: "applied" },
      },
      { deviceId: "" },
    );
  }
  return { base, configPath, vault };
}

function server(f: Fixture, reach: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  return new MCPServer({ vault: f.vault, configPath: f.configPath }, { reach });
}

function normalise(f: Fixture, text: string): string {
  const escaped = JSON.stringify(f.vault).slice(1, -1);
  const escapedBase = JSON.stringify(f.base).slice(1, -1);
  return text
    .split(escaped)
    .join("<V>")
    .split(f.vault)
    .join("<V>")
    .split(escapedBase)
    .join("<B>")
    .split(f.base)
    .join("<B>")
    .replace(STAMP_RE, "<T>")
    .replace(VAULT_HANDLE_RE, "vault://<H>");
}

interface ContextPayload {
  readonly content: string;
  readonly counts: { readonly confirmed: number; readonly most_applied_30d: number };
}

/** The tool's JSON payload, unwrapped from the MCP text envelope. */
async function contextPayload(f: Fixture, reach: TransportReach): Promise<ContextPayload> {
  const result = (await server(f, reach).callTool("brain_context", {})) as {
    content: ReadonlyArray<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as ContextPayload;
}

async function context(f: Fixture, reach: TransportReach): Promise<string> {
  return normalise(f, JSON.stringify(await server(f, reach).callTool("brain_context", {})));
}

async function resource(f: Fixture, reach: TransportReach): Promise<string> {
  // `brain_context` regenerates the shared file first, so both vaults
  // read a digest of the same generation rules.
  await server(f, TRANSPORT_REACH.local).callTool("brain_context", {});
  const content = readResource({ vault: f.vault, agentName: "claude", reach }, ACTIVE_URI);
  return normalise(f, content.text);
}

async function pack(f: Fixture, reach: TransportReach): Promise<string> {
  // Regenerated first, so both vaults carry an active head to deliver.
  await server(f, TRANSPORT_REACH.local).callTool("brain_context", {});
  return normalise(
    f,
    JSON.stringify(await server(f, reach).callTool("brain_pre_compress_pack", { top_k: 10 })),
  );
}

describe("the active digest treats a withheld preference as absent at remote reach", () => {
  test("brain_context answers identically with and without the reserved records", async () => {
    const withheld = await context(fixture(true), TRANSPORT_REACH.remote);
    const absent = await context(fixture(false), TRANSPORT_REACH.remote);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toBe(absent);
  });

  test("the osb://preferences/active resource answers identically", async () => {
    const withheld = await resource(fixture(true), TRANSPORT_REACH.remote);
    const absent = await resource(fixture(false), TRANSPORT_REACH.remote);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toBe(absent);
  });

  test("brain_pre_compress_pack answers identically, head and top-K alike", async () => {
    const withheld = await pack(fixture(true), TRANSPORT_REACH.remote);
    const absent = await pack(fixture(false), TRANSPORT_REACH.remote);
    expect(withheld).not.toContain(MARKER);
    expect(withheld).toContain("Prefer short sentences.");
    expect(withheld).toBe(absent);
  });

  test("a local caller still reads the reserved principle and its counts", async () => {
    const f = fixture(true);
    const local = await contextPayload(f, TRANSPORT_REACH.local);
    expect(local.content).toContain(MARKER);
    expect(local.counts.confirmed).toBe(2);
    expect(local.counts.most_applied_30d).toBe(1);
    expect(local.content).toContain(PRIVATE_RETIRED);
    expect(await resource(f, TRANSPORT_REACH.local)).toContain(MARKER);
    expect(await pack(f, TRANSPORT_REACH.local)).toContain(MARKER);
  });

  test("a remote read of a vault with nothing withheld is served the file's bytes", async () => {
    const f = fixture(false);
    const out = await contextPayload(f, TRANSPORT_REACH.remote);
    const onDisk = readFileSync(brainActivePath(f.vault), "utf8");
    expect(out.content.endsWith(onDisk)).toBe(true);
    const content = readResource(
      { vault: f.vault, agentName: "claude", reach: TRANSPORT_REACH.remote },
      ACTIVE_URI,
    );
    expect(content.text).toBe(onDisk);
  });
});
