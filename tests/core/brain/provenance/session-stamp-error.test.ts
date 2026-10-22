/**
 * The session import's stamp-failure accounting.
 *
 * A signal a session replay writes is stamped `content_class:
 * prompt-derived` on the same run that wrote it (pinned in
 * `content-class-paths.test.ts`). When the stamp raises - the write
 * succeeded, the stamp did not - the import records the failure in its
 * `errors` list and keeps going, and the row must name the page the
 * failure is about: the freshly written signal page, not the session
 * transcript the import merely read. A row that names the transcript
 * sends the operator to reread a file with nothing wrong with it while
 * the unmarked page sits unexamined in the inbox.
 *
 * The stamp machinery is mocked at the module seam (the established
 * `mock.module` idiom) because `writeSignal` always emits a parseable
 * frontmatter block - there is no honest input that fails the stamp on
 * its own, and the accounting, not the stamp, is what is under test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";

const CONTENT_CLASS_MODULE = "../../../../src/core/brain/provenance/content-class.ts";
const IMPORT_MODULE = "../../../../src/core/brain/sessions/import.ts";
const CLAUDE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");

let vault: string;
let configHome: string;
let realContentClass: Record<string, unknown> | null = null;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-stamp-error-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-stamp-error-cfg-"));
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
  // This runner's mock registration outlives mock.restore() across test
  // FILES, so the teardown re-registers the REAL module object instead:
  // whatever leaks past this file is content-class.ts itself, byte for
  // byte.
  if (realContentClass !== null) mock.module(CONTENT_CLASS_MODULE, () => realContentClass);
  mock.restore();
  realContentClass = null;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("a stamp failure is reported against the signal page", () => {
  test("the error row names the written signal, not the session transcript", async () => {
    realContentClass = { ...(await import(CONTENT_CLASS_MODULE)) };
    mock.module(CONTENT_CLASS_MODULE, () => ({
      ...realContentClass,
      stampPromptDerivedLine: () => {
        throw new Error("stamp machinery exploded");
      },
    }));
    // Imported AFTER the mock so the import's binding is the stub.
    const { importSession } = await import(IMPORT_MODULE);

    const res = await importSession(vault, CLAUDE, { agent: "test" });
    // The writes themselves succeeded; every created signal then failed
    // to stamp, and every failure is named.
    expect(res.signals_created).toBeGreaterThan(0);
    expect(res.errors).toHaveLength(res.signals_created);

    const transcript = resolve(CLAUDE);
    const inbox = brainDirs(vault).inbox;
    for (const row of res.errors) {
      expect(row.message).toContain("content-class stamp failed");
      expect(`${row.path === transcript}: not the transcript`).toBe("false: not the transcript");
      expect(row.path.startsWith(inbox)).toBe(true);
      expect(row.path.endsWith(".md")).toBe(true);
    }
  });
});
