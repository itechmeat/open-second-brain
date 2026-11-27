/**
 * The writer table of `lane-private-partition-reach-probe.test.ts`: one row
 * per lane a tool reads that has a real writer. Each row seeds one hidden
 * entry (a `<private>` region in its text, no `visibility:` field, so the
 * store holds it in `private` by partition alone) and one shared control
 * through the lane's own writer, and names the lane's own reader, which a
 * local caller uses to prove the hidden entry can be seen at all.
 *
 * Every mark is unique to its row and to hidden or shared (`hid`, `shr`),
 * so a mark found in an answer names the lane and the entry it came from.
 */

import { join } from "node:path";

import { openDecision } from "../../src/core/brain/decisions/open-store.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { setIntention } from "../../src/core/brain/intentions.ts";
import { addObligation } from "../../src/core/brain/obligations.ts";
import { createPledgePage } from "../../src/core/brain/pledges.ts";
import { persistTension } from "../../src/core/brain/tensions.ts";
import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { attentionFlowsDir } from "../../src/core/brain/paths.ts";
import { writeLanePage, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { brainRelOfEntry } from "../../src/core/store/lane-paths.ts";
import type { MCPServer } from "../../src/mcp/server.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const REGION = "<private>synthetic region body</private>";
const AGENT = "tester";
const NOW = new Date("2026-11-20T10:00:00Z");

/** The vault page every source-citing writer cites. */
export const PROBE_SOURCE = "Notes/source.md";
export const PROBE_SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";

/** One seeded entry: where it is, the marks only it carries, and the values that name it. */
export interface SeededEntry {
  /** The vault-relative POSIX path of its page. */
  readonly rel: string;
  readonly marks: ReadonlyArray<{ readonly field: string; readonly mark: string }>;
  /** The id or slug an argument names it by. */
  readonly id: string;
  /** The title a query names it by. */
  readonly title: string;
}

export interface WriterRow {
  /** The lane, as the report names it. */
  readonly lane: string;
  /** Seed one entry; `hidden` puts a `<private>` region in its text. */
  readonly seed: (e: LaneEnv, local: MCPServer, hidden: boolean) => Promise<SeededEntry>;
  /** The lane's own reader, called once at local reach. */
  readonly reader: { readonly tool: string; readonly args: Record<string, unknown> };
}

type Kind = "hid" | "shr";
const kindOf = (hidden: boolean): Kind => (hidden ? "hid" : "shr");
const region = (hidden: boolean): string => (hidden ? `\n\n${REGION}` : "");

/** The serialized answer of a tool call, or the refusal as `{"error": ...}`. */
async function json(
  s: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = (await s.callTool(tool, args)) as Record<string, unknown>;
  return (r["structuredContent"] ?? r) as Record<string, unknown>;
}

/** The entry id of the lane record a tool wrote, found by a mark its body carries. */
function recordWith(e: LaneEnv, lane: string, mark: string): string {
  const record = e
    .laneRecords()
    .map((r) => r.body)
    .find((body) => body["lane"] === lane && JSON.stringify(body).includes(mark));
  if (record === undefined) throw new Error(`probe writer: no ${lane} record carries ${mark}`);
  return String(record["entry"]);
}

const rel = (e: LaneEnv, path: string): string =>
  path
    .slice(e.vault.length + 1)
    .split("\\")
    .join("/");

export const WRITERS: ReadonlyArray<WriterRow> = [
  {
    lane: "entities",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const { entity } = upsertEntity(e.vault, {
        category: "people",
        name: `Zqwent${k}name Person`,
        agent: AGENT,
        now: NOW,
        body: `zqwent${k}body notes${region(hidden)}\n`,
      });
      const marks = [
        { field: "title", mark: `Zqwent${k}name` },
        { field: "slug", mark: `zqwent${k}name` },
        { field: "body", mark: `zqwent${k}body` },
      ];
      return { rel: rel(e, entity.path), marks, id: entity.id, title: entity.name };
    },
    reader: { tool: "brain_entity", args: { view: "list" } },
  },
  {
    lane: "triggers",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const { created } = createTriggers(
        e.vault,
        [
          {
            kind: "contradiction",
            urgency: "medium",
            reason: `zqwtrg${k}reason`,
            suggestedAction: "review it",
            sourceArtifacts: [PROBE_SOURCE],
            contextSnippets: [hidden ? REGION : "plain"],
            cooldownKey: `contradiction:zqwtrg${k}key`,
          },
        ],
        { now: NOW },
      );
      const t = created[0]!;
      const marks = [
        { field: "reason", mark: `zqwtrg${k}reason` },
        { field: "key", mark: `zqwtrg${k}key` },
      ];
      return { rel: rel(e, t.path), marks, id: t.id, title: `zqwtrg${k}reason` };
    },
    reader: { tool: "brain_trigger", args: { operation: "list" } },
  },
  {
    lane: "decisions (open)",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const d = openDecision(e.vault, {
        title: `Zqwopn${k}title route`,
        question: `Which zqwopn${k}question route do we take?`,
        options: ["left", "right"],
        context: `zqwopn${k}context${region(hidden)}`,
        agent: AGENT,
        now: NOW,
      });
      const marks = [
        { field: "title", mark: `Zqwopn${k}title` },
        { field: "question", mark: `zqwopn${k}question` },
        { field: "context", mark: `zqwopn${k}context` },
      ];
      return { rel: rel(e, d.path), marks, id: d.id, title: `Zqwopn${k}title route` };
    },
    reader: { tool: "brain_decision", args: { action: "list_open" } },
  },
  {
    lane: "decisions",
    seed: async (e, local, hidden) => {
      const k = kindOf(hidden);
      const recorded = await json(local, "brain_decision", {
        action: "record",
        title: `Zqwdec${k}title choice`,
        chosen: `zqwdec${k}chosen path`,
        assumption: "it holds",
        review_date: "2026-12-01",
        notes: `zqwdec${k}notes${region(hidden)}`,
      });
      const id = recorded["id"];
      // A decision recorded without an id would seed an entry at no path.
      if (typeof id !== "string" || id === "") {
        throw new Error(
          `probe writer: the recorded decision has no id: ${JSON.stringify(recorded)}`,
        );
      }
      const marks = [
        { field: "title", mark: `Zqwdec${k}title` },
        { field: "chosen", mark: `zqwdec${k}chosen` },
        { field: "notes", mark: `zqwdec${k}notes` },
      ];
      return { rel: `Brain/decisions/${id}.md`, marks, id, title: `Zqwdec${k}title choice` };
    },
    reader: { tool: "brain_decision", args: { action: "list" } },
  },
  {
    lane: "intentions",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const scope = `zqwint${k}scope`;
      setIntention(e.vault, { scope, text: `zqwint${k}text${region(hidden)}`, agent: AGENT });
      const marks = [
        { field: "scope", mark: scope },
        { field: "text", mark: `zqwint${k}text` },
      ];
      return { rel: `Brain/intentions/${scope}.md`, marks, id: scope, title: scope };
    },
    reader: { tool: "brain_intention", args: { operation: "list" } },
  },
  {
    lane: "dead-ends",
    seed: async (e, local, hidden) => {
      const k = kindOf(hidden);
      await json(local, "brain_dead_ends", {
        operation: "record",
        approach: `zqwded${k}approach`,
        reason: `zqwded${k}reason failed`,
        ...(hidden ? { context: `zqwdedcontext${region(hidden)}` } : {}),
      });
      const entry = recordWith(e, "dead-ends", `zqwded${k}approach`);
      const marks = [
        { field: "approach", mark: `zqwded${k}approach` },
        { field: "reason", mark: `zqwded${k}reason` },
      ];
      const id = entry.replace(/^.*\//, "").replace(/\.md$/, "");
      const path = `Brain/${brainRelOfEntry("dead-ends", entry)}`;
      return { rel: path, marks, id, title: `zqwded${k}approach` };
    },
    reader: { tool: "brain_dead_ends", args: { operation: "list" } },
  },
  {
    lane: "write sessions",
    seed: async (e, local, hidden) => {
      const k = kindOf(hidden);
      await json(local, "brain_write_session", {
        op: "open",
        kind: "artifact",
        target: `Brain/reports/zqwses${k}target.md`,
        prompt: `zqwses${k}prompt draft it${region(hidden)}`,
      });
      const entry = recordWith(e, "write-session", `zqwses${k}target`);
      // A second session, ended at once: its terminal audit event names the
      // session and its target (design D12).
      await json(local, "brain_write_session", {
        op: "open",
        kind: "artifact",
        target: `Brain/reports/zqwses${k}target-ended.md`,
        prompt: `zqwses${k}prompt ended${region(hidden)}`,
      });
      const ended = recordWith(e, "write-session", `zqwses${k}target-ended`);
      await json(local, "brain_write_session", {
        op: "abandon",
        session_id: ended.replace(/^.*\//, "").replace(/\.json$/, ""),
      });
      const marks = [
        { field: "target", mark: `zqwses${k}target` },
        { field: "prompt", mark: `zqwses${k}prompt` },
      ];
      const id = entry.replace(/^.*\//, "").replace(/\.json$/, "");
      const path = `Brain/${brainRelOfEntry("write-session", entry)}`;
      return { rel: path, marks, id, title: `zqwses${k}target` };
    },
    reader: { tool: "brain_write_session", args: { op: "list" } },
  },
  {
    lane: "pledges",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const page = createPledgePage(e.vault, {
        title: `Zqwplg${k}title report`,
        due: "2026-12-01",
        source: PROBE_SOURCE,
        sourceText: PROBE_SOURCE_TEXT,
        evidence: ["We will ship the report."],
        visibility: [],
        agent: AGENT,
        notes: `zqwplg${k}notes${region(hidden)}`,
      });
      const marks = [
        { field: "title", mark: `Zqwplg${k}title` },
        { field: "notes", mark: `zqwplg${k}notes` },
      ];
      return { rel: rel(e, page.path), marks, id: page.slug, title: `Zqwplg${k}title report` };
    },
    reader: { tool: "brain_pledge", args: { operation: "list" } },
  },
  {
    lane: "obligations",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const page = addObligation(e.vault, {
        title: `Zqwobl${k}title check`,
        cadence: "weekly",
        agent: AGENT,
        notes: `zqwobl${k}notes${region(hidden)}`,
      });
      const marks = [
        { field: "title", mark: `Zqwobl${k}title` },
        { field: "notes", mark: `zqwobl${k}notes` },
      ];
      return { rel: rel(e, page.path), marks, id: page.slug, title: `Zqwobl${k}title check` };
    },
    reader: { tool: "brain_obligation", args: { operation: "list" } },
  },
  {
    lane: "tensions",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const { record } = persistTension(
        e.vault,
        {
          aId: `zqwten${k}a`,
          bId: `zqwten${k}b`,
          subject: `zqwten${k}subject`,
          jaccard: 0.5,
          aSign: "positive",
          bSign: "negative",
          aQuote: `zqwten${k}quote one${region(hidden)}`,
          bQuote: "another quote",
          action: "ask_user",
        },
        { now: NOW },
      );
      const marks = [
        { field: "ids", mark: `zqwten${k}a` },
        { field: "subject", mark: `zqwten${k}subject` },
        { field: "quote", mark: `zqwten${k}quote` },
      ];
      return { rel: rel(e, record.path), marks, id: record.slug, title: `zqwten${k}subject` };
    },
    reader: { tool: "brain_tension", args: { action: "list" } },
  },
  {
    lane: "procedures",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const path = `Brain/procedures/zqwprc${k}slug.md`;
      writeLaneText(
        e.vault,
        join(e.vault, path),
        `---\ntriggers:\n  - zqwprc${k}trigger\n---\n\n# Zqwprc${k}title\n\n` +
          `zqwprc${k}body steps${region(hidden)}\n`,
      );
      const marks = [
        { field: "slug", mark: `zqwprc${k}slug` },
        { field: "title", mark: `Zqwprc${k}title` },
        { field: "trigger", mark: `zqwprc${k}trigger` },
      ];
      return { rel: path, marks, id: `zqwprc${k}slug`, title: `Zqwprc${k}title` };
    },
    reader: { tool: "brain_procedural_memory", args: { operation: "list" } },
  },
  {
    lane: "attention flows",
    seed: async (e, _local, hidden) => {
      const k = kindOf(hidden);
      const path = join(attentionFlowsDir(e.vault), `zqwflw${k}id.md`);
      writeLanePage(
        e.vault,
        path,
        {
          kind: "brain-attention-flow",
          id: `zqwflw${k}id`,
          title: `Zqwflw${k}title`,
          actions: ["open_proposals"],
        },
        `# Zqwflw${k}title\n\nzqwflw${k}body steps${region(hidden)}\n`,
      );
      const marks = [
        { field: "id", mark: `zqwflw${k}id` },
        { field: "title", mark: `Zqwflw${k}title` },
        { field: "body", mark: `zqwflw${k}body` },
      ];
      return { rel: rel(e, path), marks, id: `zqwflw${k}id`, title: `Zqwflw${k}title` };
    },
    reader: { tool: "brain_analytics", args: { view: "attention_flows", operation: "list" } },
  },
];

/**
 * The projections a local operator builds from the seeded lanes (the
 * procedural index, graph and hints), built at local reach after seeding.
 */
export async function buildProjections(local: MCPServer): Promise<void> {
  await local.callTool("brain_procedural_memory", { operation: "reconcile" });
  await local.callTool("brain_procedural_graph", { operation: "rebuild" });
}
