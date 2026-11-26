/**
 * Registry-wide probe: no tool of the real registry hands a caller below
 * local reach a lane entry the store holds in its `private` partition.
 *
 * The lanes are enumerated from the code, not from a hand list:
 *
 *  - the lanes the migration catalogue names (`migrationCatalogue`: every
 *    `entries` locator with a lane of its own, such as `exact-state` or
 *    `write-session`);
 *  - the catch-all lane: every top folder under `Brain/` the source tree
 *    names (`Brain/<x>`, `"Brain", "<x>"`, `BRAIN_ROOT_REL, "<x>"`, and the
 *    `Brain/...` constants of `path-constants.ts`, nested folders too)
 *    that maps to a lane entry and back (`lanePlaceOf`) and that no other
 *    catalogue location takes (signals, preferences, the log...).
 *
 * Every lane gets one entry whose text holds a `<private>` region (the
 * store holds it in `private`; its frontmatter reserves nothing) and whose
 * fields carry unique canary marks, plus one ordinary shared entry with
 * marks of its own. A lane with a real writer is seeded through it (the
 * writer table, `lane-private-partition-reach-probe-writers.ts`); any
 * other lane folder through `writeLaneText` in a page format. At local
 * reach each writer lane's own reader is called once and must show its
 * hidden entry, so a silent answer below local reach is evidence. Then
 * every tool of the registry (`buildToolTable`, hidden aliases included)
 * is called with its read verbs, built from its input schema, as a caller
 * below local reach, each distinct call once, and the serialized answer or
 * error is searched for every canary.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import * as pathConstants from "../../src/core/brain/path-constants.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { migrationCatalogue } from "../../src/core/store-migration/catalogue.ts";
import type { Locator } from "../../src/core/store-migration/destinations.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { lanePlaceOf } from "../../src/core/store/lane-paths.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ToolDefinition } from "../../src/mcp/tool-contract.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  buildProjections,
  PROBE_SOURCE,
  PROBE_SOURCE_TEXT,
  WRITERS,
  type SeededEntry,
  type WriterRow,
} from "./lane-private-partition-reach-probe-writers.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const SRC = join(REPO, "src");
/** A word every seeded entry carries, so a search finds them all. */
const COMMON = "zqcommonword";
const REGION = "<private>synthetic region body</private>";
const CREATED_AT = "2026-11-01T00:00:00Z";
const AGENT = "tester";
/** One call may not hold the probe longer than this. */
const CALL_TIMEOUT_MS = 15_000;

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

// ----- The lanes, from the code ---------------------------------------------------

/** Every `.ts` file under `dir`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The `Brain/`-relative folders the source tree names (top folders and nested ones). */
function namedBrainFolders(): Set<string> {
  const folders = new Set<string>();
  const add = (rel: string): void => {
    const segments = rel.split("/").filter((s) => s !== "");
    // Only folder names: a segment with an extension is a file.
    for (let n = 1; n <= segments.length; n++) {
      const head = segments.slice(0, n);
      if (head.some((s) => /\.(md|json|jsonl|yaml|yml|txt|sqlite|base|csv|lock)$/.test(s))) break;
      folders.add(head.join("/"));
    }
  };
  const patterns = [
    /BRAIN_ROOT_REL,\s*"([A-Za-z0-9._-]+)"/g,
    /"Brain",\s*"([A-Za-z0-9._-]+)"/g,
    /["'`]Brain\/([A-Za-z0-9._/-]+)["'`/]/g,
  ];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) add(match[1]!.replace(/\/+$/, ""));
    }
  }
  for (const value of Object.values(pathConstants)) {
    if (typeof value === "string" && value.startsWith("Brain/")) add(value.slice("Brain/".length));
  }
  return folders;
}

/** Catalogue lanes the probe cannot seed as lane pages, with the reason. */
const UNSEEDABLE: string[] = [];

interface LaneFolder {
  /** The folder, relative to `Brain/`. */
  readonly folder: string;
  readonly lane: string;
  readonly source: "catalogue" | "catch-all";
}

