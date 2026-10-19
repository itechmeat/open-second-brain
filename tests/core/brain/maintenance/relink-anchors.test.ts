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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import type { ProgressEvent } from "../../../../src/core/brain/progress.ts";
import { writeSignal, parseSignal } from "../../../../src/core/brain/signal.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { LANE_TASK, LANE_TASKS, isLaneTask } from "../../../../src/core/brain/maintenance/lane.ts";
import { buildLaneTasks } from "../../../../src/core/brain/maintenance/lane-tasks.ts";
import { isOperation } from "../../../../src/core/brain/safeguard.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import {
  decideRawRewrite,
  runRelinkAnchors,
} from "../../../../src/core/brain/maintenance/relink-anchors-task.ts";

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
  visibility?: "private",
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
      ...(visibility !== undefined ? { visibility } : {}),
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

/** A source page reserved against remote reads (`visibility: private`). */
function writePrivateSourcePage(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFrontmatterAtomic(abs, { visibility: "private" }, body, { overwrite: true });
}

/** Restamp a stored signal page `visibility: private` (local-only readers). */
function markSignalPrivate(file: string): void {
  const path = join(brainDirs(vault).inbox, file);
  const [meta, body] = parseFrontmatter(path);
  writeFrontmatterAtomic(path, { ...meta, visibility: "private" }, body, { overwrite: true });
}

function writePageSourcedSignal(input: {
  readonly sourceRef?: string;
  readonly sourceRefs?: ReadonlyArray<string>;
  readonly principle: string;
  readonly storedEntityIds: ReadonlyArray<string>;
  readonly topic?: string;
  /**
   * The signal's source_type stamp. Defaults to `extracted` - the pass's
   * in-scope stamp; `"live"` omits the field entirely, which is how a
   * `brain_feedback` signal is stored (live is the implicit default).
   */
  readonly sourceType?: "extracted" | "inline" | "live";
  /** Write the page with no `## Raw` section at all (v0.10.1 shape). */
  readonly noRawSection?: boolean;
  /** Store the raw body codec-compressed (the `_raw_codec` marker). */
  readonly rawCodec?: boolean;
  /** Verbatim raw body overriding the stored-ids / placeholder default. */
  readonly rawBody?: string;
}): void {
  const sourceRefs = input.sourceRefs ?? [input.sourceRef ?? ""];
  const sourceType = input.sourceType ?? "extracted";
  writeSignal(vault, {
    topic: input.topic ?? "fact-quantity",
    signal: "positive",
    agent: "tester",
    principle: input.principle,
    created_at: "2026-10-19T01:00:00Z",
    date: "2026-10-19",
    slug: input.topic ?? "fact-quantity",
    source: sourceRefs.map((ref) => `[[${ref}]]`),
    ...(sourceType === "live" ? {} : { source_type: sourceType }),
    dedup_hash: `hash-${input.principle.length}-${sourceRefs.join(".").replace(/\W/g, "")}`,
    ...(input.noRawSection
      ? {}
      : input.rawBody !== undefined
        ? { raw: input.rawBody }
        : input.storedEntityIds.length > 0
          ? { raw: `entities: ${input.storedEntityIds.join(", ")}` }
          : { raw: "_(not provided)_" }),
    ...(input.rawCodec ? { rawCodec: true } : {}),
  });
}

/**
 * Every byte under `Brain/log/`, as one deterministic string: the
 * dry-run-writes-nothing pins compare whole snapshots, not single files,
 * so a skip event landing in any shard fails the comparison.
 */
