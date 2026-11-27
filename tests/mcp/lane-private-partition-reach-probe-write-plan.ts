/**
 * The differential write probe of `lane-private-partition-reach` (the
 * write rule): its seeding, its calls and the snapshots it compares.
 *
 * Two stores are built by the same seeding code: one WITH a `private`
 * entry in every writer lane (and a private rejected and accepted skill
 * proposal, an interrupted private accept's journal, a private bridge
 * artifact and dismissal list, a private default attention flow), and a
 * twin WITHOUT any private entry. Every tool and every verb of the
 * registry is then called on each below local reach, read and write verbs
 * alike, with the same plan.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "bun:test";

import {
  attentionFlowsDir,
  procedurePath,
  skillProposalAcceptedPath,
} from "../../src/core/brain/paths.ts";
import { writeSkillAcceptJournal } from "../../src/core/brain/skill-accept-journal.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import {
  laneEntryInPrivate,
  removeLanePage,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import type { MCPServer } from "../../src/mcp/server.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  raiseBridgeArtifacts,
  seedBridgeIndex,
  seedRejectedName,
  writeProposal,
} from "./lane-private-partition-reach-maintenance-fixture.ts";
import {
  PROBE_SOURCE,
  PROBE_SOURCE_TEXT,
  WRITERS,
  type SeededEntry,
} from "./lane-private-partition-reach-probe-writers.ts";
import { HAND_ARGS } from "./lane-private-partition-reach-probe-identity.ts";
import { REGION, call } from "./lane-private-partition-reach-writes-fixture.ts";

/** One lane as the plan names it: the tool that owns it, and its entries. */
export interface ProbeLane {
  readonly lane: string;
  readonly tool: string;
  readonly shared: SeededEntry;
  readonly hidden?: SeededEntry;
  /**
   * More private entries of the lane in states of their own (an accepted
   * proposal, an interrupted accept, the default attention flow), each a
   * call target of its own.
   */
  readonly extraHidden?: ReadonlyArray<{ readonly state: string; readonly entry: SeededEntry }>;
}

const NOW = new Date("2026-11-20T10:00:00Z");
const PROPOSAL = (id: string): SeededEntry => ({
  rel: `Brain/skill-proposals/pending/${id}.md`,
  marks: [{ field: "slug", mark: id }],
  id,
  title: id,
});

/**
 * Seed one store. `withPrivate` adds the private entries; the twin is
 * the same seeding without them. `sharedOnly` (a twin) also leaves out the
 * shared bridge artifacts the private store raises into `private`, so the
 * twin holds the shared records of the private store.
 */
