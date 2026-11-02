/**
 * Tests for the shared rules-block writer (plan K1, t_ba41a78a / t_1e952e43).
 *
 * One writer owns every byte written into a vault-root agent rules file
 * through marker fences: the installer writes the `usage` block, the
 * lessons lane promotes into the `lessons` block. The suite pins the
 * writer invariants that make the two producers safe to share one file:
 * operator bytes outside the block are preserved, re-apply is a byte
 * no-op, line endings survive, the exclusive-create backup is taken once,
 * hand-edited blocks refuse, and every malformed-marker shape is a named
 * refusal that wraps the editor's own error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
  ManagedBlockError,
} from "../../../src/core/install/managed-block.ts";
import {
  RulesBlockError,
  RULES_BLOCK_ERROR_KIND,
  RULES_BLOCK_ID,
  RULES_BLOCK_MARKERS,
  RULES_BLOCK_STATE,
  readRulesBlock,
  removeRulesBlock,
  renderRulesBlock,
  rulesBlockDrift,
  writeRulesBlock,
} from "../../../src/core/install/rules-block.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-rules-block-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const OPERATOR = "# my project\n\nSome operator notes that must survive.\n";

const USAGE_BODY = [
  "## Open Second Brain",
  "",
  "Use the marker_writeback guardrail: record memory as atomic facts",
  "in the same turn they are learned.",
].join("\n");

const LESSONS_BODY = ["- prefer small commits", "- measure before tuning"].join("\n");

/** Set a file's mtime to an exact millisecond, for the drift refusals. */
function setMtime(path: string, atMs: number): void {
  utimesSync(path, new Date(atMs), new Date(atMs));
}

/** The `.bak.` backup siblings of `name` currently in the directory. */
function backupsOf(name: string): string[] {
  return readdirSync(tmp)
    .filter((entry) => entry.startsWith(`${name}.bak.`))
    .toSorted();
}