function logSnapshot(): string {
  const root = brainDirs(vault).log;
  if (!existsSync(root)) return "<absent>";
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(`${path}\n${readFileSync(path, "utf8")}`);
    }
  };
  walk(root);
  return out.join("\n");
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

  test("a signal without a Raw section reports no addition it could not make", () => {
    // No `## Raw` section means the anchor has no home on the page: the
    // rewrite refuses it, so reporting the addition - in either arm -
    // would be a count for a write that never happens.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      noRawSection: true,
    });
    const file = inboxFiles()[0]!;
    const before = readFileSync(join(brainDirs(vault).inbox, file), "utf8");

    const dry = runRelinkAnchors(vault, { now: NOW });
    expect(dry.signalsPageSourced).toBe(1);
    expect(dry.signalsChanged).toBe(0);
    expect(dry.anchorsAdded).toBe(0);

    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(applied.signalsChanged).toBe(0);
    expect(applied.anchorsAdded).toBe(0);
    expect(readFileSync(join(brainDirs(vault).inbox, file), "utf8")).toBe(before);
  });

  test("a codec-compressed signal is out of the rewrite's reach and counted by neither arm", () => {
    // The compressed section collapses whitespace runs, so a blank-line
    // run merges the `entities:` line into the line above it: a
    // byte-level rewrite would find no line to replace, append a second
    // one, and the next parse - which reads the FIRST entities line of
    // the EXPANDED section - would never see it. The signal is out of
    // the pass's reach, like a page without a Raw section - and the
    // raw-shape gate does not claim it: the codec gate runs first, so
    // the skip is the byte form's, counted by neither arm.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      // Four newlines collapse into one run marker, merging the entities
      // line into the preceding line on disk; Atlas is stored, Ada is the
      // addition the pass must NOT claim it can make.
      rawBody: "progress notes\n\n\n\nentities: ent-project-atlas",
      rawCodec: true,
    });
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);
    const before = readFileSync(file, "utf8");
    expect(before).toContain("_raw_codec");

    const dry = runRelinkAnchors(vault, { now: NOW });
    expect(dry.signalsPageSourced).toBe(1);
    expect(dry.signalsSkippedRawShape).toBe(0);
    expect(dry.signalsChanged).toBe(0);
    expect(dry.anchorsAdded).toBe(0);

    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(applied.signalsChanged).toBe(0);
    expect(applied.anchorsAdded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    // The stored record still parses, expanded, with the marker read back.
    const parsed = parseSignal(file);
    expect(parsed.rawCodec).toBe(true);
    expect(parsed.raw).toBe("progress notes\n\n\n\nentities: ent-project-atlas");
  });

  test("an extractor-shaped raw stored codec-compressed is still held out by the codec flag", () => {
    // The shape gate subsumes the old codec skip only for PROSE sections;
    // it must not wave through the one signal whose expanded raw IS the
    // extractor's line: on disk the section is the compressed form, and
    // a byte-level rewrite there would append a line the next parse
    // never reads. The flag keeps that signal out, counted by neither
    // arm, exactly as before.
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
      rawBody: "entities: ent-project-atlas",
      rawCodec: true,
    });
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);
    const before = readFileSync(file, "utf8");

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.signalsSkippedRawShape).toBe(0);
    expect(report.signalsChanged).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("two consecutive dry runs report identical numbers", () => {
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
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the depot confirmed receipt the same day",
      storedEntityIds: [],
      topic: "fact-url",
    });
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "no raw section on this one",
      storedEntityIds: [],
      topic: "fact-topic",
      noRawSection: true,
    });

    const first = runRelinkAnchors(vault, { now: NOW });
    const second = runRelinkAnchors(vault, { now: NOW });
    expect(second).toEqual(first);
  });

  test("a dry run and an apply run over the same vault report the same numbers", () => {
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

    const dry = runRelinkAnchors(vault, { now: NOW });
    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(applied.signalsScanned).toBe(dry.signalsScanned);
    expect(applied.signalsPageSourced).toBe(dry.signalsPageSourced);
    expect(applied.signalsChanged).toBe(dry.signalsChanged);
    expect(applied.anchorsAdded).toBe(dry.anchorsAdded);
    expect(applied.perSource).toEqual(dry.perSource);
  });

  test("a placeholder Raw section still gains the text-derived anchors", () => {
    // The "(not provided)" placeholder is the section the rewrite can
    // fill; a signal whose stored raw reads as absent must not lose the
    // text match - only the WRITE waits on the rewrite's support.
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    writeSourcePage("notes/meeting.md", "# Meeting\n\nNo entity links here.\n");
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Atlas Prime shipped five units to the depot",
      storedEntityIds: [],
    });
    const file = inboxFiles()[0]!;

    const dry = runRelinkAnchors(vault, { now: NOW });
    expect(dry.anchorsAdded).toBe(1);

    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(applied.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-project-atlas");
  });

  test("two pointers to one page count that page once", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRefs: ["notes/meeting.md", "notes/meeting"],
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });

    const report = runRelinkAnchors(vault, { now: NOW });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.perSource).toEqual([{ source: "notes/meeting.md", signals: 1, anchorsAdded: 1 }]);
  });

  test("a directory shadowing the page name does not swallow the page", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    // A DIRECTORY at the exact ref path: an existence probe answers true
    // for it, and reading it fails - which must cost the pass its .md
    // sibling, never the page itself.
    mkdirSync(join(vault, "notes", "meeting"), { recursive: true });
    writeFileSync(join(vault, "notes", "meeting", "inner.txt"), "x", "utf8");
    writePageSourcedSignal({
      sourceRef: "notes/meeting",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });

    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(applied.signalsPageSourced).toBe(1);
    expect(applied.anchorsAdded).toBe(1);
  });

  test("a dry run leaves the Brain log byte-identical; the apply arm stamps the skip audit", () => {
    // The shared anchorable build logs an entity-anchor-skip for a
    // canonical entity whose NAME fails the quality gate. That log event
    // is a write: the preview must compute the same anchors without
    // stamping it, and the apply arm - the write path - stamps it exactly
    // as the capture path does.
    writeEntityNode("orgs", "ent-orgs-junk", "***", ["junk"]);
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

    const before = logSnapshot();
    const dry = runRelinkAnchors(vault, { now: NOW });
    expect(logSnapshot()).toBe(before);
    expect(dry.anchorsAdded).toBe(1);

    const applied = runRelinkAnchors(vault, { now: NOW, apply: true });
    expect(applied.anchorsAdded).toBe(dry.anchorsAdded);
    // The write path stamps the audit the preview withheld.
    expect(logSnapshot()).not.toBe(before);
    expect(logSnapshot()).toContain("entity-anchor-skip");
  });

  test("the signal walk is one stage over both trees, started once", () => {
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
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Atlas Prime shipped five units to the depot",
      storedEntityIds: [],
      topic: "fact-url",
    });
    // One signal archived into the processed tree, so the walk has work
    // in both directories it scans.
    const processedDir = brainDirs(vault).processed;
    mkdirSync(processedDir, { recursive: true });
    const moved = inboxFiles()[0]!;
    renameSync(join(brainDirs(vault).inbox, moved), join(processedDir, moved));

    const events: ProgressEvent[] = [];
    runRelinkAnchors(vault, { now: NOW, onProgress: (event) => events.push(event) });

    const starts = events.filter((event) => event.kind === "started");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.stage).toBe("signals");
    expect(starts[0]!.total).toBe(2);
    expect(events.filter((event) => event.kind === "advanced")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "finished")).toHaveLength(1);
  });

  test("a vault path with a trailing separator still resolves and counts its pages", () => {
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

    const report = runRelinkAnchors(`${vault}/`, { now: NOW });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(report.perSource).toEqual([{ source: "notes/meeting.md", signals: 1, anchorsAdded: 1 }]);
  });

  test("an unreadable signal file is counted, never fatal", () => {
    const dir = brainDirs(vault).inbox;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sig-2026-10-19-broken.md"), "totally not a signal page", "utf8");

    const report = runRelinkAnchors(vault, { now: NOW });

    expect(report.signalsScanned).toBe(1);
    expect(report.signalsUnreadable).toBe(1);
    expect(report.signalsPageSourced).toBe(0);
  });
});