export async function seedProbeStore(
  e: LaneEnv,
  local: MCPServer,
  withPrivate: boolean,
  sharedOnly = false,
): Promise<ProbeLane[]> {
  const { vault } = e;
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, PROBE_SOURCE), PROBE_SOURCE_TEXT, "utf8");
  const lanes: ProbeLane[] = [];
  for (const row of WRITERS) {
    // oxlint-disable-next-line no-await-in-loop -- one store, written in order
    const hidden = withPrivate ? await row.seed(e, local, true) : undefined;
    // oxlint-disable-next-line no-await-in-loop -- one store, written in order
    const shared = await row.seed(e, local, false);
    lanes.push({ lane: row.lane, tool: row.reader.tool, shared, ...(hidden ? { hidden } : {}) });
  }
  // Skill proposals: a shared pending one; with private entries, a
  // rejected and an accepted one held in `private`, and the journal of an
  // accept stopped after its private writes.
  writeProposal(vault, "zqpwshrslug", "zqpwshrbody shared");
  if (withPrivate) {
    writeProposal(vault, "zqpwhidrej", `zqpwhidrejbody ${REGION}`);
    await call(local, "brain_skill_proposals", {
      operation: "reject",
      slug: "zqpwhidrej",
      note: `zqpwhidrejnote ${REGION}`,
    });
    writeProposal(vault, "zqpwhidacc", `zqpwhidaccbody ${REGION}`);
    await call(local, "brain_skill_proposals", { operation: "accept", slug: "zqpwhidacc" });
    writeProposal(vault, "zqpwhidjrn", `zqpwhidjrnbody ${REGION}`);
    writeLanePage(
      vault,
      skillProposalAcceptedPath(vault, "zqpwhidjrn"),
      { kind: "brain-skill-proposal", id: "prop-zqpwhidjrn", slug: "zqpwhidjrn" },
      `# zqpwhidjrn\n\nzqpwhidjrnbody ${REGION}\n`,
    );
    writeSkillAcceptJournal(vault, {
      slug: "zqpwhidjrn",
      id: "prop-zqpwhidjrn",
      phase: "materialize",
      startedAt: NOW.toISOString(),
      acceptedExisted: false,
      materializedExisted: false,
      materializedPath: procedurePath(vault, "zqpwhidjrn"),
    });
  }
  lanes.push({
    lane: "skill-proposals",
    tool: "brain_skill_proposals",
    shared: PROPOSAL("zqpwshrslug"),
    ...(withPrivate
      ? {
          hidden: {
            ...PROPOSAL("zqpwhidrej"),
            marks: [
              { field: "slug", mark: "zqpwhidrej" },
              { field: "body", mark: "zqpwhidrejbody" },
              { field: "note", mark: "zqpwhidrejnote" },
              { field: "accepted", mark: "zqpwhidaccbody" },
              { field: "journal", mark: "zqpwhidjrn" },
            ],
          },
          // The accepted proposal and the interrupted accept, each named
          // by calls of its own.
          extraHidden: [
            {
              state: "accepted",
              entry: {
                ...PROPOSAL("zqpwhidacc"),
                rel: "Brain/skill-proposals/accepted/prop-zqpwhidacc.md",
                marks: [
                  { field: "slug", mark: "zqpwhidacc" },
                  { field: "body", mark: "zqpwhidaccbody" },
                ],
              },
            },
            {
              state: "journal",
              entry: {
                ...PROPOSAL("zqpwhidjrn"),
                rel: "Brain/skill-proposals/accepted/prop-zqpwhidjrn.md",
                marks: [
                  { field: "slug", mark: "zqpwhidjrn" },
                  { field: "body", mark: "zqpwhidjrnbody" },
                ],
              },
            },
          ],
        }
      : {}),
  });
  // Learning: a drafted name rejected by a person (in `private` with
  // private entries), then new evidence of it, for a later learn.
  await seedRejectedName(e, local, withPrivate);
  // Bridges: an index, a dismissal and an artifact; held in `private`
  // with private entries.
  const { privatePair } = await seedBridgeIndex(e);
  await call(local, "brain_bridges", {
    operation: "dismiss",
    source: privatePair[0],
    target: privatePair[1],
  });
  await call(local, "brain_bridges", { operation: "discover", min_similarity: 0.1 });
  if (withPrivate) raiseBridgeArtifacts(vault);
  if (sharedOnly) {
    for (const name of ["bridges.md", "bridges-dismissed.json"]) {
      removeLanePage(vault, join(vault, "Brain", "proposals", name));
    }
  }
  // The default attention flow: seeded by a local list, then held in
  // `private` with private entries.
  await call(local, "brain_analytics", { view: "attention_flows", operation: "list" });
  if (withPrivate) {
    writeLanePage(
      vault,
      join(attentionFlowsDir(vault), "open-loops.md"),
      {
        kind: "brain-attention-flow",
        id: "open-loops",
        title: "zqpwhidflow",
        actions: ["open_proposals"],
      },
      `# zqpwhidflow\n\n${REGION}\n`,
      { overwrite: true },
    );
    expect(laneEntryInPrivate(vault, join(attentionFlowsDir(vault), "open-loops.md"))).toBe(true);
    // Its title is a canary, and calls name it.
    const flows = lanes.findIndex((l) => l.lane === "attention flows");
    expect(flows).toBeGreaterThanOrEqual(0);
    lanes[flows] = {
      ...lanes[flows]!,
      extraHidden: [
        {
          state: "default",
          entry: {
            rel: "Brain/attention/flows/open-loops.md",
            marks: [{ field: "title", mark: "zqpwhidflow" }],
            id: "open-loops",
            title: "zqpwhidflow",
          },
        },
      ],
    };
  }
  return lanes;
}

