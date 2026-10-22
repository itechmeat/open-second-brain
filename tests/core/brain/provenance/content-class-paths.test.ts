/**
 * The deterministic prompt-derived write paths (F5, task E2).
 *
 * Three write paths are definitionally prompt-derived and stamp
 * `content_class: prompt-derived` at creation, server-side:
 *  - a note created over the MCP transport (the mcp-tool origin channel),
 *  - a signal replayed from a session by the import,
 *  - a research report the in-process pipeline synthesised.
 *
 * An operator-authored CLI write stays unmarked - the class describes the
 * material, and the CLI is where an operator's own words enter the vault.
 * The writer-input pin at the bottom is the type-level half of the
 * origin-channel census carried over to this axis: no writer input may
 * declare the field, or an in-process caller could assert what only the
 * writer that knows the material may claim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync as readSource } from "node:fs";

import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import { writeResearchReport } from "../../../../src/core/brain/research/research.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { createNote } from "../../../../src/core/brain/notes/create-note.ts";
import {
  CONTENT_CLASS_FIELD,
  CONTENT_CLASS,
} from "../../../../src/core/brain/provenance/content-class.ts";
import {
  clearOriginChannel,
  ORIGIN_CHANNEL,
  setOriginChannel,
} from "../../../../src/core/origin-channel.ts";

const CLAUDE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-content-class-paths-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-content-class-cfg-"));
  const dirs = brainDirs(vault);
  for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  clearOriginChannel();
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("session import stamps the class", () => {
  test("every signal a session replay writes carries content_class", async () => {
    const res = await importSession(vault, CLAUDE, { agent: "test" });
    expect(res.signals_created).toBeGreaterThan(0);
    const inbox = readdirSync(brainDirs(vault).inbox).filter((n) => n.startsWith("sig-"));
    expect(inbox.length).toBe(res.signals_created);
    for (const name of inbox) {
      const text = readFileSync(join(brainDirs(vault).inbox, name), "utf8");
      expect(`${name}: ${text.includes(`${CONTENT_CLASS_FIELD}: prompt-derived`)}`).toBe(
        `${name}: true`,
      );
    }
  });

  test("the stamp rides the signal through a re-run dedup unchanged", async () => {
    await importSession(vault, CLAUDE, { agent: "test" });
    const second = await importSession(vault, CLAUDE, { agent: "test" });
    expect(second.signals_created).toBe(0);
    const inbox = readdirSync(brainDirs(vault).inbox).filter((n) => n.startsWith("sig-"));
    for (const name of inbox) {
      const text = readFileSync(join(brainDirs(vault).inbox, name), "utf8");
      expect(text.includes(`${CONTENT_CLASS_FIELD}: prompt-derived`)).toBe(true);
    }
  });
});

describe("research reports stamp the class", () => {
  test("a written report page carries content_class: prompt-derived", () => {
    const res = writeResearchReport(
      vault,
      {
        title: "Class stamp survey",
        sources: ["Articles/a.md"],
        findings: [{ statement: "One finding", sources: ["Articles/a.md"] }],
      },
      { agent: "claude", now: new Date("2026-06-13T12:00:00Z") },
    );
    expect(res.created).toBe(true);
    const text = readFileSync(join(vault, res.reportPath), "utf8");
    expect(text).toContain(`${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}`);
  });
});

describe("operator-authored CLI writes stay unmarked", () => {
  test("a note created under a claimed cli channel carries no class", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    const res = createNote(vault, { path: "Notes/ByHand.md", content: "operator words" });
    expect(res.created).toBe(true);
    const text = readFileSync(join(vault, "Notes/ByHand.md"), "utf8");
    expect(text).not.toContain(CONTENT_CLASS_FIELD);
  });
});

describe("no writer input declares the class", () => {
  test("the caller-facing input interfaces have no content_class field", () => {
    // The type-level pin, in the shape the origin-channel census uses for
    // the channel: the one input interface a caller fills in per writer
    // family must not carry the field, or TypeScript could be talked into
    // letting an in-process caller assert its own class.
    const WRITER_INPUT_TYPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
      ["src/core/brain/notes/create-note.ts", "CreateNoteInput"],
      ["src/core/brain/research/research.ts", "ResearchReportInput"],
      ["src/core/brain/sessions/import.ts", "ImportSessionOptions"],
    ]);
    const offenders: string[] = [];
    for (const [path, typeName] of WRITER_INPUT_TYPES) {
      const text = readSource(resolve(path), "utf8");
      const start = text.indexOf(`interface ${typeName} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = text.indexOf("\n}", start);
      const block = text.slice(start, end);
      if (new RegExp(`readonly\\s+${CONTENT_CLASS_FIELD}\\??\\s*:`).test(block)) {
        offenders.push(`${path}: ${typeName}.${CONTENT_CLASS_FIELD}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