describe("the resolution binds at the reach the signal itself is readable at", () => {
  test("a remotely readable signal never gains a private entity page's id", () => {
    // The signal page carries no visibility reservation, so every
    // remote-reach reader can list it. Its resolution therefore binds at
    // remote reach: the public link attaches, and the private page's id
    // adds nothing - writing it would disclose the record to every
    // reader that can list the signal, and the pass never removes an
    // anchor, so the leak would be permanent.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("people", "ent-people-secret-person", "Secret Person", [], "active", "private");
    writeSourcePage(
      "notes/meeting.md",
      ["# Meeting", "", "- [[ent-people-ada-lovelace]]", "- [[ent-people-secret-person]]"].join(
        "\n",
      ),
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-people-ada-lovelace");
    const body = readFileSync(join(brainDirs(vault).inbox, file), "utf8");
    expect(body).not.toContain("ent-people-secret-person");
  });

  test("the same fixture with a local-only signal still gains the private anchor", () => {
    // A signal page reserved against remote reads stays a local-reach
    // fact: the lane is a local repair pass, and it heals what only a
    // local reader sees. Nothing about the signal leaves the host, so
    // the private id costs no disclosure here.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("people", "ent-people-secret-person", "Secret Person", [], "active", "private");
    writeSourcePage(
      "notes/meeting.md",
      ["# Meeting", "", "- [[ent-people-ada-lovelace]]", "- [[ent-people-secret-person]]"].join(
        "\n",
      ),
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    markSignalPrivate(inboxFiles()[0]!);
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(2);
    expect(entitiesLineOf(file)).toBe(
      "entities: ent-people-ada-lovelace, ent-people-secret-person",
    );
  });

  test("a remotely readable signal anchors nothing from a principle naming a private entity", () => {
    // The TEXT half binds at the same per-signal reach as the link half.
    // The anchorable list is built at the lane's reach, so a principle
    // naming a PRIVATE entity matched that entity and pushed its id into
    // a signal every remote-reach reader can list - the same leak the
    // link half's reach fix closed, entering through the text arm. The
    // private name anchors nothing; a public name on the same signal
    // class still anchors; a local-only signal keeps healing the
    // private name.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("people", "ent-people-secret-person", "Secret Person", [], "active", "private");
    writeSourcePage("notes/meeting.md", "# Meeting\n\nNo entity links here.\n");
    // Remotely readable, names the private entity only: nothing anchors.
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Secret Person joined the review",
      storedEntityIds: [],
    });
    // Remotely readable, names the public entity: still anchors.
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Ada Lovelace joined the review",
      storedEntityIds: [],
      topic: "fact-public",
    });
    // Local-only, names the private entity: the lane still heals it.
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Secret Person joined the review",
      storedEntityIds: [],
      topic: "fact-private",
    });
    markSignalPrivate(inboxFiles()[0]!);
    // Sorted by name: `fact-private` (local-only, heals the private
    // name), `fact-public` (remote, anchors the public name),
    // `fact-quantity` (remote, names the private entity).
    const [healedFile, publicFile, remoteSecretFile] = inboxFiles();

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(3);
    expect(report.anchorsAdded).toBe(2);
    expect(report.signalsChanged).toBe(2);
    expect(entitiesLineOf(healedFile!)).toBe("entities: ent-people-secret-person");
    expect(entitiesLineOf(publicFile!)).toBe("entities: ent-people-ada-lovelace");
    expect(entitiesLineOf(remoteSecretFile!)).toBeUndefined();
    const body = readFileSync(join(brainDirs(vault).inbox, remoteSecretFile!), "utf8");
    expect(body).not.toContain("ent-people-secret-person");
  });

  test("a remotely readable signal whose source page is private is out of scope", () => {
    // The source filter binds at the same per-signal reach as the
    // resolver: a signal any remote reader can list gains nothing from a
    // page that reader cannot open - reading the page's links at the
    // lane's reach while writing the ids into a remotely readable page
    // would launder the page's contents past its own reservation.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writePrivateSourcePage("notes/secret.md", "# Secret\n\n- [[ent-people-ada-lovelace]]\n");
    writePageSourcedSignal({
      sourceRef: "notes/secret.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    const file = inboxFiles()[0]!;
    const before = readFileSync(join(brainDirs(vault).inbox, file), "utf8");

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    expect(readFileSync(join(brainDirs(vault).inbox, file), "utf8")).toBe(before);
  });

  test("a local-only signal still reads its private source page at the lane's reach", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writePrivateSourcePage("notes/secret.md", "# Secret\n\n- [[ent-people-ada-lovelace]]\n");
    writePageSourcedSignal({
      sourceRef: "notes/secret.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
    });
    markSignalPrivate(inboxFiles()[0]!);
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-people-ada-lovelace");
  });
});

