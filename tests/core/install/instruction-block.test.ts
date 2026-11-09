/**
 * Tests for the brain-usage block installer step (plan K2, t_ba41a78a).
 *
 * The installer maps each install target to the agent-instruction file
 * its host reads, plans a pure preview (vault-root path, exists, changed,
 * diff, note), and applies under an approved-preview binding: the apply
 * re-derives the plan from the live disk and refuses to write anything
 * else. Every write routes through the shared rules-block writer, and a
 * successful apply records the ownership lock this module also owns.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  auditWritebackContractFile,
  CANONICAL_WRITEBACK_BLOCK_BODY,
} from "../../../src/core/brain/writeback-contract.ts";
import { INSTALL_TARGET_IDS, type InstallTargetId } from "../../../src/core/runtime/host-facts.ts";
import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";
import {
  INSTRUCTION_BLOCK_LOCK_FILE,
  applyInstructionBlock,
  clearInstructionBlock,
  instructionBlockLockPath,
  instructionBlockTargetFor,
  planInstructionBlock,
  readInstructionBlockLock,
  recordInstructionBlock,
} from "../../../src/core/install/instruction-block.ts";
import { HOST_INSTRUCTION_PRECEDENCE } from "../../../src/core/brain/writeback-contract.ts";
import {
  RULES_BLOCK_ERROR_KIND,
  RULES_BLOCK_ID,
  RULES_BLOCK_MARKERS,
  RulesBlockError,
  writeRulesBlock,
} from "../../../src/core/install/rules-block.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-instruction-block-"));
  // A legacy vault: it keeps its machine state. A vault with no `Brain/`
  // is store-only and keeps that state device-local instead.
  mkdirSync(join(tmp, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const APPLIED_AT_MS = 1_700_000_000_000;

function envFor(vault: string): InstallEnv {
  return {
    vault,
    home: tmp,
    cwd: tmp,
    env: {},
    now: new Date(APPLIED_AT_MS),
  };
}

const OPERATOR = "# project notes\n\nHand-written content.\n";

/** The non-conforming body a manual install from the older docs pasted. */
const DOCS_SNIPPET_BODY = [
  "## Open Second Brain",
  "",
  "This project shares an Obsidian-compatible vault with an active",
  "observing-memory layer. At session start, read Brain/active.md.",
].join("\n");

const DOCS_SNIPPET_FILE = [
  OPERATOR,
  DEFAULT_BEGIN_MARKER,
  DOCS_SNIPPET_BODY,
  DEFAULT_END_MARKER,
  "",
].join("\n");

/** Backup siblings of `AGENTS.md` currently in the directory. */
function backupsOf(name: string): string[] {
  return readdirSync(tmp)
    .filter((entry) => entry.startsWith(`${name}.bak.`))
    .toSorted();
}

describe("instructionBlockTargetFor", () => {
  test("maps codex, cursor, opencode and aider to AGENTS.md", () => {
    expect(instructionBlockTargetFor("codex")).toBe("AGENTS.md");
    expect(instructionBlockTargetFor("cursor")).toBe("AGENTS.md");
    expect(instructionBlockTargetFor("opencode")).toBe("AGENTS.md");
    expect(instructionBlockTargetFor("aider")).toBe("AGENTS.md");
  });

  test("maps gemini-cli to GEMINI.md", () => {
    expect(instructionBlockTargetFor("gemini-cli")).toBe("GEMINI.md");
  });

  test("returns null, as a named skip, for targets with no precedence entry", () => {
    for (const target of ["copilot-cli", "grok", "kiro", "pi", "generic"] as const) {
      expect(instructionBlockTargetFor(target)).toBeNull();
    }
  });

  test("follows HOST_INSTRUCTION_PRECEDENCE if the table or targets ever grow", () => {
    const table = HOST_INSTRUCTION_PRECEDENCE as Readonly<Record<string, readonly string[]>>;
    for (const target of INSTALL_TARGET_IDS as ReadonlyArray<InstallTargetId>) {
      expect(instructionBlockTargetFor(target)).toBe(table[target]?.[0] ?? null);
    }
  });
});

