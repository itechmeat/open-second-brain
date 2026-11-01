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
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUERY_TOOLS } from "../../src/mcp/brain/query-tools.ts";
import { DECISIONS_TOOLS } from "../../src/mcp/brain/decisions-tools.ts";
import { KNOWLEDGE_TOOLS } from "../../src/mcp/brain/knowledge-tools.ts";
import { recordDecision } from "../../src/core/brain/decisions/record.ts";
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

/** The brain_claims tool answers through the same handler shape. */
async function callKnowledge(
  reach: TransportReach,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = KNOWLEDGE_TOOLS.find((t) => t.name === "brain_claims")!;
  return (await tool.handler(ctxFor(reach), args)) as Record<string, unknown>;
}

/** The brain_decision tool answers through the same handler shape. */
async function callDecision(
  reach: TransportReach,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = DECISIONS_TOOLS.find((t) => t.name === "brain_decision")!;
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
    // Evidence naming the signal below gives the agent-query walk a
    // preference contribution, so every non-log kind is in the fixture.
    evidenced_by: ["[[sig-2026-05-03-agented-signal]]"],
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

  // One more unstamped preference whose body mentions the agented id
  // unlinked, so brain_unlinked_mentions has a source row whose context
  // line is this page's own prose.
  writePreference(vault, {
    slug: "mentioning",
    topic: "mentioning",
    principle: "Cross-reference pref-agented in plain prose for the mention scanner.",
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
  // The scanner walks page BODIES (frontmatter stripped), so the
  // mention rides the body, not the frontmatter principle.
  appendFileSync(
    join(vault, "Brain/preferences/pref-mentioning.md"),
    "\nCross-reference pref-agented in plain prose for the mention scanner.\n",
  );

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
  // One plain note event, so the log kind is a real row and the
  // "log serializers untouched" branch is not vacuous.
  appendLogEvent(
    vault,
    {
      timestamp: "2026-05-04T01:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.note,
      agent: "agent-a",
      body: { text: "zzplainlogtextzz the operator journaled" },
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
    data: Record<string, unknown>;
  }

  /**
   * The fence label each non-log kind's governing page derives in this
   * fixture: the note-write row probes the stamped note page, the
   * preference row the stamped preference, the signal row its unstamped
   * signal page.
   */
  const LABEL_BY_KIND: Record<string, string> = {
    note: AGENT_LABEL,
    preference: AGENT_LABEL,
    signal: LEGACY_LABEL,
  };

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
        continue;
      }
      // Exact whole-fence equality, not a prefix: a shaper that fenced
      // only a leading section, or emitted stored text after the close
      // tag, fails here.
      expect(row.text).toBe(fenceFor(LABEL_BY_KIND[row.kind]!, localRow.text));
      // The structured data block echoes the same stored text beside the
      // body; an unfenced copy in data would not be a fence.
      if (row.kind === "signal") {
        expect(row.data["principle"]).toBe(
          fenceFor(LABEL_BY_KIND[row.kind]!, localRow.data["principle"] as string),
        );
      }
    }
    // Every non-log kind is in the fixture, so the loop above exercised
    // note, preference and signal rows, not one representative kind.
    for (const kind of ["note", "preference", "signal"]) {
      expect(remote.contributions.some((c) => c.kind === kind)).toBe(true);
    }
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
        continue;
      }
      expect(row.text).toBe(fenceFor(LABEL_BY_KIND[row.kind]!, localRow.text));
      if (row.kind === "signal") {
        expect(row.data["principle"]).toBe(
          fenceFor(LABEL_BY_KIND[row.kind]!, localRow.data["principle"] as string),
        );
      }
    }
    for (const kind of ["note", "preference", "signal"]) {
      expect(remote.contributions.some((c) => c.kind === kind)).toBe(true);
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

describe("brain_decision page text at remote reach", () => {
  const TITLE = "Adopt the staged rollout";
  const SLUG = "adopt-the-staged-rollout";
  const LEGACY_SLUG = "adopt-the-staged-rollout-legacy";
  const CHOSEN = "roll out behind a flag";
  const ASSUMPTION = "zzassumptionzz the flag drains in a day";
  const PREMORTEM = "zzpremortemzz the drain stalls at half";
  const RATIONALE = "zzrationalezzy the pilot held";
  const OUTCOME = "zzoutcomezz held up under load";
  const RECALL_ENV_KEY = "OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION";

  /** Record one rated decision; stamp the page when it must read agent-authored. */
  function record(slug: "agented" | "legacy"): void {
    const title = slug === "agented" ? TITLE : `${TITLE} legacy`;
    recordDecision(vault, {
      title,
      chosen: CHOSEN,
      assumption: ASSUMPTION,
      reviewDate: "2026-07-01",
      premortem: PREMORTEM,
      rating: 4,
      rationale: RATIONALE,
      agent: "agent-a",
    });
    if (slug === "agented")
      stamp(`Brain/decisions/decision-${SLUG}.md`, "origin_channel: mcp-tool\n");
  }

  test("show fences the page-derived fields; local is byte-identical", async () => {
    record("agented");
    const local = await callDecision(TRANSPORT_REACH.local, { action: "show", slug: SLUG });
    const remote = await callDecision(TRANSPORT_REACH.remote, { action: "show", slug: SLUG });
    expect(local["assumption"]).toBe(ASSUMPTION);
    expect(local["premortem"]).toBe(PREMORTEM);
    // The free-text payload fields fence; the identifiers and structured
    // fields stay as-is, the same line the preference payloads draw.
    expect(remote["assumption"]).toBe(fenceFor(AGENT_LABEL, ASSUMPTION));
    expect(remote["premortem"]).toBe(fenceFor(AGENT_LABEL, PREMORTEM));
    expect(remote["chosen"]).toBe(CHOSEN);
    expect(remote["rating"]).toBe(local["rating"]);

    // An outcome backfilled through the write path lands on the page and
    // reads back fenced, exactly like a field recorded at capture time.
    await callDecision(TRANSPORT_REACH.remote, {
      action: "outcome",
      slug: SLUG,
      outcome: OUTCOME,
    });
    // The decision writer re-renders the page frontmatter on a backfill
    // (render() owns the field set), so the test-injected stamp does not
    // survive it; re-stamp so the label still names the mcp-tool stamp.
    stamp(`Brain/decisions/decision-${SLUG}.md`, "origin_channel: mcp-tool\n");
    const backfilled = await callDecision(TRANSPORT_REACH.remote, { action: "show", slug: SLUG });
    expect(backfilled["outcome"]).toBe(fenceFor(AGENT_LABEL, OUTCOME));
  });

  test("a legacy decision page is fenced fail-closed", async () => {
    record("legacy");
    const remote = await callDecision(TRANSPORT_REACH.remote, {
      action: "show",
      slug: LEGACY_SLUG,
    });
    expect(remote["assumption"]).toBe(fenceFor(LEGACY_LABEL, ASSUMPTION));
    expect(remote["premortem"]).toBe(fenceFor(LEGACY_LABEL, PREMORTEM));
  });

  test("compare, list and similar rows fence their page-derived fields", async () => {
    record("agented");
    record("legacy");
    const localCompare = (await callDecision(TRANSPORT_REACH.local, {
      action: "compare",
      slugs: [SLUG, LEGACY_SLUG],
    })) as { decisions: Array<Record<string, unknown>> };
    const remoteCompare = (await callDecision(TRANSPORT_REACH.remote, {
      action: "compare",
      slugs: [SLUG, LEGACY_SLUG],
    })) as { decisions: Array<Record<string, unknown>> };
    // A compare row carries no rationale until one was authored; the
    // outcome field is the row's page-derived free text.
    await callDecision(TRANSPORT_REACH.remote, {
      action: "outcome",
      slug: SLUG,
      outcome: OUTCOME,
    });
    // Same writer round-trip as the show test: the backfill re-renders
    // the frontmatter, so re-stamp before the label-bearing assertions.
    stamp(`Brain/decisions/decision-${SLUG}.md`, "origin_channel: mcp-tool\n");
    const afterBackfill = (await callDecision(TRANSPORT_REACH.remote, {
      action: "compare",
      slugs: [SLUG],
    })) as { decisions: Array<Record<string, unknown>> };
    expect(localCompare.decisions).toHaveLength(2);
    expect(remoteCompare.decisions).toHaveLength(localCompare.decisions.length);
    expect(afterBackfill.decisions[0]!["outcome"]).toBe(fenceFor(AGENT_LABEL, OUTCOME));

    const localList = (await callDecision(TRANSPORT_REACH.local, {
      action: "list",
    })) as { decisions: Array<Record<string, unknown>> };
    expect(localList.decisions).toHaveLength(2);
    const remoteList = (await callDecision(TRANSPORT_REACH.remote, {
      action: "list",
    })) as { decisions: Array<Record<string, unknown>> };
    const listed = remoteList.decisions.find((d) => d["slug"] === SLUG)!;
    expect(listed["outcome"]).toBe(fenceFor(AGENT_LABEL, OUTCOME));

    const remoteSimilar = (await callDecision(TRANSPORT_REACH.remote, {
      action: "similar",
      title: TITLE,
    })) as { similar: Array<Record<string, unknown>> };
    const similar = remoteSimilar.similar.find((d) => d["slug"] === SLUG)!;
    expect(similar).toBeDefined();
    expect(similar["outcome"]).toBe(fenceFor(AGENT_LABEL, OUTCOME));
  });

  test("the recall render fences whole, and the write echo of an authored outcome does not", async () => {
    record("agented");
    const saved = process.env[RECALL_ENV_KEY];
    process.env[RECALL_ENV_KEY] = "3";
    try {
      const local = await callDecision(TRANSPORT_REACH.local, {
        action: "recall",
        prompt: "adopt the staged rollout",
      });
      const remote = await callDecision(TRANSPORT_REACH.remote, {
        action: "recall",
        prompt: "adopt the staged rollout",
      });
      const localText = local["text"] as string;
      expect(localText).toContain("Recalled decision");
      // The rendered block is page text: it fences whole, one closed span.
      expect(remote["text"]).toBe(fenceFor(AGENT_LABEL, localText));
    } finally {
      if (saved === undefined) delete process.env[RECALL_ENV_KEY];
      else process.env[RECALL_ENV_KEY] = saved;
    }
  });

  test("open-decision question prose fences at remote reach", async () => {
    const QUESTION = "zzopenquestionzz which vendor survives the audit";
    const CONTEXT = "zzopencontextzz the audit lands next quarter";
    const REASON = "zzdiscardreasonzz superseded by the procurement review";
    await callDecision(TRANSPORT_REACH.remote, {
      action: "open",
      title: "Vendor choice",
      question: QUESTION,
      options: ["keep", "swap"],
      context: CONTEXT,
    });
    const localList = (await callDecision(TRANSPORT_REACH.local, {
      action: "list_open",
    })) as { open_decisions: Array<Record<string, unknown>> };
    expect(localList.open_decisions).toHaveLength(1);
    expect(localList.open_decisions[0]!["question"]).toBe(QUESTION);
    const openId = localList.open_decisions[0]!["id"] as string;

    const remoteList = (await callDecision(TRANSPORT_REACH.remote, {
      action: "list_open",
    })) as { open_decisions: Array<Record<string, unknown>> };
    expect(remoteList.open_decisions[0]!["question"]).toBe(fenceFor(LEGACY_LABEL, QUESTION));

    const localShow = (await callDecision(TRANSPORT_REACH.local, {
      action: "show_open",
      id: openId,
    })) as Record<string, unknown>;
    const remoteShow = (await callDecision(TRANSPORT_REACH.remote, {
      action: "show_open",
      id: openId,
    })) as Record<string, unknown>;
    expect(localShow["context"]).toBe(CONTEXT);
    expect(remoteShow["question"]).toBe(fenceFor(LEGACY_LABEL, QUESTION));
    expect(remoteShow["context"]).toBe(fenceFor(LEGACY_LABEL, CONTEXT));

    await callDecision(TRANSPORT_REACH.remote, {
      action: "discard",
      id: openId,
      reason: REASON,
    });
    // list_open takes every status, so the closed record still reads back:
    // the discard reason is stored free text and fences like the rest.
    const after = (await callDecision(TRANSPORT_REACH.remote, {
      action: "show_open",
      id: openId,
    })) as Record<string, unknown>;
    expect(after["discard_reason"]).toBe(fenceFor(LEGACY_LABEL, REASON));
  });
});

describe("sibling report surfaces through the same binding", () => {
  test("brain_claims shapes the claim principle at remote reach", async () => {
    const local = await callKnowledge(TRANSPORT_REACH.local, { operation: "current" });
    const remote = await callKnowledge(TRANSPORT_REACH.remote, { operation: "current" });
    const localRows = local["claims"] as ReadonlyArray<Record<string, unknown>>;
    const remoteRows = remote["claims"] as ReadonlyArray<Record<string, unknown>>;
    // The legacy preference's claim row is the stored text this suite
    // already fences inside brain_query's preference payloads.
    const localLegacy = localRows.find((r) => r["id"] === "pref-legacy");
    const remoteLegacy = remoteRows.find((r) => r["id"] === "pref-legacy");
    expect(localLegacy).toBeDefined();
    expect(remoteLegacy).toBeDefined();
    expect(localLegacy!["principle"]).toBe(PREF_PRINCIPLE);
    expect(remoteLegacy!["principle"]).toBe(fenceFor(LEGACY_LABEL, PREF_PRINCIPLE));
  });

  test("brain_unlinked_mentions shapes the source page's prose line at remote reach", async () => {
    const local = await call("brain_unlinked_mentions", TRANSPORT_REACH.local, {
      id: "pref-agented",
    });
    const remote = await call("brain_unlinked_mentions", TRANSPORT_REACH.remote, {
      id: "pref-agented",
    });
    const localMentions = local["mentions"] as ReadonlyArray<Record<string, unknown>>;
    const remoteMentions = remote["mentions"] as ReadonlyArray<Record<string, unknown>>;
    expect(localMentions.length).toBeGreaterThan(0);
    expect(localMentions.length).toBe(remoteMentions.length);
    // The mention's context is the mentioning page's own prose - an
    // unstamped preference - so the remote delivery fences it naming
    // that page's derived provenance.
    expect(localMentions[0]!["context"]).toContain("pref-agented");
    expect(remoteMentions[0]!["context"]).toBe(
      fenceFor(LEGACY_LABEL, localMentions[0]!["context"] as string),
    );
  });
});