describe("the pass reads only server-stamped sources", () => {
  test("a feedback-sourced or inline-sourced signal pointing at a page gains nothing", () => {
    // A `brain_feedback` caller supplied its own `source:` pointer (and a
    // `live` signal carries no source_type at all - absence IS the live
    // stamp); an inline marker is author-written the same way. A
    // caller-chosen page must not choose which entity ids attach:
    // server-derived facts outrank caller-supplied claims, so both are
    // out of the pass's scope entirely - the pointer is never even read.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      sourceType: "live",
    });
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "Ada Lovelace joined the review",
      storedEntityIds: [],
      topic: "fact-inline",
      sourceType: "inline",
    });
    const before = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsScanned).toBe(2);
    expect(report.signalsPageSourced).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    const after = inboxFiles().map((f) => readFileSync(join(brainDirs(vault).inbox, f), "utf8"));
    expect(after).toEqual(before);
  });

  test("an extracted-sourced signal pointing at the same page still does", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      sourceType: "extracted",
    });
    const file = inboxFiles()[0]!;

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.anchorsAdded).toBe(1);
    expect(entitiesLineOf(file)).toBe("entities: ent-people-ada-lovelace");
  });
});

describe("the rewrite touches only the extractor's own raw shape", () => {
  test("a quote line starting with entities: is never overwritten", () => {
    // An extracted stamp on a hand-joined page: the Raw section is a
    // verbatim quote whose first line happens to start with `entities:`.
    // The old line-level rewrite read that line as the anchor line,
    // counted its free text as stored anchors, and overwrote the quote's
    // own words. The shape check refuses: the raw is not the extractor's
    // single `entities:` line, so the signal is skipped and counted.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      rawBody: "entities: ent-project-atlas\nAda Lovelace joined the review.",
    });
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);
    const before = readFileSync(file, "utf8");

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsPageSourced).toBe(1);
    expect(report.signalsSkippedRawShape).toBe(1);
    expect(report.signalsChanged).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a quote with a heading never gets a mid-quote splice", () => {
    // The raw-section rewrite used to stop at the first `## ` line while
    // the parser read to EOF, so an entities line spliced into a quote
    // containing a heading landed mid-quote. The shape check refuses the
    // page before any line is touched.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      rawBody: "Ada said:\n\n## Verbatim\n\nthe review concluded with five follow-ups.",
    });
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);
    const before = readFileSync(file, "utf8");

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsSkippedRawShape).toBe(1);
    expect(report.signalsChanged).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("an extracted signal with malformed raw is skipped with a count", () => {
    // One line, but not the extractor's: nothing about it is an anchor
    // line, and splicing one in after it would edit a record the pass
    // has no business editing. Skipped, counted, never written.
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeSourcePage(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    writePageSourcedSignal({
      sourceRef: "notes/meeting.md",
      principle: "the review concluded with five follow-ups",
      storedEntityIds: [],
      rawBody: "just a note line",
    });
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);
    const before = readFileSync(file, "utf8");

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsSkippedRawShape).toBe(1);
    expect(report.signalsChanged).toBe(0);
    expect(report.anchorsAdded).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("the shape check is exact: the extractor's own line is still rewritten", () => {
    // The positive twin: the exact shape `routeExtractedFacts` writes -
    // one `entities: <ids>` line, nothing else - is the one shape the
    // rewrite still serves, so the pass keeps healing narrow extractor
    // anchor lists.
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
    const file = join(brainDirs(vault).inbox, inboxFiles()[0]!);

    const report = runRelinkAnchors(vault, { now: NOW, apply: true });

    expect(report.signalsSkippedRawShape).toBe(0);
    expect(report.signalsChanged).toBe(1);
    expect(entitiesLineOf(inboxFiles()[0]!)).toBe(
      "entities: ent-project-atlas, ent-people-ada-lovelace",
    );
  });
});