describe("rules-block markers and renderRulesBlock", () => {
  test("the usage entry re-exports the settled default marker spellings", () => {
    expect(RULES_BLOCK_MARKERS.usage.begin).toBe(DEFAULT_BEGIN_MARKER);
    expect(RULES_BLOCK_MARKERS.usage.end).toBe(DEFAULT_END_MARKER);
  });

  test("the lessons entry is a distinct HTML-comment pair", () => {
    expect(RULES_BLOCK_MARKERS.lessons.begin).toBe("<!-- >>> open-second-brain lessons >>> -->");
    expect(RULES_BLOCK_MARKERS.lessons.end).toBe("<!-- >>> open-second-brain lessons <<< -->");
  });

  test("renderRulesBlock renders the fenced document for a new file", () => {
    const usage = renderRulesBlock(RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(usage.beginMarker).toBe(DEFAULT_BEGIN_MARKER);
    expect(usage.endMarker).toBe(DEFAULT_END_MARKER);
    expect(usage.document).toBe(`${DEFAULT_BEGIN_MARKER}\n${USAGE_BODY}\n${DEFAULT_END_MARKER}\n`);

    const lessons = renderRulesBlock(RULES_BLOCK_ID.lessons, LESSONS_BODY);
    expect(lessons.document).toBe(
      `${RULES_BLOCK_MARKERS.lessons.begin}\n${LESSONS_BODY}\n${RULES_BLOCK_MARKERS.lessons.end}\n`,
    );
  });
});

describe("writeRulesBlock", () => {
  test("creates an absent file with just the block", () => {
    const file = join(tmp, "AGENTS.md");
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(
      renderRulesBlock(RULES_BLOCK_ID.usage, USAGE_BODY).document,
    );
  });

  test("preserves every operator byte outside the block", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const out = readFileSync(file, "utf8");
    expect(out.startsWith(OPERATOR)).toBe(true);
    expect(out).toContain(USAGE_BODY);
  });

  test("a re-apply is a byte no-op reporting changed false", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const once = readFileSync(file, "utf8");
    const second = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  test("detects and preserves CRLF line endings", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, "# title\r\noperator line\r\n");
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const out = readFileSync(file, "utf8");
    expect(out.includes("\r\n")).toBe(true);
    expect(out.startsWith("# title\r\noperator line\r\n")).toBe(true);
    // The markers themselves are CRLF-terminated lines now.
    expect(out.includes(`${DEFAULT_BEGIN_MARKER}\r\n`)).toBe(true);
    // A re-apply on the CRLF file is still a byte no-op.
    const second = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(second.changed).toBe(false);
  });

  test("writes both blocks into one file without the pairs fighting", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    writeRulesBlock(file, RULES_BLOCK_ID.lessons, LESSONS_BODY);
    const out = readFileSync(file, "utf8");
    expect(out).toContain(DEFAULT_BEGIN_MARKER);
    expect(out).toContain(RULES_BLOCK_MARKERS.lessons.begin);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
    expect(readRulesBlock(file, RULES_BLOCK_ID.lessons)).toBe(LESSONS_BODY);
  });

  test("takes exactly one exclusive-create backup before the first write and none on a no-op", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const first = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(first.backupPath).not.toBeNull();
    expect(backupsOf("AGENTS.md").length).toBe(1);
    expect(readFileSync(first.backupPath as string, "utf8")).toBe(OPERATOR);
    // The backup was created exclusively: a real file, not a leftover temp.
    expect(lstatSync(first.backupPath as string).isFile()).toBe(true);
    const second = writeRulesBlock(file, RULES_BLOCK_ID.lessons, LESSONS_BODY);
    // A different block id still changes the file, so it backs up once more.
    expect(second.changed).toBe(true);
    expect(second.backupPath).not.toBeNull();
    expect(backupsOf("AGENTS.md").length).toBe(2);
    const third = writeRulesBlock(file, RULES_BLOCK_ID.lessons, LESSONS_BODY);
    expect(third.changed).toBe(false);
    expect(third.backupPath).toBeNull();
    expect(backupsOf("AGENTS.md").length).toBe(2);
  });

  test("an absent file takes no backup", () => {
    const file = join(tmp, "AGENTS.md");
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(result.backupPath).toBeNull();
    expect(backupsOf("AGENTS.md").length).toBe(0);
  });

  test("refuses a hand-edited block on a file newer than installedAtMs", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const installedAtMs = 1_700_000_000_000;
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    // Hand-edit inside the fence, then stamp the file newer than the install.
    const edited = readFileSync(file, "utf8").replace("atomic facts", "my own wording");
    writeFileSync(file, edited);
    setMtime(file, installedAtMs + 60_000);
    let thrown: unknown = null;
    try {
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.userModifiedBlock);
    // The refusal is by name: the message names the file and the remedy.
    expect(err.message).toContain("AGENTS.md");
    expect(err.message).toContain("--force");
    // Nothing was written.
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(backupsOf("AGENTS.md").length).toBe(1);
  });

  test("force rewrites a hand-edited block and the backup holds the prior bytes", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const installedAtMs = 1_700_000_000_000;
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    const edited = readFileSync(file, "utf8").replace("atomic facts", "my own wording");
    writeFileSync(file, edited);
    setMtime(file, installedAtMs + 60_000);
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, {
      installedAtMs,
      force: true,
    });
    expect(result.changed).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath as string, "utf8")).toBe(edited);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
  });

  test("a diverged block on a file older than installedAtMs is a canonical update, not a refusal", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const installedAtMs = 1_700_000_000_000;
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    // The canonical body changed in a newer release; the operator has not
    // touched the file since, so the stale mtime proves the divergence is
    // ours to fix, not theirs to authorize.
    setMtime(file, installedAtMs - 60_000);
    const stale = readFileSync(file, "utf8").replace("atomic facts", "old canonical wording");
    writeFileSync(file, stale);
    setMtime(file, installedAtMs - 60_000);
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    expect(result.changed).toBe(true);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
  });

  test("refuses through a symbolic link, by name", () => {
    const real = join(tmp, "real-agents.md");
    writeFileSync(real, OPERATOR);
    const link = join(tmp, "AGENTS.md");
    symlinkSync(real, link);
    let thrown: unknown = null;
    try {
      writeRulesBlock(link, RULES_BLOCK_ID.usage, USAGE_BODY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(RULES_BLOCK_ERROR_KIND.symlink);
    expect(readFileSync(real, "utf8")).toBe(OPERATOR);
  });

  test("an install anchor stamped into the future is untrusted: the diverged block refuses", () => {
    // A future-stamped anchor would make every later operator hand-edit
    // read as a canonical move under an untouched file. It must count as
    // no record, which refuses every diverged block (fail closed).
    const file = join(tmp, "AGENTS.md");
    const futureAnchor = Date.now() + 10 * 60_000; // far past the skew allowance
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs: futureAnchor });
    const edited = readFileSync(file, "utf8").replace("atomic facts", "my own wording");
    writeFileSync(file, edited);
    // The file is OLDER than the (future) anchor, which is exactly the
    // shape that used to slip through the gate.
    setMtime(file, Date.now() - 60_000);
    let thrown: unknown = null;
    try {
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs: futureAnchor });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.userModifiedBlock);
    expect(err.message).toContain("future");
    expect(err.message).toContain("--force");
    expect(readFileSync(file, "utf8")).toBe(edited);
  });

  test("a stat failure at the hand-edit gate refuses the write, fail closed", () => {
    // The gate re-stats the file after the read; a mid-flight move makes
    // that stat fail. "Not touched" would overwrite a diverged block
    // without --force, so the failure must refuse instead.
    const file = join(tmp, "AGENTS.md");
    const installedAtMs = 1_700_000_000_000;
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
    const edited = readFileSync(file, "utf8").replace("atomic facts", "my own wording");
    writeFileSync(file, edited);
    setMtime(file, installedAtMs - 60_000); // older than the anchor
    let thrown: unknown = null;
    try {
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, {
        installedAtMs,
        seams: { fileMtimeMs: () => null },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.userModifiedBlock);
    expect(err.message).toContain("--force");
    // Nothing was written and no backup was taken (the fixture write was
    // a create, which takes none).
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(backupsOf("AGENTS.md").length).toBe(0);
  });

  test("current bytes that moved during the write refuse by name, touching nothing", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    let thrown: unknown = null;
    try {
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, {
        seams: { currentBytesMatch: () => false },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.concurrentModification);
    expect(err.message).toContain("--force");
    // The refused run left the operator bytes alone and took no backup.
    expect(readFileSync(file, "utf8")).toBe(OPERATOR);
    expect(backupsOf("AGENTS.md").length).toBe(0);
  });

  test("force deliberately writes over the moved bytes", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, {
      force: true,
      seams: { currentBytesMatch: () => false },
    });
    expect(result.changed).toBe(true);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
  });

  test("refuses multiple begin markers of the block's own spelling, wrapping ManagedBlockError", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(
      file,
      `${DEFAULT_BEGIN_MARKER}\nfirst\n${DEFAULT_BEGIN_MARKER}\nsecond\n${DEFAULT_END_MARKER}\n`,
    );
    let thrown: unknown = null;
    try {
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string; cause?: unknown };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.markers);
    expect(err.cause).toBeInstanceOf(ManagedBlockError);
  });

  test("refuses a begin marker without an end marker", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, `${DEFAULT_BEGIN_MARKER}\nnever closed\n`);
    expect(() => writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY)).toThrow(RulesBlockError);
  });

  test("refuses an end marker without a begin marker", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, `${DEFAULT_END_MARKER}\n`);
    expect(() => writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY)).toThrow(RulesBlockError);
  });

  test("refuses a reversed pair", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, `${DEFAULT_END_MARKER}\nbody\n${DEFAULT_BEGIN_MARKER}\n`);
    expect(() => writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY)).toThrow(RulesBlockError);
  });

  test("a foreign spelling's stray markers never block a write of this block", () => {
    // The lessons pair present with a broken shape is not the usage
    // block's problem: one marker pair per spelling, validated per id.
    const file = join(tmp, "AGENTS.md");
    writeFileSync(
      file,
      `${RULES_BLOCK_MARKERS.lessons.begin}\n${RULES_BLOCK_MARKERS.lessons.begin}\n`,
    );
    const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(result.changed).toBe(true);
  });

  describe("dryRun writes nothing on every path", () => {
    test("dryRun on an absent file", () => {
      const file = join(tmp, "AGENTS.md");
      const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { dryRun: true });
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBeNull();
      expect(existsSync(file)).toBe(false);
    });

    test("dryRun on a file with operator content", () => {
      const file = join(tmp, "AGENTS.md");
      writeFileSync(file, OPERATOR);
      const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { dryRun: true });
      expect(result.changed).toBe(true);
      expect(result.backupPath).toBeNull();
      expect(readFileSync(file, "utf8")).toBe(OPERATOR);
      expect(backupsOf("AGENTS.md").length).toBe(0);
    });

    test("dryRun on a current file reports no change", () => {
      const file = join(tmp, "AGENTS.md");
      writeFileSync(file, OPERATOR);
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
      const before = readFileSync(file, "utf8");
      const result = writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { dryRun: true });
      expect(result.changed).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(before);
    });

    test("dryRun still refuses a hand-edited block", () => {
      const file = join(tmp, "AGENTS.md");
      writeFileSync(file, OPERATOR);
      const installedAtMs = 1_700_000_000_000;
      writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs });
      const edited = readFileSync(file, "utf8").replace("atomic facts", "my own wording");
      writeFileSync(file, edited);
      setMtime(file, installedAtMs + 60_000);
      expect(() =>
        writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY, { installedAtMs, dryRun: true }),
      ).toThrow(RulesBlockError);
      expect(readFileSync(file, "utf8")).toBe(edited);
    });
  });
});

