/**
 * The relink maintenance lane task (note-change truth maintenance,
 * F4/C3): recompute the entity anchors of page-sourced signals with the
 * shipped rules - text anchors through the shared occurrence kernel,
 * link-derived anchors through the page-link resolver - additively only
 * (an existing anchor is never removed), dry-run report by default with
 * an apply flag, at the maintenance lane's local reach, and never
 * calling a model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { LANE_TASK, LANE_TASKS, isLaneTask } from "../../../../src/core/brain/maintenance/lane.ts";
import { buildLaneTasks } from "../../../../src/core/brain/maintenance/lane-tasks.ts";
import { isOperation } from "../../../../src/core/brain/safeguard.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import { runRelinkAnchors } from "../../../../src/core/brain/maintenance/relink-anchors-task.ts";

const NOW = new Date("2026-10-19T04:00:00Z");

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-relink-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-relink-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeEntityNode(
  category: string,
  id: string,
  name: string,
  aliases: ReadonlyArray<string> = [],
  status = "active",
): void {
  const dir = join(brainDirs(vault).entities, category);
  mkdirSync(dir, { recursive: true });
  writeFrontmatterAtomic(
    join(dir, `${id}.md`),
    {
      kind: "brain-entity",
      entity_id: id,
      category,
      name,
      ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
      status,
      created_at: "2026-10-19T00:00:00Z",
      updated_at: "2026-10-19T00:00:00Z",
      tags: ["brain", "brain/entity"],
    },
    `# ${name}`,
    { overwrite: true },
  );
}

function writeSourcePage(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function writePageSourcedSignal(input: {
  readonly sourceRef: string;
  readonly principle: string;
  readonly storedEntityIds: ReadonlyArray<string>;
  readonly topic?: string;
}): void {
  writeSignal(vault, {
    topic: input.topic ?? "fact-quantity",
    signal: "positive",
    agent: "tester",
    principle: input.principle,
    created_at: "2026-10-19T01:00:00Z",
    date: "2026-10-19",
    slug: input.topic ?? "fact-quantity",
    source: [`[[${input.sourceRef}]]`],
    source_type: "inline",
    dedup_hash: `hash-${input.principle.length}-${input.sourceRef.replace(/\W/g, "")}`,
    ...(input.storedEntityIds.length > 0
      ? { raw: `entities: ${input.storedEntityIds.join(", ")}` }
      : { raw: "_(not provided)_" }),
  });
}

function inboxFiles(): ReadonlyArray<string> {
  const dir = brainDirs(vault).inbox;
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith("sig-") && f.endsWith(".md"))
        .toSorted()
    : [];
}

function entitiesLineOf(file: string): string | undefined {
  const body = readFileSync(join(brainDirs(vault).inbox, file), "utf8");
  return body.split(/\r?\n/).find((line) => line.startsWith("entities: "));
}

describe("runRelinkAnchors", () => {
  test("dry run by default: reports the addable anchors and writes nothing", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Atlas Prime shipped five units to the depot",
      storedEntityIds: ["ent-project-atlas"],
    });
    const before = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));

    const report = runRelinkAnchors(vault, { now: NOW });

    expect(report.apply).toBe(false);
    expect(report.signalsScanned).toBe(1);
    expect(report.signalsPageSourced).toBe(1);
    expect(report.signalsChanged).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(report.perSource).toEqual([{ source: "notes/meeting.md", signals: 1, anchorsAdded: 1 }]);
    const after = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));
    expect(after).toEqual(before);
  });

  test("apply unions text-derived and link-derived anchors additively, and is idempotent", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Atlas Prime shipped five units to the depot",
      storedEntityIds: ["ent-project-atlas"],
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.apply).toBe(true);
    expect(report.signalsChanged).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-project-atlas, ent-people-ada-lovelace");

    const second = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(second.anchorsAdded).toBe(0);
    expect(second.signalsChanged).toBe(0);
    expect(entitiesLineOf(file)).toBe("entities: ent-project-atlas, ent-people-ada-lovelace");
  });

  test("an existing anchor is never removed, even when the recompute no longer matches it", () => {
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeEntityNode("orgs", "ent-orgs-retired", "Retired Co", [], "archived");
    writeSourcePage("notes/meeting.md", "# Meeting\n\nNothing linked here.\n");
    writePageSourcedSignal({
      // The principle names nothing the recompute can anchor - the archived
      // node is out of canonical scope and the source page links nothing -
      // so the recompute produces no anchor at all.
      sourceRef: "notes/meeting.md",
      principle: "the depot confirmed receipt the same day",
      storedEntityIds: ["ent-orgs-retired"],
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.anchorsAdded).toBe(0);
    expect(report.signalsChanged).toBe(0);
    expect(entitiesLineOf(file)).toBe("entities: ent-orgs-retired");
  });

  test("a signal whose source names no vault page is out of scope and untouched", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writePageSourcedSignal({
      sourceRef: "session:abc123#turn-4",
      principle: "Ada Lovelace designed the engine",
      storedEntityIds: [],
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsScanned).toBe(1);
    expect(report.signalsPageSourced).toBe(0);
    expect(report.signalsChanged).toBe(0);
    const body = readFileSync(join(brainDirs(vault).inbox, file), "utf8");
    expect(body).not.toContain("ent-people-ada-lovelace");
  });

  test("a page-sourced signal gains anchors from a source page it links without naming", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/notes.md",
      "# Notes\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/notes",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-people-ada-lovelace");
  });

  test("per-source counts aggregate the signals that share one source page", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeSourcePage(
      "notes/meeting.md",
      ["# Meeting", "", "- [[ent-people-ada-lovelace]]", "- [[ent-project-atlas]]"].join("\n"),
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Atlas Prime shipped five units to the depot",
      storedEntityIds: ["ent-project-atlas"],
    });
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the depot confirmed receipt the same day",
      storedEntityIds: [],
      topic: "fact-url",
    });

    const report = runRelinkAnchors(vault, { now: NOW });

    // The first signal already stores Atlas and gains Ada from the page;
    // the second names nothing and gains both links. Three anchors across
    // the two signals, aggregated under their one shared source.
    expect(report.perSource).toEqual([{ source: "notes/meeting.md", signals: 2, anchorsAdded: 3 }]);
    expect(report.anchorsAdded).toBe(3);
  });

  test("an unreadable signal file is counted, never fatal", () => {
    writeSourcePage("notes/meeting.md", "# Meeting\n");
    const dir = brainDirs(vault).inbox;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sig-2026-10-19-broken.md"), "totally not a signal page", "utf8");

    const report = runRelinkAnchors(vault, { now: NOW });

    expect(report.signalsScanned).toBe(1);
    expect(report.signalsUnreadable).toBe(1);
    expect(report.signalsPageSourced).toBe(0);
  });
});

describe("the relink lane task registration", () => {
  test("relink is the fifth lane task, and an operation with a budget", () => {
    expect(LANE_TASKS).toHaveLength(5);
    expect(LANE_TASKS).toContain(LANE_TASK.relink);
    expect(isLaneTask("relink")).toBe(true);
    expect(isOperation(LANE_TASK.relink)).toBe(true);
  });

  test("buildLaneTasks registers the relink task beside the four built-ins, dry-run by default", async () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    const before = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));
    const set = buildLaneTasks({
      vault,
      configPath,
      searchConfig: resolveSearchConfig({ vault, configPath }),
      now: NOW,
      forceCost: false,
      safeguardFor: (operation) => ({
        checkpoint: () => {},
        timeoutMs: null,
        operation,
      }),
    });
    expect(set.taskNames).toEqual([...LANE_TASKS]);
    const relink = set.tasks.find((task) => task.name === LANE_TASK.relink);
    expect(relink).toBeDefined();
    // A lane pass never returns a spend receipt: it spends no model budget.
    expect(await relink!.run()).toBeUndefined();
    const after = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));
    expect(after).toEqual(before);
  });
});
