/**
 * Whole-document surfaces at remote reach (delivery-trust, lane A).
 *
 * `brain_context`'s active body, `brain_pinned_context`'s scratchpad and
 * the osb:// resource readers for preference, topic, active and lessons
 * deliver whole stored-record documents. At remote reach each delivered
 * markdown carries the `<untrusted_source>` fence naming the page's
 * derived provenance; at local reach every byte is the pre-wave shape.
 * The status and digest-latest readers render counts and the system's
 * own voice, and the log reader is the log lane, so none of them shape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTEXT_TOOLS } from "../../src/mcp/brain/context-tools.ts";
import { readResource, type ResourceContext } from "../../src/mcp/resources.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
} from "../../src/core/brain/types.ts";
import { regenerateActive } from "../../src/core/brain/active.ts";
import { regenerateLessons } from "../../src/core/brain/lessons.ts";
import { recordDeadEnd } from "../../src/core/brain/dead-ends.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../src/core/brain/untrusted-source.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const PRINCIPLE = "Prefer zzwholepagedoczz prose when rendering digests.";
const DEAD_END_APPROACH = "zzdeadendapproachzz rewriting the index on every read";
const AGENT_LABEL = "stored text: agent-authored (origin_channel=mcp-tool)";
const LEGACY_LABEL = "stored text: unverified provenance (no derivable stamps)";
const FENCE_CLOSE = `</${UNTRUSTED_SOURCE_TAG}>`;

let base: string;
let vault: string;
let configPath: string;

const contextTool = () => CONTEXT_TOOLS.find((t) => t.name === "brain_context")!;
const pinnedTool = () => CONTEXT_TOOLS.find((t) => t.name === "brain_pinned_context")!;

function serverCtx(reach: TransportReach): ServerContext {
  return { vault, configPath, repoRoot: null, reach };
}

function resourceCtx(reach: TransportReach): ResourceContext {
  return { vault, reach };
}

function fenced(label: string, body: string): string {
  return `<${UNTRUSTED_SOURCE_TAG} origin="${label}">\n${body}\n${FENCE_CLOSE}`;
}

function stamp(rel: string, line: string): void {
  const abs = join(vault, rel);
  const text = readFileSync(abs, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(abs, `${text.slice(0, close)}\n${line}${text.slice(close)}`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "o2b-quote-resources-"));
  vault = join(base, "vault");
  configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  writePreference(vault, {
    slug: "legacy",
    topic: "legacy",
    principle: PRINCIPLE,
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
    principle: PRINCIPLE,
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
  // One dead-end, so the lessons corpus carries a stored-record lesson
  // title (a bare confirmed preference is not a lesson until apply
  // evidence lands).
  recordDeadEnd(vault, {
    approach: DEAD_END_APPROACH,
    reason: "too slow on large vaults",
    agent: "agent-a",
    now: new Date("2026-05-03T00:00:00Z"),
  });
  regenerateActive(vault);
  regenerateLessons(vault);
  appendLogEvent(
    vault,
    {
      timestamp: "2026-05-04T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.note,
      body: { text: "fixture day" },
    },
    { deviceId: "" },
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("brain_context and brain_pinned_context", () => {
  test("the active body is fenced at remote and byte-raw at local", async () => {
    const local = (await contextTool().handler(serverCtx(TRANSPORT_REACH.local), {})) as {
      content: string;
    };
    const remote = (await contextTool().handler(serverCtx(TRANSPORT_REACH.remote), {})) as {
      content: string;
    };
    expect(local.content).toContain(PRINCIPLE);
    expect(local.content).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
    expect(remote.content).toContain(`<${UNTRUSTED_SOURCE_TAG} origin="${LEGACY_LABEL}">`);
    // A valid fence: the stored principle survives inside a closed span.
    expect(remote.content).toContain(PRINCIPLE);
    expect(remote.content).toContain(FENCE_CLOSE);
  });

  test("a pinned scratchpad body is fenced at remote, untouched at local", async () => {
    const PINNED_BODY = "zzpinnednotezz the operator keeps at hand";
    (await pinnedTool().handler(serverCtx(TRANSPORT_REACH.local), {
      operation: "write",
      content: PINNED_BODY,
    })) as { content: string };
    const local = (await pinnedTool().handler(serverCtx(TRANSPORT_REACH.local), {
      operation: "read",
    })) as { content: string };
    const remote = (await pinnedTool().handler(serverCtx(TRANSPORT_REACH.remote), {
      operation: "read",
    })) as { content: string };
    expect(local.content).toBe(PINNED_BODY);
    expect(remote.content).toBe(fenced(LEGACY_LABEL, PINNED_BODY));
  });
});

describe("osb:// resource readers", () => {
  test("osb://preference/{id} fences the page at remote and serves bytes at local", () => {
    const raw = readFileSync(join(vault, "Brain/preferences/pref-legacy.md"), "utf8");
    const local = readResource(resourceCtx(TRANSPORT_REACH.local), "osb://preference/legacy");
    const remote = readResource(resourceCtx(TRANSPORT_REACH.remote), "osb://preference/legacy");
    expect(local.text).toBe(raw);
    // The whole file - frontmatter included - is what this reader hands
    // back, so the fence wraps the whole delivery.
    expect(remote.text).toBe(fenced(LEGACY_LABEL, raw));
    // The agent-stamped page names its stamp.
    const agented = readResource(resourceCtx(TRANSPORT_REACH.remote), "osb://preference/agented");
    expect(agented.text).toContain(`<${UNTRUSTED_SOURCE_TAG} origin="${AGENT_LABEL}">`);
    expect(agented.text).toContain(FENCE_CLOSE);
  });

  test("osb://preferences/active and osb://lessons fence at remote, bytes at local", () => {
    // The stored text each digest quotes: the active digest lists the
    // preference principles; the lessons corpus carries the dead-end's
    // approach (a bare confirmed preference is not a lesson until apply
    // evidence lands).
    const stored: Record<string, string> = {
      "osb://preferences/active": PRINCIPLE,
      "osb://lessons": DEAD_END_APPROACH,
    };
    for (const uri of ["osb://preferences/active", "osb://lessons"] as const) {
      const local = readResource(resourceCtx(TRANSPORT_REACH.local), uri);
      const remote = readResource(resourceCtx(TRANSPORT_REACH.remote), uri);
      expect(local.text).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
      expect(local.text).toContain(stored[uri]!);
      expect(remote.text).toContain(`<${UNTRUSTED_SOURCE_TAG} origin="${LEGACY_LABEL}">`);
      expect(remote.text).toContain(stored[uri]!);
      expect(remote.text).toContain(FENCE_CLOSE);
    }
  });

  test("osb://topic/{slug} fences at remote naming the topic's rule", () => {
    const local = readResource(resourceCtx(TRANSPORT_REACH.local), "osb://topic/agented");
    const remote = readResource(resourceCtx(TRANSPORT_REACH.remote), "osb://topic/agented");
    expect(local.text).toContain(PRINCIPLE);
    expect(local.text).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
    expect(remote.text).toContain(`<${UNTRUSTED_SOURCE_TAG} origin="${AGENT_LABEL}">`);
    expect(remote.text).toContain(PRINCIPLE);
    expect(remote.text).toContain(FENCE_CLOSE);
  });

  test("osb://backlinks/{id} fences at remote; status, digest and log readers stay raw", () => {
    const remote = readResource(resourceCtx(TRANSPORT_REACH.remote), "osb://backlinks/pref-legacy");
    expect(remote.text).toContain(`<${UNTRUSTED_SOURCE_TAG} origin="${LEGACY_LABEL}">`);
    expect(remote.text).toContain(FENCE_CLOSE);
    for (const uri of ["osb://status", "osb://digest/latest", "osb://log/2026-05-04"] as const) {
      const out = readResource(resourceCtx(TRANSPORT_REACH.remote), uri);
      expect(out.text).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
    }
  });
});