// ----- The calls -------------------------------------------------------------------

const ACTION_KEYS = ["action", "operation", "op", "view", "mode"] as const;
const QUERY_PROPS = new Set(["query", "q", "pattern", "prompt", "question", "topic"]);
const ID_PROPS = new Set([
  "id",
  "slug",
  "slugs",
  "pref_id",
  "chunk_id",
  "artifact_id",
  "content_hash",
  "session_id",
  "skill_name",
  "entity",
  "scope",
  "name",
  "subject",
  "flow_id",
  "preset_id",
  "target",
]);
const PATH_PROPS = new Set(["path", "file_path", "source_file", "source", "page", "artifact"]);

/** One planned call: its label (the same in both stores) and its arguments. */
export interface ProbeCall {
  readonly tool: string;
  readonly verb: string;
  /**
   * `base`, or `<lane>:shared` / `<lane>:hidden` (`<lane>:hidden <state>`
   * for an extra private entry) for a call naming a seeded entry.
   */
  readonly names: string;
  readonly args: Record<string, unknown>;
  /** The lane of the entry it names, if any. */
  readonly lane?: string;
  /** Whether the entry it names is held in `private`. */
  readonly hidden?: boolean;
}

type Spec = { type?: string | string[]; enum?: unknown[]; items?: { type?: string } };

/** A value for a property the plan has no entry for, or undefined when none is sensible. */
function plainValue(prop: string, spec: Spec): unknown {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) return spec.enum[0];
  const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
  if (type === "string") return `zqprobewrite ${prop}`;
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return false;
  if (type === "array" && spec.items?.type === "string") return [`zqprobewrite ${prop}`];
  return undefined;
}

function entryValue(prop: string, spec: Spec, entry: SeededEntry | undefined): unknown {
  const asType = (v: string): unknown => (spec.type === "array" ? [v] : v);
  if (QUERY_PROPS.has(prop)) return asType(entry === undefined ? "zqcommonword" : entry.title);
  if (ID_PROPS.has(prop)) return asType(entry === undefined ? "probe-absent-id" : entry.id);
  if (PATH_PROPS.has(prop))
    return asType(entry === undefined ? "Brain/probe-absent.md" : entry.rel);
  return undefined;
}

