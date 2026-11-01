/**
 * Report-shaped delivery binding (delivery-trust, lane A).
 *
 * `deliveryView(ctx)` is the one binding every report-shaped read shares:
 * it resolves the request's reach once, holds ONE frontmatter cache for
 * the whole request, and answers `shape(text, rel)` - fenced through the
 * K1 shaper unless the named page proves operator-authorship, identity at
 * local reach. `brain_query` preference and topic payloads, and the
 * agent contribution bodies of `brain_agent_query` and `brain_agent_diff`,
 * shape through it; the log-entry serializers they share are untouched.
 * A withheld reference stays identical to an absent one through every
 * serializer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUERY_TOOLS } from "../../src/mcp/brain/query-tools.ts";
import { deliveryView } from "../../src/mcp/brain/reach-events.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../src/core/brain/untrusted-source.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const AGENT_LABEL = "stored text: agent-authored (origin_channel=mcp-tool)";
const LEGACY_LABEL = "stored text: unverified provenance (no derivable stamps)";

const PREF_PRINCIPLE = "Prefer zzshortsentenceszz when planning work.";
const RAW_BODY = "raw zzfreeformbodyzz prose under the Raw heading";
const SIGNAL_PRINCIPLE = "zzsignalprinciplezz one-line formulation";
const NOTE_TEXT = "zznotewritebodyzz recorded by the note-write event";

let base: string;
let vault: string;
let configPath: string;

function ctxFor(reach: TransportReach): ServerContext {
  return { vault, configPath, repoRoot: null, reach };
}

async function call(
  name: string,
  reach: TransportReach,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = QUERY_TOOLS.find((t) => t.name === name)!;
  return (await tool.handler(ctxFor(reach), args)) as Record<string, unknown>;
}

/** The error text a refusal carries, for the identical-to-absent pins. */
async function callError(
  name: string,
  reach: TransportReach,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    await call(name, reach, args);
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

function fenceFor(label: string, body: string): string {
  return `<${UNTRUSTED_SOURCE_TAG} origin="${label}">\n${body}\n</${UNTRUSTED_SOURCE_TAG}>`;
}

/** Insert one frontmatter line into an artifact already on disk. */
function stamp(rel: string, line: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${line}${text.slice(close)}`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "o2b-quote-reports-"));
  vault = join(base, "vault");
  configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });

  // One legacy preference (no stamps) and one agent-stamped one.
  writePreference(vault, {
    slug: "legacy",
    topic: "legacy",
    principle: PREF_PRINCIPLE,
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
  writePreference(vault, {
    slug: "agented",
    topic: "agented",
    principle: PREF_PRINCIPLE,
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
  stamp("Brain/preferences/pref-agented.md", "origin_channel: mcp-tool\n");

  // One signal with a raw body, for the topic payload.
  writeSignal(vault, {
    topic: "agented",
    signal: "positive",
    agent: "agent-a",
    principle: SIGNAL_PRINCIPLE,
    created_at: "2026-05-03T00:00:00Z",
    date: "2026-05-03",
    slug: "agented-signal",
    raw: RAW_BODY,
  });

  // One note page plus the note-write event that names it, for the
  // agent contribution rows.
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(
    join(vault, "notes/agent.md"),
    `---\ntitle: Agent note\norigin_channel: mcp-tool\n---\n\n${NOTE_TEXT}\n`,
  );
  appendLogEvent(
    vault,
    {
      timestamp: "2026-05-04T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent: "agent-a",
      body: { target: "notes/agent.md", op: "create", write_id: "w1" },
    },
    { deviceId: "" },
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("brain_query preference payload at remote reach", () => {
  test("the agent-stamped preference principle is fenced naming the provenance", async () => {
    const local = await call("brain_query", TRANSPORT_REACH.local, {
      preference: "pref-agented",
    });
    const remote = await call("brain_query", TRANSPORT_REACH.remote, {
      preference: "pref-agented",
    });
    const localPref = local["preference"] as { principle: string };
    const remotePref = remote["preference"] as { principle: string };
    expect(localPref.principle).toBe(PREF_PRINCIPLE);
    expect(remotePref.principle).toBe(fenceFor(AGENT_LABEL, PREF_PRINCIPLE));
    // Only the payload body moved: the envelope fields are byte-identical.
    expect((remote as { mode: string })["mode"]).toBe((local as { mode: string })["mode"]);
  });

  test("a legacy preference is fenced fail-closed", async () => {
    const remote = await call("brain_query", TRANSPORT_REACH.remote, {
      preference: "pref-legacy",
    });
    const remotePref = remote["preference"] as { principle: string };
    expect(remotePref.principle).toBe(fenceFor(LEGACY_LABEL, PREF_PRINCIPLE));
  });

  test("the evidence trail (log-entry serializer) is untouched", async () => {
    const local = await call("brain_query", TRANSPORT_REACH.local, { preference: "pref-legacy" });
    const remote = await call("brain_query", TRANSPORT_REACH.remote, { preference: "pref-legacy" });
    expect(remote["evidence"]).toEqual(local["evidence"]);
  });

  test("a withheld preference answers exactly as an absent one", async () => {
    writePreference(vault, {
      slug: "reserved",
      topic: "reserved",
      principle: PREF_PRINCIPLE,
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [],
      confirmed_at: "2026-05-02T00:00:00Z",
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: BRAIN_CONFIDENCE.low,
      confidence_value: null,
    });
    stamp("Brain/preferences/pref-reserved.md", `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n`);
    const withheld = await callError("brain_query", TRANSPORT_REACH.remote, {
      preference: "pref-reserved",
    });
    const absent = await callError("brain_query", TRANSPORT_REACH.remote, {
      preference: "pref-neverwas",
    });
    // Same refusal shape, each naming the caller's own argument: a
    // withheld page is indistinguishable from an absent one.
    expect(withheld).toBe(absent.replace("pref-neverwas", "pref-reserved"));
  });
});

describe("brain_query topic payload at remote reach", () => {
  test("signal principle and raw body are fenced; local is byte-identical", async () => {
    const local = await call("brain_query", TRANSPORT_REACH.local, { topic: "agented" });
    const remote = await call("brain_query", TRANSPORT_REACH.remote, { topic: "agented" });
    const localSignals = local["signals"] as Array<{ principle: string; raw?: string }>;
    const remoteSignals = remote["signals"] as Array<{ principle: string; raw?: string }>;
    expect(localSignals).toHaveLength(1);
    expect(remoteSignals).toHaveLength(localSignals.length);
    expect(remoteSignals[0]!.principle).toBe(fenceFor(LEGACY_LABEL, SIGNAL_PRINCIPLE));
    expect(remoteSignals[0]!.raw).toBe(fenceFor(LEGACY_LABEL, RAW_BODY));
    expect(localSignals[0]!.principle).toBe(SIGNAL_PRINCIPLE);
    expect(localSignals[0]!.raw).toBe(RAW_BODY);
    // The topic's preference payload rides the same rule; the topic
    // resolves the mcp-tool-stamped rule, so its label names the stamp.
    const remotePref = remote["preference"] as { principle: string } | null;
    expect(remotePref?.principle).toBe(fenceFor(AGENT_LABEL, PREF_PRINCIPLE));
  });

  test("the since mode's log events are verbatim at remote reach", async () => {
    const local = await call("brain_query", TRANSPORT_REACH.local, {
      since: "2026-05-01T00:00:00Z",
    });
    const remote = await call("brain_query", TRANSPORT_REACH.remote, {
      since: "2026-05-01T00:00:00Z",
    });
    expect(remote["events"]).toEqual(local["events"]);
  });
});

describe("agent contribution bodies at remote reach", () => {
  interface Contribution {
    kind: string;
    id: string;
    text: string;
  }

  test("brain_agent_query fences note, preference and signal bodies; log rows untouched", async () => {
    const local = (await call("brain_agent_query", TRANSPORT_REACH.local, {
      agent: "agent-a",
    })) as { contributions: Contribution[] };
    const remote = (await call("brain_agent_query", TRANSPORT_REACH.remote, {
      agent: "agent-a",
    })) as { contributions: Contribution[] };
    expect(remote.contributions.length).toBe(local.contributions.length);
    for (const row of remote.contributions) {
      const localRow = local.contributions.find((c) => c.id === row.id)!;
      if (row.kind === "log") {
        expect(row.text).toBe(localRow.text);
      } else {
        expect(row.text.startsWith(`<${UNTRUSTED_SOURCE_TAG} origin="`)).toBe(true);
        expect(row.text).not.toBe(localRow.text);
      }
    }
    const note = remote.contributions.find((c) => c.kind === "note");
    expect(note?.text).toBe(
      fenceFor(AGENT_LABEL, local.contributions.find((c) => c.kind === "note")!.text),
    );
  });

  test("brain_agent_diff fences the same contribution bodies", async () => {
    const local = (await call("brain_agent_diff", TRANSPORT_REACH.local, {})) as {
      contributions: Contribution[];
    };
    const remote = (await call("brain_agent_diff", TRANSPORT_REACH.remote, {})) as {
      contributions: Contribution[];
    };
    expect(remote.contributions.length).toBe(local.contributions.length);
    for (const row of remote.contributions) {
      const localRow = local.contributions.find((c) => c.id === row.id)!;
      if (row.kind === "log") {
        expect(row.text).toBe(localRow.text);
      } else {
        expect(row.text.startsWith(`<${UNTRUSTED_SOURCE_TAG} origin="`)).toBe(true);
      }
    }
  });
});

describe("the delivery binding probes through the shared cache", () => {
  test("one frontmatter read per page however many fields of it the request shapes", () => {
    // The binding holds ONE FrontmatterCache per request; handing the
    // test's own cache in makes the read count observable: shaping two
    // different fields of the same page leaves one cached entry, so the
    // second shape was served from cache - never one read per row.
    const cache = new Map();
    const delivery = deliveryView(ctxFor(TRANSPORT_REACH.remote), { cache });
    delivery.shape(SIGNAL_PRINCIPLE, "Brain/preferences/pref-legacy.md");
    delivery.shape(RAW_BODY, "Brain/preferences/pref-legacy.md");
    delivery.shape(PREF_PRINCIPLE, "Brain/preferences/pref-agented.md");
    expect(cache.size).toBe(2);
    // Determinism across the cache boundary: the same page answers the
    // same treatment however many times the request asks.
    expect(delivery.shape(SIGNAL_PRINCIPLE, "Brain/preferences/pref-legacy.md")).toBe(
      fenceFor(LEGACY_LABEL, SIGNAL_PRINCIPLE),
    );
  });
});