describe("readRulesBlock", () => {
  test("returns the extracted body when the pair exists", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
  });

  test("returns null when the file exists but carries no pair of that spelling", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBeNull();
    expect(readRulesBlock(file, RULES_BLOCK_ID.lessons)).toBeNull();
  });

  test("returns null for an absent file", () => {
    expect(readRulesBlock(join(tmp, "AGENTS.md"), RULES_BLOCK_ID.usage)).toBeNull();
  });

  test("returns null when only a DIFFERENT block id's pair exists", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.lessons, LESSONS_BODY);
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBeNull();
    expect(readRulesBlock(file, RULES_BLOCK_ID.lessons)).toBe(LESSONS_BODY);
  });

  test("refuses malformed pairs of its own spelling by name", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(
      file,
      `${DEFAULT_BEGIN_MARKER}\na\n${DEFAULT_BEGIN_MARKER}\nb\n${DEFAULT_END_MARKER}\n`,
    );
    let thrown: unknown = null;
    try {
      readRulesBlock(file, RULES_BLOCK_ID.usage);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(RULES_BLOCK_ERROR_KIND.markers);
  });

  test("refuses a symbolic link, by name", () => {
    const real = join(tmp, "real-agents.md");
    writeFileSync(real, OPERATOR);
    const link = join(tmp, "AGENTS.md");
    symlinkSync(real, link);
    expect(() => readRulesBlock(link, RULES_BLOCK_ID.usage)).toThrow(RulesBlockError);
  });
});