describe("the apply arm re-gates the bytes it actually rewrites", () => {
  // The parse's bytes can go stale before the write: a page edited
  // between the pass's parseSignal and the apply read would otherwise
  // have the rewrite run on bytes no gate checked - the quote overwrite
  // the shape gate exists to prevent, back through the second read.
  // `decideRawRewrite` is the drift re-check: the SAME hold-out, judged
  // on the rewrite's own bytes, with the stored half rebuilt from them.

  test("a Raw turned quote between parse and read is refused, not overwritten", () => {
    // The parse saw the extractor's one-line raw; by the time the apply
    // arm reads the page, the section is a verbatim quote whose own line
    // starts with `entities:` - the exact bytes the old flow happily
    // rewrote. The byte gate answers unsafe-shape.
    const before = [
      "---",
      "kind: brain-signal",
      "---",
      "## Raw",
      "entities: ent-project-atlas",
      "Ada Lovelace joined the review.",
      "",
    ].join("\n");
    expect(decideRawRewrite(before, ["ent-people-ada-lovelace"])).toEqual({
      action: "unsafe-shape",
    });
  });

  test("a heading after the entities line between parse and read is refused, not spliced into", () => {
    // The parse saw the extractor's one-line raw; the apply read finds a
    // heading after the `entities:` line. The parser reads `## Raw` to
    // EOF, so the parse-time shape gate would reject these bytes as a
    // multi-line section - the byte gate must too, though only the span
    // up to the heading still looks like the extractor's one line.
    const before = [
      "---",
      "kind: brain-signal",
      "---",
      "## Raw",
      "entities: ent-project-atlas",
      "## Notes",
      "Ada Lovelace joined the review.",
      "",
    ].join("\n");
    expect(decideRawRewrite(before, ["ent-people-ada-lovelace"])).toEqual({
      action: "unsafe-shape",
    });
  });

  test("a Raw turned codec between parse and read is refused, even when the compressed form spells the extractor's line", () => {
    // Same window, opposite edit: the frontmatter now carries the
    // `_raw_codec` marker beside a real section, so the bytes on disk
    // are the reversible compressed form. The collapse that hid the
    // section's real content can leave ONE line that starts with
    // `entities: ` and parses to an id - the shape gate alone would
    // accept it and rewrite the compressed bytes - so the marker itself
    // is what refuses here, with the parse-time codec gate's own
    // uncounted answer.
    const before = [
      "---",
      "kind: brain-signal",
      "_raw_codec: 1",
      "---",
      "## Raw",
      "entities: ent-project-atlas",
      "",
    ].join("\n");
    expect(decideRawRewrite(before, ["ent-people-ada-lovelace"])).toEqual({
      action: "codec",
    });
  });

  test("a codec marker over an absent or placeholder section is not a codec page", () => {
    // The parse gate fires for a marker AND a real section only
    // (`rawCodec` is storedCodec: marker + rawSection), so the mirror
    // falls through for these and the old flow's answers stand: a
    // placeholder is still fillable, a missing section still has no
    // home - neither is counted as anything.
    const placeholder = "---\nkind: brain-signal\n_raw_codec: 1\n---\n## Raw\n_(not provided)_\n";
    expect(decideRawRewrite(placeholder, ["ent-c"])).toEqual({
      action: "rewrite",
      next: "---\nkind: brain-signal\n_raw_codec: 1\n---\n## Raw\nentities: ent-c\n",
      appended: ["ent-c"],
    });
    expect(
      decideRawRewrite("---\nkind: brain-signal\n_raw_codec: 1\n---\n\nbody\n", ["ent-c"]),
    ).toEqual({ action: "no-home" });
  });

  test("an edit that widened the stored list keeps its ids", () => {
    // The parse read `entities: a`; the apply read sees `entities: a, b`
    // - a concurrent edit stored `b`. The rebuilt line keeps it: the
    // pass is additive, and a line built from the parse's stale `stored`
    // would have dropped it. `appended` names what the rewrite adds.
    const before = "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a, ent-b\n";
    expect(decideRawRewrite(before, ["ent-c"])).toEqual({
      action: "rewrite",
      next: "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a, ent-b, ent-c\n",
      appended: ["ent-c"],
    });
  });

  test("an edit that already stored every computed id makes the rewrite a no-op", () => {
    // The parse computed `ent-b` as an addition; a concurrent edit stored
    // it before the apply read. The truthful answer is nothing to add -
    // no rewrite, nothing counted - where the old flow would have
    // counted a write of byte-identical contents.
    const before = "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a, ent-b\n";
    expect(decideRawRewrite(before, ["ent-b"])).toEqual({ action: "no-home" });
  });

  test("an edit that withdrew the stored list is not resurrected", () => {
    // The parse read `entities: a`; the apply read sees the placeholder
    // - the anchor list was withdrawn after the parse. The rebuilt line
    // carries only the pass's own additions.
    const before = "---\nkind: brain-signal\n---\n## Raw\n_(not provided)_\n";
    expect(decideRawRewrite(before, ["ent-c"])).toEqual({
      action: "rewrite",
      next: "---\nkind: brain-signal\n---\n## Raw\nentities: ent-c\n",
      appended: ["ent-c"],
    });
  });

  test("an id the bytes already store is never duplicated", () => {
    const before = "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a\n";
    expect(decideRawRewrite(before, ["ent-a", "ent-b"])).toEqual({
      action: "rewrite",
      next: "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a, ent-b\n",
      appended: ["ent-b"],
    });
  });

  test("bytes with no Raw section have no home, as before", () => {
    expect(decideRawRewrite("---\nkind: brain-signal\n---\n\nsome body\n", ["ent-a"])).toEqual({
      action: "no-home",
    });
  });

  test("the unchanged page rewrites exactly as the parse-level flow did", () => {
    // The common case: the bytes match the parse, so the decision is the
    // old rewrite, stored ids first and the additions appended.
    const before = "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a\n";
    expect(decideRawRewrite(before, ["ent-b"])).toEqual({
      action: "rewrite",
      next: "---\nkind: brain-signal\n---\n## Raw\nentities: ent-a, ent-b\n",
      appended: ["ent-b"],
    });
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
    // The preview is not discarded: the set surfaces the report the run
    // produced, so both front doors can carry what the pass would add.
    const report = set.relinkReport();
    expect(report?.apply).toBe(false);
    expect(report?.signalsPageSourced).toBe(1);
    expect(report?.anchorsAdded).toBe(1);
    expect(report?.perSource).toEqual([
      { source: "notes/meeting.md", signals: 1, anchorsAdded: 1 },
    ]);
  });

  test("relinkApply hands the task the apply arm, and the surfaced report says what changed", async () => {
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
    const file = inboxFiles()[0]!;
    const set = buildLaneTasks({
      vault,
      configPath,
      searchConfig: resolveSearchConfig({ vault, configPath }),
      now: NOW,
      forceCost: false,
      relinkApply: true,
      safeguardFor: (operation) => ({
        checkpoint: () => {},
        timeoutMs: null,
        operation,
      }),
    });
    const relink = set.tasks.find((task) => task.name === LANE_TASK.relink);
    expect(await relink!.run()).toBeUndefined();
    expect(entitiesLineOf(file)).toBe("entities: ent-people-ada-lovelace");
    const report = set.relinkReport();
    expect(report?.apply).toBe(true);
    expect(report?.signalsChanged).toBe(1);
    expect(report?.anchorsAdded).toBe(1);
  });

  test("the surfaced report is undefined before the relink task has run", () => {
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
    expect(set.relinkReport()).toBeUndefined();
  });
});