describe("planInstructionBlock", () => {
  test("plans a vault-root path for an absent file, with a creation note", () => {
    const env = envFor(tmp);
    const plan = planInstructionBlock(env, "codex");
    expect(plan.path).toBe(join(tmp, "AGENTS.md"));
    expect(plan.exists).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.diff).not.toBe("");
    expect(plan.note).not.toBeNull();
    expect(plan.note).toContain("AGENTS.md");
  });

  test("plans an insert into an operator-authored file and renders the diff", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const plan = planInstructionBlock(envFor(tmp), "codex");
    expect(plan.exists).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain(`--- ${join(tmp, "AGENTS.md")}`);
    expect(plan.diff).toContain(DEFAULT_BEGIN_MARKER);
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(OPERATOR);
  });

  test("a current block plans no change and no diff", () => {
    writeRulesBlock(join(tmp, "AGENTS.md"), RULES_BLOCK_ID.usage, CANONICAL_WRITEBACK_BLOCK_BODY);
    const plan = planInstructionBlock(envFor(tmp), "codex");
    expect(plan.exists).toBe(true);
    expect(plan.changed).toBe(false);
    expect(plan.diff).toBe("");
  });

  test("a drifted block plans a replacement diff", () => {
    writeFileSync(join(tmp, "AGENTS.md"), DOCS_SNIPPET_FILE);
    const plan = planInstructionBlock(envFor(tmp), "codex");
    expect(plan.exists).toBe(true);
    expect(plan.changed).toBe(true);
    expect(plan.diff).toContain(
      "- observing-memory layer. At session start, read Brain/active.md.",
    );
    expect(plan.diff).toContain("+ Memory write gate: apply the marker_writeback guardrail.");
  });

  test("the gemini-cli file carries the name-implied-reading note", () => {
    const plan = planInstructionBlock(envFor(tmp), "gemini-cli");
    expect(plan.path).toBe(join(tmp, "GEMINI.md"));
    expect(plan.note).toContain("name-implied");
  });

  test("plans read, never write: a drift-only call leaves the vault untouched", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    planInstructionBlock(envFor(tmp), "codex");
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(OPERATOR);
    expect(backupsOf("AGENTS.md").length).toBe(0);
    expect(existsSync(instructionBlockLockPath(tmp))).toBe(false);
  });

  test("refuses a symbolic link, by name, with the checker's posture", () => {
    const real = join(tmp, "real-agents.md");
    writeFileSync(real, OPERATOR);
    symlinkSync(real, join(tmp, "AGENTS.md"));
    expect(() => planInstructionBlock(envFor(tmp), "codex")).toThrow(RulesBlockError);
  });

  test("refuses malformed markers of the block's own spelling, by name", () => {
    writeFileSync(
      join(tmp, "AGENTS.md"),
      `${DEFAULT_BEGIN_MARKER}\nbroken\n${DEFAULT_BEGIN_MARKER}\n`,
    );
    let thrown: unknown = null;
    try {
      planInstructionBlock(envFor(tmp), "codex");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(RULES_BLOCK_ERROR_KIND.markers);
  });
});