/** Every lane folder the store keeps lane pages for, from the catalogue and the source tree. */
function laneFolders(vault: string): LaneFolder[] {
  const brain = join(vault, "Brain");
  const catalogue = migrationCatalogue(vault);
  const explicit: LaneFolder[] = [];
  /** Directories another catalogue location takes whole (not as lane entries). */
  const taken: string[] = [];
  for (const entry of catalogue) {
    for (const locator of entry.locators as ReadonlyArray<Locator>) {
      if (locator.shape === "entries") {
        if (locator.lane === null) continue;
        const rel = relative(brain, locator.root).split(sep).join("/");
        if (rel.startsWith("..") || rel === "" || rel.endsWith(".md")) continue;
        // A lane the store fills by its own path (a blob lane such as the
        // write images) has no lane page at a legacy path to seed.
        if (lanePlaceOf(`${rel}/probe-entry.md`) === null) {
          UNSEEDABLE.push(`${rel} (lane ${locator.lane}): no lane page at its legacy path`);
          continue;
        }
        explicit.push({ folder: rel, lane: locator.lane, source: "catalogue" });
      } else if (locator.shape === "pages" || locator.shape === "json-files") {
        taken.push(locator.dir);
      } else if (locator.shape === "tree" && locator.grammar === undefined) {
        taken.push(locator.path);
      }
    }
  }
  const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root + sep);
  const out = new Map<string, LaneFolder>();
  for (const e of explicit) out.set(e.folder, e);
  for (const folder of namedBrainFolders()) {
    if (out.has(folder)) continue;
    const top = folder.split("/")[0]!;
    // A dot folder is machinery unless the catalogue names it a lane.
    if (top.startsWith(".") && !explicit.some((e) => e.folder.split("/")[0] === top)) continue;
    const place = lanePlaceOf(`${folder}/probe-entry.md`);
    if (place === null) continue;
    const dir = join(brain, ...folder.split("/"));
    if (taken.some((root) => inside(dir, root))) continue;
    out.set(folder, { folder, lane: place.lane, source: "catch-all" });
  }
  return [...out.values()].toSorted((a, b) => a.folder.localeCompare(b.folder));
}

// ----- The seeded entries -----------------------------------------------------------

interface Seeded {
  /** The lane, as the report names it. */
  readonly lane: string;
  readonly by: "writer" | "writeLaneText";
  readonly hidden: SeededEntry;
  readonly shared: SeededEntry;
  /** The lane's own reader, for a lane seeded by its writer. */
  readonly reader?: WriterRow["reader"];
}

function pageText(slug: string, title: string, bodyMark: string, region: boolean): string {
  const front = [
    `title: ${title}`,
    `name: ${title}`,
    `slug: ${slug}`,
    `id: ${slug}`,
    `created_at: ${CREATED_AT}`,
    `updated_at: ${CREATED_AT}`,
    `agent: ${AGENT}`,
  ].join("\n");
  const body = [`# ${title}`, "", `${bodyMark} ${COMMON} synthetic probe text.`];
  if (region) body.push("", REGION);
  return `---\n${front}\n---\n\n${body.join("\n")}\n`;
}

/** Seed every writer lane through its writer, the hidden entry first. */
async function seedWriters(env: LaneEnv, local: MCPServer): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (const row of WRITERS) {
    // oxlint-disable-next-line no-await-in-loop -- the writers share one store, written in order
    const hidden = await row.seed(env, local, true);
    // oxlint-disable-next-line no-await-in-loop -- the writers share one store, written in order
    const shared = await row.seed(env, local, false);
    out.push({ lane: row.lane, by: "writer", hidden, shared, reader: row.reader });
  }
  return out;
}