/** Every call of `tool`, and the verbs skipped with the reason. */
export function planTool(
  tool: ToolDefinition,
  lanes: ReadonlyArray<ProbeLane>,
): { calls: ProbeCall[]; skipped: string[] } {
  const s = (tool.inputSchema ?? {}) as { properties?: Record<string, Spec>; required?: string[] };
  const props = s.properties ?? {};
  const required = s.required ?? [];
  const actionKey =
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum) && required.includes(k)) ??
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum));
  const verbs: Array<string | undefined> =
    actionKey === undefined ? [undefined] : (props[actionKey]!.enum as string[]);
  const idLike = Object.keys(props).filter(
    (p) => QUERY_PROPS.has(p) || ID_PROPS.has(p) || PATH_PROPS.has(p),
  );
  const owned = lanes.filter((l) => l.tool === tool.name);
  const calls: ProbeCall[] = [];
  const skipped: string[] = [];
  // An optional verb key of its own (`brain_analytics`: `operation` under
  // a `view`) is called with each of its values.
  const subKey = ACTION_KEYS.find(
    (k) => k !== actionKey && Array.isArray(props[k]?.enum) && !required.includes(k),
  );
  const subVerbs: Array<string | undefined> =
    subKey === undefined ? [undefined] : [undefined, ...(props[subKey]!.enum as string[])];
  const combos = verbs.flatMap((verb) => subVerbs.map((sub) => ({ verb, sub })));
  for (const { verb, sub } of combos) {
    const label = [verb ?? "(no verb)", ...(sub !== undefined ? [`${subKey}=${sub}`] : [])].join(
      " ",
    );
    const base: Record<string, unknown> = {};
    if (actionKey !== undefined) base[actionKey] = verb;
    if (subKey !== undefined && sub !== undefined) base[subKey] = sub;
    // Every entry argument, required or not, names an absent entry in the
    // base call, so a verb that acts on one is reached.
    for (const p of idLike) base[p] = entryValue(p, props[p] ?? {}, undefined);
    const hand = HAND_ARGS[tool.name] ?? {};
    Object.assign(base, hand);
    let missing: string | null = null;
    for (const req of required) {
      if (req === actionKey || req in hand) continue;
      const v = entryValue(req, props[req] ?? {}, undefined) ?? plainValue(req, props[req] ?? {});
      if (v === undefined) missing = req;
      else base[req] = v;
    }
    if (missing !== null) {
      skipped.push(`${tool.name} ${label}: required '${missing}' has no sensible probe value`);
      continue;
    }
    calls.push({ tool: tool.name, verb: label, names: "base", args: base });
    if (idLike.length === 0) continue;
    for (const lane of owned) {
      const targets: Array<{ names: string; entry: SeededEntry | undefined; hidden: boolean }> = [
        { names: `${lane.lane}:shared`, entry: lane.shared, hidden: false },
        { names: `${lane.lane}:hidden`, entry: lane.hidden, hidden: true },
        ...(lane.extraHidden ?? []).map((x) => ({
          names: `${lane.lane}:hidden ${x.state}`,
          entry: x.entry,
          hidden: true,
        })),
      ];
      for (const target of targets) {
        if (target.entry === undefined) continue;
        const args = { ...base };
        for (const p of idLike) args[p] = entryValue(p, props[p] ?? {}, target.entry);
        Object.assign(args, hand);
        calls.push({
          tool: tool.name,
          verb: label,
          names: target.names,
          args,
          lane: lane.lane,
          hidden: target.hidden,
        });
      }
    }
  }
  return { calls, skipped };
}

// ----- The snapshots ---------------------------------------------------------------

export interface StoreSnapshot {
  /** Live entries whose winning record is in `private`, by key: their value, serialized. */
  readonly privateEntries: ReadonlyMap<string, string>;
  /** Live shared keys. */
  readonly sharedKeys: ReadonlySet<string>;
  /** The fields of the live shared entries, by key. */
  readonly sharedFields: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** Machine-state and device-state files: path relative to the env, and their text. */
  readonly stateFiles: ReadonlyMap<string, string>;
}

function filesUnder(root: string, base: string, out: Map<string, string>): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) filesUnder(path, base, out);
    else if (st.size < 2_000_000)
      out.set(path.slice(base.length + 1), readFileSync(path, "latin1"));
  }
}

/** The store's lane entries and the machine's state files, read at local reach. */
export function snapshot(e: LaneEnv): StoreSnapshot {
  const fold = wholeLaneStoreFold();
  const privateEntries = new Map<string, string>();
  const sharedKeys = new Set<string>();
  const sharedFields = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [key, value] of fold.entries) {
    if (fold.privateKeys.has(key)) {
      privateEntries.set(key, JSON.stringify({ fields: value.fields, text: value.text }));
    } else {
      sharedKeys.add(key);
      sharedFields.set(key, value.fields as Readonly<Record<string, unknown>>);
    }
  }
  const stateFiles = new Map<string, string>();
  filesUnder(join(e.env.parent, "state"), e.env.parent, stateFiles);
  filesUnder(join(e.env.parent, "home"), e.env.parent, stateFiles);
  return { privateEntries, sharedKeys, sharedFields, stateFiles };
}