describe("applyInstructionBlock", () => {
  test("writes the approved plan, backs up, records the lock, and the audit conforms", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    const result = applyInstructionBlock(env, { approved });
    expect(result.backupPath).not.toBeNull();
    expect(backupsOf("AGENTS.md").length).toBe(1);
    expect(readFileSync(result.backupPath as string, "utf8")).toBe(OPERATOR);
    const audit = auditWritebackContractFile(join(tmp, "AGENTS.md"));
    expect(audit.finding).toBe("conforming");
    const lock = readInstructionBlockLock(tmp);
    expect(lock.schema_version).toBe(1);
    const entry = lock.files["AGENTS.md"];
    expect(entry).toBeDefined();
    expect(entry?.block_id).toBe(RULES_BLOCK_ID.usage);
    expect(entry?.begin_marker).toBe(RULES_BLOCK_MARKERS.usage.begin);
    // The lock stamps when the write landed: the mtime the gate itself
    // compares against, not the run-start clock in env.now.
    expect(Date.parse(entry?.applied_at ?? "")).toBe(
      Math.trunc(statSync(join(tmp, "AGENTS.md")).mtimeMs),
    );
  });

  test("the lock stamps when the write landed, not the run-start clock", () => {
    // env.now predates the plan render, the consent prompt and the
    // adapter apply - on an interactive install by more than the writer's
    // MTIME_SLACK_MS. A run-start stamp then sits behind the written
    // file's mtime, so the next canonical-body upgrade read our own
    // write as a later hand edit and refused with user-modified-block
    // instead of taking the documented rewrite path. The lock records
    // the written file's mtime, the exact anchor the hand-edit gate
    // compares against.
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    const stamped = Date.parse(readInstructionBlockLock(tmp).files["AGENTS.md"]?.applied_at ?? "");
    expect(stamped).toBe(Math.trunc(statSync(join(tmp, "AGENTS.md")).mtimeMs));
    expect(stamped).not.toBe(APPLIED_AT_MS);
  });

  test("a re-plan and re-apply converge: changed false, no new backup", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    const once = readFileSync(join(tmp, "AGENTS.md"), "utf8");
    const second = applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    expect(second.backupPath).toBeNull();
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(once);
    expect(backupsOf("AGENTS.md").length).toBe(1);
  });

  test("refuses preview drift by name and writes nothing", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    // The operator edits between consent and apply.
    writeFileSync(join(tmp, "AGENTS.md"), `${OPERATOR}\nMore notes.\n`);
    let thrown: unknown = null;
    try {
      applyInstructionBlock(env, { approved });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.previewDrift);
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(`${OPERATOR}\nMore notes.\n`);
    expect(backupsOf("AGENTS.md").length).toBe(0);
    expect(existsSync(instructionBlockLockPath(tmp))).toBe(false);
  });

  test("refuses a docs-snippet block without force, then upgrades it with force to conforming", () => {
    writeFileSync(join(tmp, "AGENTS.md"), DOCS_SNIPPET_FILE);
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    // No lock record exists, so the diverged block cannot be proven ours:
    // the refusal is fail-closed by name.
    let thrown: unknown = null;
    try {
      applyInstructionBlock(env, { approved });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(
      RULES_BLOCK_ERROR_KIND.userModifiedBlock,
    );
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(DOCS_SNIPPET_FILE);
    // The documented override: force rewrites, the backup holds the prior
    // bytes, and the real auditor now grades the file conforming.
    const result = applyInstructionBlock(env, { approved, force: true });
    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath as string, "utf8")).toBe(DOCS_SNIPPET_FILE);
    expect(auditWritebackContractFile(join(tmp, "AGENTS.md")).finding).toBe("conforming");
    expect(readInstructionBlockLock(tmp).files["AGENTS.md"]).toBeDefined();
  });

  test("an installedAtMs from the lock excuses a divergence on a stale file", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    // The canonical body changed in a newer release; the file mtime is
    // still at the recorded install time, so the rewrite is ours to make.
    const second = planInstructionBlock(envFor(tmp), "codex");
    expect(second.changed).toBe(false);
  });

  test("dryRun writes nothing: no file change, no backup, no lock", () => {
    writeFileSync(join(tmp, "AGENTS.md"), OPERATOR);
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    const result = applyInstructionBlock(env, { approved, dryRun: true });
    expect(result.backupPath).toBeNull();
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(OPERATOR);
    expect(backupsOf("AGENTS.md").length).toBe(0);
    expect(existsSync(instructionBlockLockPath(tmp))).toBe(false);
  });

  test("refuses an approved plan that does not name a vault-root agent instruction file", () => {
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    const forged = { ...approved, path: join(tmp, "elsewhere", "AGENTS.md") };
    let thrown: unknown = null;
    try {
      applyInstructionBlock(env, { approved: forged });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    expect((thrown as Error & { kind?: string }).kind).toBe(RULES_BLOCK_ERROR_KIND.invalidPlan);
  });

  test("an unchanged approved apply records ownership, so uninstall can find the block", () => {
    writeRulesBlock(join(tmp, "AGENTS.md"), RULES_BLOCK_ID.usage, CANONICAL_WRITEBACK_BLOCK_BODY);
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    expect(approved.changed).toBe(false);
    applyInstructionBlock(env, { approved });
    expect(readInstructionBlockLock(tmp).files["AGENTS.md"]).toBeDefined();
  });

  test("the apply result names what happened: created, updated, or already current", () => {
    const env = envFor(tmp);
    // First apply on a vault with no AGENTS.md: the file is CREATED. The
    // result must say so - a backupPath-only derivation would report the
    // creation as "already carries the block".
    const created = applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    expect(created.created).toBe(true);
    expect(created.changed).toBe(true);
    expect(created.backupPath).toBeNull();
    // A re-apply is already current on both fields.
    const current = applyInstructionBlock(env, { approved: planInstructionBlock(env, "codex") });
    expect(current.created).toBe(false);
    expect(current.changed).toBe(false);
    // A diverged block rewritten under force is an UPDATE of an existing
    // file, not a creation.
    writeFileSync(join(tmp, "AGENTS.md"), DOCS_SNIPPET_FILE);
    const updated = applyInstructionBlock(env, {
      approved: planInstructionBlock(env, "codex"),
      force: true,
    });
    expect(updated.created).toBe(false);
    expect(updated.changed).toBe(true);
    expect(updated.backupPath).not.toBeNull();
  });

  test("a future-stamped applied_at is untrusted: a diverged block refuses without force", () => {
    // The lock lives in agent-writable state; an applied_at stamped into
    // the future would make every operator hand-edit read as a canonical
    // move under an untouched file. The gate must treat it as no record.
    writeFileSync(join(tmp, "AGENTS.md"), DOCS_SNIPPET_FILE);
    recordInstructionBlock(tmp, "AGENTS.md", {
      block_id: RULES_BLOCK_ID.usage,
      begin_marker: RULES_BLOCK_MARKERS.usage.begin,
      applied_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const env = envFor(tmp);
    const approved = planInstructionBlock(env, "codex");
    let thrown: unknown = null;
    try {
      applyInstructionBlock(env, { approved });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RulesBlockError);
    const err = thrown as Error & { kind?: string };
    expect(err.kind).toBe(RULES_BLOCK_ERROR_KIND.userModifiedBlock);
    expect(err.message).toContain("future");
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf8")).toBe(DOCS_SNIPPET_FILE);
    // --force stays the documented override.
    const forced = applyInstructionBlock(env, { approved, force: true });
    expect(forced.changed).toBe(true);
    expect(auditWritebackContractFile(join(tmp, "AGENTS.md")).finding).toBe("conforming");
  });
});

describe("instruction-block lock I/O", () => {
  test("the lock file name and path are the derived-store join", () => {
    expect(INSTRUCTION_BLOCK_LOCK_FILE).toBe("instruction-block.lock.json");
    expect(instructionBlockLockPath(tmp)).toBe(
      join(tmp, ".open-second-brain", "instruction-block.lock.json"),
    );
    expect(basename(instructionBlockLockPath(tmp))).toBe("instruction-block.lock.json");
  });

  test("an absent lock reads as an empty schema-1 document", () => {
    const lock = readInstructionBlockLock(tmp);
    expect(lock.schema_version).toBe(1);
    expect(Object.keys(lock.files).length).toBe(0);
  });

  test("record and clear round-trip atomically", () => {
    recordInstructionBlock(tmp, "AGENTS.md", {
      block_id: RULES_BLOCK_ID.usage,
      begin_marker: RULES_BLOCK_MARKERS.usage.begin,
      applied_at: new Date(APPLIED_AT_MS).toISOString(),
    });
    recordInstructionBlock(tmp, "GEMINI.md", {
      block_id: RULES_BLOCK_ID.usage,
      begin_marker: RULES_BLOCK_MARKERS.usage.begin,
      applied_at: new Date(APPLIED_AT_MS).toISOString(),
    });
    expect(Object.keys(readInstructionBlockLock(tmp).files).toSorted()).toEqual([
      "AGENTS.md",
      "GEMINI.md",
    ]);
    // Re-recording one file replaces its entry, not the others.
    recordInstructionBlock(tmp, "AGENTS.md", {
      block_id: RULES_BLOCK_ID.usage,
      begin_marker: RULES_BLOCK_MARKERS.usage.begin,
      applied_at: new Date(APPLIED_AT_MS + 1).toISOString(),
    });
    expect(readInstructionBlockLock(tmp).files["AGENTS.md"]?.applied_at).toBe(
      new Date(APPLIED_AT_MS + 1).toISOString(),
    );
    expect(readInstructionBlockLock(tmp).files["GEMINI.md"]).toBeDefined();
    clearInstructionBlock(tmp, "AGENTS.md");
    expect(readInstructionBlockLock(tmp).files["AGENTS.md"]).toBeUndefined();
    clearInstructionBlock(tmp, "CLAUDE.md");
    expect(Object.keys(readInstructionBlockLock(tmp).files)).toEqual(["GEMINI.md"]);
  });

  test("corrupted JSON refuses with a named error carrying the path", () => {
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    writeFileSync(instructionBlockLockPath(tmp), "{ not json");
    expect(() => readInstructionBlockLock(tmp)).toThrow(/instruction-block\.lock\.json/);
  });

  test("a non-object document refuses with a named error", () => {
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    writeFileSync(instructionBlockLockPath(tmp), "[1, 2]\n");
    expect(() => readInstructionBlockLock(tmp)).toThrow(/not an object/);
  });

  test("an unsupported schema_version refuses with a named error", () => {
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    writeFileSync(
      instructionBlockLockPath(tmp),
      JSON.stringify({ schema_version: 99, files: {} }) + "\n",
    );
    expect(() => readInstructionBlockLock(tmp)).toThrow(/schema_version 99/);
  });

  test("the lock is never a symlink target: reads refuse links with the writer's posture", () => {
    // A lock that can be redirected reads state the vault never wrote.
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    const real = join(tmp, "real-lock.json");
    writeFileSync(real, JSON.stringify({ schema_version: 1, files: {} }));
    symlinkSync(real, instructionBlockLockPath(tmp));
    expect(() => readInstructionBlockLock(tmp)).toThrow(RulesBlockError);
  });
});