/** Seed every other lane folder with `writeLaneText` in a page format. */
function seedText(vault: string, folders: ReadonlyArray<LaneFolder>, offset: number): Seeded[] {
  return folders.map((folder, i) => {
    const index = offset + i;
    const mk = (kind: "hid" | "shr"): SeededEntry => {
      const slug = `zqslug${index}${kind}`;
      const title = `zqtitle${index}${kind} ${COMMON}`;
      const body = `zqbody${index}${kind}`;
      const rel = `Brain/${folder.folder}/${slug}.md`;
      writeLaneText(vault, join(vault, rel), pageText(slug, title, body, kind === "hid"));
      const marks = [
        { field: "title", mark: `zqtitle${index}${kind}` },
        { field: "slug", mark: slug },
        { field: "body", mark: body },
      ];
      return { rel, marks, id: slug, title };
    };
    return { lane: folder.folder, by: "writeLaneText", hidden: mk("hid"), shared: mk("shr") };
  });
}

/** The canary marks of a hidden entry. */
function canaries(s: Seeded): SeededEntry["marks"] {
  return s.hidden.marks;
}

// ----- The calls, from the registry ----------------------------------------------------

const ACTION_KEYS = ["action", "operation", "op", "view", "mode"] as const;
/**
 * The verbs of a write-kind tool that only read. A verb name, not a lane:
 * every other verb of a write tool is skipped and named in the output.
 */
const READ_VERBS = new Set([
  "list",
  "show",
  "get",
  "status",
  "history",
  "hints",
  "summary",
  "current",
  "at",
  "replaced",
  "contests",
  "conflicts",
  "slots",
  "aggregate",
  "collisions",
  "events",
  "state",
  "list_open",
  "show_open",
  "compare",
  "similar",
  "recall",
  "read",
  "usage",
  "evidence",
  "page_candidates",
  "scan",
  "check",
  "verify",
  "morning",
  "daily",
  "weekly",
  "monthly",
  "operator",
  "digest",
  "today",
  "timeline",
  "attention_flows",
  "belief_evolution",
  "concept_synthesis",
  "dedup",
  "suggest",
  "gate_list",
  "gate_summary",
]);
/**
 * The read verbs that list rather than name one entry: called once, with
 * no per-lane argument (an id, path or title passed to them names nothing).
 */
const LIST_VERBS = new Set([
  "list",
  "list_open",
  "summary",
  "aggregate",
  "collisions",
  "slots",
  "events",
  "state",
  "hints",
  "morning",
  "daily",
  "weekly",
  "monthly",
  "operator",
  "digest",
  "today",
  "timeline",
  "attention_flows",
  "belief_evolution",
  "concept_synthesis",
  "gate_list",
  "gate_summary",
]);
/** Write tools with no verb whose call with no write argument only reads. */
const READ_ONLY_CALLS = new Set([
  "brain_context",
  "brain_doctor",
  "brain_idea_discovery",
  "brain_search",
]);
const QUERY_PROPS = new Set([
  "query",
  "q",
  "pattern",
  "prompt",
  "question",
  "topic",
  "focus_query",
]);
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

/**
 * Verbs that read none of the per-lane arguments, from the tools' code, so
 * their per-lane calls would repeat the call without them: `brain_trigger`
 * scan and history (`workspace-tools.ts`: only a transition reads `id`),
 * and `brain_agent_diff` modes other than search (`agent-source/diff.ts`:
 * `mode` labels one `queryAgentSources` read of the same topic and query,
 * so the search mode's per-lane calls stand for every mode). A tool with
 * no verb is keyed by `(no verb)`: `brain_search_by_source` answers the
 * pages an ingest derived from `source_file` (`ingest-source-tools.ts`),
 * and no seeded lane entry is an ingest source, so its per-lane calls
 * repeat the absent-source call.
 */
const NO_ENTRY_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  brain_trigger: new Set(["scan", "history"]),
  brain_agent_diff: new Set(["browse", "diff", "map"]),
  brain_search_by_source: new Set(["(no verb)"]),
};

interface Plan {
  readonly tool: string;
  readonly calls: Array<{ readonly args: Record<string, unknown>; readonly seeded?: Seeded }>;
  readonly skipped: string[];
}

function schemaOf(tool: ToolDefinition): {
  props: Record<string, { type?: string; enum?: unknown[]; items?: unknown }>;
  required: string[];
} {
  const s = (tool.inputSchema ?? {}) as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  return { props: s.properties ?? {}, required: s.required ?? [] };
}

