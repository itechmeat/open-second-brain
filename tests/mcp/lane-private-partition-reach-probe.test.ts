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
 *
 * Then the shared-only list-count comparison
 * (`lane-private-partition-reach-probe-counts.ts`): a twin store seeded
 * with only the shared entries replays every call, and each list or count
 * call it answers at local reach must give the counts the remote answer
 * on the store with private entries gave.
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
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { countMismatches } from "./lane-private-partition-reach-probe-counts.ts";
import {
  COMMON,
  planFor,
  type Plan,
  type Seeded,
} from "./lane-private-partition-reach-probe-read-plan.ts";
import {
  buildProjections,
  PROBE_SOURCE,
  PROBE_SOURCE_TEXT,
  WRITERS,
  type SeededEntry,
} from "./lane-private-partition-reach-probe-writers.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const SRC = join(REPO, "src");
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

/**
 * Seed every writer lane through its writer, the hidden entry first; with
 * `sharedOnly` (the twin of the count comparison) the shared entry alone.
 */
async function seedWriters(env: LaneEnv, local: MCPServer, sharedOnly = false): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (const row of WRITERS) {
    // oxlint-disable-next-line no-await-in-loop -- the writers share one store, written in order
    const hidden = sharedOnly ? undefined : await row.seed(env, local, true);
    // oxlint-disable-next-line no-await-in-loop -- the writers share one store, written in order
    const shared = await row.seed(env, local, false);
    out.push({
      lane: row.lane,
      by: "writer",
      hidden: hidden ?? shared,
      shared,
      reader: row.reader,
    });
  }
  return out;
}

/**
 * Seed every other lane folder with `writeLaneText` in a page format;
 * with `sharedOnly` the shared entry alone.
 */
function seedText(
  vault: string,
  folders: ReadonlyArray<LaneFolder>,
  offset: number,
  sharedOnly = false,
): Seeded[] {
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
    const shared = mk("shr");
    const hidden = sharedOnly ? shared : mk("hid");
    return { lane: folder.folder, by: "writeLaneText", hidden, shared };
  });
}

/** The canary marks of a hidden entry. */
function canaries(s: Seeded): SeededEntry["marks"] {
  return s.hidden.marks;
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

/**
 * Run every plan at one reach; the canaries each answer carries, and each
 * answer by call key. With `local` (the shared-only twin) each list or
 * count call is answered at local reach too, after the call below it.
 */
async function runAll(
  server: MCPServer,
  plans: ReadonlyArray<Plan>,
  seeded: ReadonlyArray<Seeded>,
  local?: MCPServer,
): Promise<{
  findings: Finding[];
  sharedSeen: Set<string>;
  timeouts: string[];
  errors: string[];
  calls: number;
  answers: Map<string, string>;
  localAnswers: Map<string, string>;
}> {
  const findings: Finding[] = [];
  const sharedSeen = new Set<string>();
  const timeouts: string[] = [];
  const errors: string[] = [];
  const answers = new Map<string, string>();
  const localAnswers = new Map<string, string>();
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
      answers.set(key, text);
      if (local !== undefined && call.listing) {
        // oxlint-disable-next-line no-await-in-loop -- one server, its calls in order
        localAnswers.set(key, await answer(local, plan.tool, call.args));
      }
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
  return { findings, sharedSeen, timeouts, errors, calls: made.size, answers, localAnswers };
}

/**
 * Resources too: the listing itself (each resource's metadata) and every
 * listed resource read at the reach given. A listing that fails is no
 * proof that nothing leaks, so it throws.
 */
async function readResources(server: MCPServer): Promise<string[]> {
  const listed = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
  })) as { result?: { resources?: Array<{ uri: string }> }; error?: unknown } | null;
  if (listed === null || listed.error !== undefined || !Array.isArray(listed.result?.resources)) {
    throw new Error(`resource listing failed: ${JSON.stringify(listed)}`);
  }
  const out: string[] = [`resources/list ${JSON.stringify(listed.result)}`];
  for (const r of listed.result.resources) {
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
  // The calls are what the probe proves: every writer seeds its lane and
  // every read verb of every tool is called in order, on this store and its
  // shared-only twin, so the run takes tens of seconds and the test passes
  // its own limit as the last argument instead of the default 5 s.
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

    // ----- The shared-only twin of the count comparison -----
    // The store with private entries goes first (one live store per test).
    lane.cleanup();
    lane = makeLaneEnv("store", "osb-lane-probe-twin-");
    const twinVault = lane.vault;
    mkdirSync(join(twinVault, "Notes"), { recursive: true });
    writeFileSync(join(twinVault, PROBE_SOURCE), PROBE_SOURCE_TEXT, "utf8");
    const twinLocal = server(lane, TRANSPORT_REACH.local);
    const twinWriters = await seedWriters(lane, twinLocal, true);
    seedText(twinVault, textFolders, 0, true);
    expect(twinWriters.length).toBe(byWriter.length);
    await buildProjections(twinLocal);
    const twin = await runAll(server(lane), plans, [], twinLocal);
    const countProblems: string[] = [];
    let counted = 0;
    for (const plan of plans) {
      for (const call of plan.calls) {
        if (!call.listing) continue;
        const key = `${plan.tool}\u0000${JSON.stringify(call.args)}`;
        const remoteText = below.answers.get(key);
        const localText = twin.localAnswers.get(key);
        if (remoteText === undefined || localText === undefined) continue;
        counted++;
        countProblems.push(
          ...countMismatches(call.call, remoteText, localText, twin.answers.get(key)),
        );
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
    lines.push(
      `resource answers scanned remotely (the listing included): ${resourcesRemote.length}`,
    );
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
    lines.push(`list or count calls compared with the shared-only twin: ${counted}`);
    lines.push(`count mismatches (${countProblems.length}):`);
    for (const p of countProblems) lines.push(`  ${p}`);
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
    // Every list or count call answers the shared-only twin's counts.
    expect(counted).toBeGreaterThan(0);
    expect(countProblems).toEqual([]);
  }, 900_000);
});