describe("rulesBlockDrift", () => {
  test("absent when the file or the pair is missing", () => {
    const absent = rulesBlockDrift(join(tmp, "AGENTS.md"), RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(absent.state).toBe(RULES_BLOCK_STATE.absent);
    expect(absent.extracted).toBeNull();

    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const noPair = rulesBlockDrift(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(noPair.state).toBe(RULES_BLOCK_STATE.absent);
    expect(noPair.extracted).toBeNull();
  });

  test("current when the extracted body matches the canonical body", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const drift = rulesBlockDrift(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(drift.state).toBe(RULES_BLOCK_STATE.current);
    expect(drift.extracted).toBe(USAGE_BODY);
  });

  test("drifted when the extracted body diverges from the canonical body", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const drift = rulesBlockDrift(file, RULES_BLOCK_ID.usage, `${USAGE_BODY}\nA new clause.\n`);
    expect(drift.state).toBe(RULES_BLOCK_STATE.drifted);
    expect(drift.extracted).toBe(USAGE_BODY);
  });

  test("reads are read-only: drift never writes", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    rulesBlockDrift(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    expect(readFileSync(file, "utf8")).toBe(OPERATOR);
    expect(backupsOf("AGENTS.md").length).toBe(0);
  });
});

describe("removeRulesBlock", () => {
  test("removes only the pair it owns and preserves the other block and operator bytes", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    writeRulesBlock(file, RULES_BLOCK_ID.lessons, LESSONS_BODY);
    const result = removeRulesBlock(file, RULES_BLOCK_ID.usage);
    expect(result.removed).toBe(true);
    const out = readFileSync(file, "utf8");
    expect(out).not.toContain(DEFAULT_BEGIN_MARKER);
    expect(out).not.toContain(DEFAULT_END_MARKER);
    expect(out).not.toContain(USAGE_BODY);
    expect(out).toContain(LESSONS_BODY);
    expect(out).toContain(RULES_BLOCK_MARKERS.lessons.begin);
    expect(out.startsWith(OPERATOR)).toBe(true);
    // Never an empty fence where the lessons block lives.
    expect(readRulesBlock(file, RULES_BLOCK_ID.lessons)).toBe(LESSONS_BODY);
  });

  test("collapses its own padding so cycles do not grow vertical whitespace", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    removeRulesBlock(file, RULES_BLOCK_ID.usage);
    const out = readFileSync(file, "utf8");
    expect(out).toBe(OPERATOR);
  });

  test("is a named skip when no pair of that spelling exists", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    const result = removeRulesBlock(file, RULES_BLOCK_ID.usage);
    expect(result.removed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(OPERATOR);
  });

  test("is a named skip on an absent file", () => {
    const result = removeRulesBlock(join(tmp, "AGENTS.md"), RULES_BLOCK_ID.usage);
    expect(result.removed).toBe(false);
  });

  test("dryRun removes nothing", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    const before = readFileSync(file, "utf8");
    const result = removeRulesBlock(file, RULES_BLOCK_ID.usage, { dryRun: true });
    expect(result.removed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("refuses through a symbolic link, by name", () => {
    const real = join(tmp, "real-agents.md");
    writeFileSync(real, OPERATOR);
    const link = join(tmp, "AGENTS.md");
    symlinkSync(real, link);
    expect(() => removeRulesBlock(link, RULES_BLOCK_ID.usage)).toThrow(RulesBlockError);
  });

  test("current bytes that moved during the removal refuse by name, touching nothing", () => {
    const file = join(tmp, "AGENTS.md");
    writeFileSync(file, OPERATOR);
    writeRulesBlock(file, RULES_BLOCK_ID.usage, USAGE_BODY);
    let thrown: unknown = null;
    try {
      removeRulesBlock(file, RULES_BLOCK_ID.usage, {
        seams: { currentBytesMatch: () => false },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(
      RULES_BLOCK_ERROR_KIND.concurrentModification,
    );
    // The removal was refused before any rewrite.
    expect(readRulesBlock(file, RULES_BLOCK_ID.usage)).toBe(USAGE_BODY);
  });
});