function valueFor(
  prop: string,
  spec: { type?: string },
  seeded: Seeded | undefined,
): unknown | undefined {
  const asType = (v: string): unknown => (spec.type === "array" ? [v] : v);
  if (QUERY_PROPS.has(prop)) return asType(seeded === undefined ? COMMON : seeded.hidden.title);
  if (ID_PROPS.has(prop))
    return asType(seeded === undefined ? "probe-absent-id" : seeded.hidden.id);
  if (PATH_PROPS.has(prop))
    return asType(seeded === undefined ? "Brain/probe-absent.md" : seeded.hidden.rel);
  if (prop === "events") return [];
  return undefined;
}

function planFor(tool: ToolDefinition, seeded: ReadonlyArray<Seeded>): Plan {
  const { props, required } = schemaOf(tool);
  // A required verb key wins (brain_analytics: `view` is required, its
  // `operation` qualifies one view only).
  const actionKey =
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum) && required.includes(k)) ??
    ACTION_KEYS.find((k) => Array.isArray(props[k]?.enum));
  const skipped: string[] = [];
  let verbs: Array<string | undefined> = [undefined];
  if (actionKey !== undefined) {
    const all = props[actionKey]!.enum as string[];
    verbs = tool.kind === "write" ? all.filter((v) => READ_VERBS.has(v)) : all;
    for (const v of all) if (!verbs.includes(v)) skipped.push(`${actionKey}=${v}: write verb`);
  } else if (tool.kind === "write" && !READ_ONLY_CALLS.has(tool.name)) {
    return { tool: tool.name, calls: [], skipped: ["write tool with no read verb"] };
  }
  const idLike = Object.keys(props).filter(
    (p) => QUERY_PROPS.has(p) || ID_PROPS.has(p) || PATH_PROPS.has(p),
  );
  const calls: Plan["calls"] = [];
  for (const verb of verbs) {
    const base: Record<string, unknown> = {};
    if (actionKey !== undefined) base[actionKey] = verb;
    let missing: string | null = null;
    for (const req of required) {
      if (req === actionKey) continue;
      const v = valueFor(req, props[req] ?? {}, undefined);
      if (v === undefined) missing = req;
      else base[req] = v;
    }
    const label = verb === undefined ? "(no verb)" : `${actionKey}=${verb}`;
    if (missing !== null) {
      skipped.push(`${label}: required '${missing}' has no sensible probe value`);
      continue;
    }
    if ("dry_run" in props) base["dry_run"] = true;
    calls.push({ args: base });
    const namesNone =
      NO_ENTRY_ARGS[tool.name]?.has(verb ?? "(no verb)") === true ||
      (verb !== undefined && LIST_VERBS.has(verb));
    if (idLike.length === 0 || namesNone) continue;
    for (const s of seeded) {
      const args = { ...base };
      for (const p of idLike) args[p] = valueFor(p, props[p] ?? {}, s);
      calls.push({ args, seeded: s });
    }
  }
  return { tool: tool.name, calls, skipped };
}

async function answer(
  server: MCPServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((done) => {
    timer = setTimeout(() => done(`{"probe_timeout":true}`), CALL_TIMEOUT_MS);
  });
  try {
    const run = server
      .callTool(tool, args)
      .then((r) => JSON.stringify(r))
      .catch((err: unknown) => JSON.stringify({ error: (err as Error)?.message ?? String(err) }));
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Finding {
  readonly tool: string;
  readonly args: string;
  readonly lane: string;
  readonly field: string;
}

/** Run every plan at one reach; the canaries each answer carries. */
async function runAll(
  server: MCPServer,
  plans: ReadonlyArray<Plan>,
  seeded: ReadonlyArray<Seeded>,
): Promise<{
  findings: Finding[];
  sharedSeen: Set<string>;
  timeouts: string[];
  errors: string[];
  calls: number;
}> {
  const findings: Finding[] = [];
  const sharedSeen = new Set<string>();
  const timeouts: string[] = [];
  const errors: string[] = [];
  // Each distinct call once: a verb with no per-lane argument is planned
  // once per tool, and two plans may build the same call.
  const made = new Set<string>();
  for (const plan of plans) {
    for (const call of plan.calls) {
      const passed = JSON.stringify(call.args);
      const key = `${plan.tool}\u0000${passed}`;
      if (made.has(key)) continue;
      made.add(key);
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const text = await answer(server, plan.tool, call.args);
      if (text.includes("probe_timeout")) timeouts.push(`${plan.tool} ${passed}`);
      if (/internal[ _]error/.test(text)) errors.push(`${plan.tool} ${passed}`);
      for (const s of seeded) {
        if (s.shared.marks.some((t) => text.includes(t.mark))) sharedSeen.add(s.lane);
        for (const c of canaries(s)) {
          // A mark the caller passed in is not disclosed by echoing it.
          if (passed.includes(c.mark)) continue;
          if (text.includes(c.mark)) {
            findings.push({ tool: plan.tool, args: passed, lane: s.lane, field: c.field });
          }
        }
      }
    }
  }
  return { findings, sharedSeen, timeouts, errors, calls: made.size };
}

/** Resources too: every listed resource read at the reach given. */
async function readResources(server: MCPServer): Promise<string[]> {
  const listed = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
  })) as { result?: { resources?: Array<{ uri: string }> } } | null;
  const out: string[] = [];
  for (const r of listed?.result?.resources ?? []) {
    const read = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: r.uri },
    });
    out.push(`${r.uri} ${JSON.stringify(read)}`);
  }
  return out;
}

function server(env: LaneEnv, reach?: TransportReach): MCPServer {
  const config = { vault: env.vault, configPath: env.env.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

function summarize(findings: ReadonlyArray<Finding>): Map<string, Set<string>> {
  const byTool = new Map<string, Set<string>>();
  for (const f of findings) {
    const verb = /"(?:action|operation|op|view|mode)":"([^"]+)"/.exec(f.args)?.[1] ?? "-";
    const key = `${f.tool} ${verb}`;
    if (!byTool.has(key)) byTool.set(key, new Set());
    byTool.get(key)!.add(`${f.lane}:${f.field}`);
  }
  return byTool;
}

describe("registry-wide probe of private-partition lane entries", () => {
  test("no tool hands a caller below local reach a private-partition lane entry", async () => {
    const started = Date.now();
    lane = makeLaneEnv("store", "osb-lane-probe-");
    const vault = lane.vault;
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, PROBE_SOURCE), PROBE_SOURCE_TEXT, "utf8");
    const local = server(lane, TRANSPORT_REACH.local);
    const byWriter = await seedWriters(lane, local);
    // A lane folder a writer seeds (by its top folder) is not seeded again.
    const writerTops = new Set(byWriter.map((s) => s.hidden.rel.split("/")[1]!));
    const folders = laneFolders(vault);
    const textFolders = folders.filter((f) => !writerTops.has(f.folder.split("/")[0]!));
    const seeded = [...byWriter, ...seedText(vault, textFolders, 0)];
    // The partition each seeded entry is held in, read from the store.
    const partitions = seeded.map((s) => ({
      lane: s.lane,
      hidden: laneEntryInPrivate(vault, join(vault, s.hidden.rel)),
      shared: laneEntryInPrivate(vault, join(vault, s.shared.rel)),
    }));
    // Every hidden entry is in private before any call. A shared control
    // may be private too when its lane keeps everything there (the source
    // archives).
    expect(partitions.filter((p) => !p.hidden).map((p) => p.lane)).toEqual([]);
    // The projections a local operator builds are built at local reach.
    await buildProjections(local);

    // Proof per writer lane, once: its own reader shows the hidden entry.
    const unseen: string[] = [];
    for (const s of byWriter) {
      // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
      const text = await answer(local, s.reader!.tool, s.reader!.args);
      if (!s.hidden.marks.some((t) => text.includes(t.mark))) unseen.push(s.lane);
    }

    const tools = buildToolTable();
    const plans = tools.map((t) => planFor(t, seeded));
    const remote = server(lane);
    const below = await runAll(remote, plans, seeded);
    const resourcesRemote = await readResources(remote);
    const resourceFindings: Finding[] = [];
    for (const text of resourcesRemote) {
      for (const s of seeded) {
        for (const c of canaries(s)) {
          if (text.includes(c.mark)) {
            const tool = `resource ${text.split(" ")[0]}`;
            resourceFindings.push({ tool, args: "", lane: s.lane, field: c.field });
          }
        }
      }
    }

    // ----- The report -----
    const lines: string[] = [];
    lines.push(
      `shared controls the store holds in private by its lane rule: ${
        partitions
          .filter((p) => p.shared)
          .map((p) => p.lane)
          .join(", ") || "none"
      }`,
    );
    lines.push(`lanes seeded by their writer (${byWriter.length}):`);
    for (const s of byWriter) lines.push(`  ${s.lane} (${s.hidden.rel.split("/")[1]})`);
    lines.push(`lane folders seeded with writeLaneText (${textFolders.length}):`);
    for (const f of textFolders) lines.push(`  ${f.folder} -> lane ${f.lane} (${f.source})`);
    for (const u of UNSEEDABLE) lines.push(`not seeded: ${u}`);
    const remoteByTool = summarize([...below.findings, ...resourceFindings]);
    for (const plan of plans) {
      const status =
        plan.calls.length === 0
          ? `skipped (${plan.skipped.join("; ")})`
          : `planned ${plan.calls.length}`;
      const leaks = [...remoteByTool.entries()]
        .filter(([k]) => k.split(" ")[0] === plan.tool)
        .map(([k, v]) => `${k.split(" ")[1]}: ${[...v].toSorted().join(",")}`);
      lines.push(
        `TOOL ${plan.tool}: ${status}` +
          (plan.calls.length > 0 && plan.skipped.length > 0
            ? ` | skipped verbs: ${plan.skipped.join("; ")}`
            : "") +
          ` | remote leaks: ${leaks.length === 0 ? "none" : leaks.join(" ; ")}`,
      );
    }
    for (const r of resourceFindings) lines.push(`RESOURCE LEAK ${r.tool} ${r.lane}:${r.field}`);
    lines.push(`tools: ${tools.length}, called: ${plans.filter((p) => p.calls.length > 0).length}`);
    lines.push(`calls made below local reach (distinct): ${below.calls}`);
    lines.push(`resources read remotely: ${resourcesRemote.length}`);
    lines.push(
      `writer lanes whose own reader shows no hidden entry locally: ${unseen.join(", ") || "none"}`,
    );
    lines.push(
      `lanes whose shared control a remote caller sees: ${[...below.sharedSeen].toSorted().join(", ")}`,
    );
    // The recorded gap: seeded lanes no remote call reaches with its shared
    // control, so "no canary" there is no evidence of its own.
    const gap = seeded.map((s) => s.lane).filter((l) => !below.sharedSeen.has(l));
    lines.push(`recorded gap, no remote reader of the shared control: ${gap.join(", ")}`);
    lines.push(`timeouts (remote): ${below.timeouts.join(" | ") || "none"}`);
    lines.push(`internal errors (remote): ${below.errors.join(" | ") || "none"}`);
    lines.push(`probe time: ${Date.now() - started} ms`);
    console.log(lines.join("\n"));

    // Every writer lane's own reader shows its hidden entry at local reach.
    expect(unseen).toEqual([]);
    // Every writer lane's shared control crosses, so a silent remote answer
    // is not the reason no canary does; the other lanes are the recorded gap.
    expect(byWriter.map((s) => s.lane).filter((l) => !below.sharedSeen.has(l))).toEqual([]);
    // A call that timed out or failed answered nothing, which is no proof.
    expect({ timeouts: below.timeouts, errors: below.errors }).toEqual({
      timeouts: [],
      errors: [],
    });
    // No canary of a private-partition entry crosses below local reach.
    expect(
      [...remoteByTool.entries()].map(([k, v]) => `${k}: ${[...v].toSorted().join(",")}`),
    ).toEqual([]);
  }, 900_000);
});
