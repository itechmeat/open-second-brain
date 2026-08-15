/**
 * `o2b brain note-lifecycle <action>` CLI surface (B2).
 *
 * The defect: rename, move, delete and archive existed on no surface at
 * all, so an operator holding a mis-named note in a vault had nothing to
 * run. This file covers the CLI's own share of that - the flag surface,
 * the exit codes, and that the destructive arm cannot be reached by
 * omitting a flag - and asserts that the JSON receipt carries the index
 * freshness out to a shell, because a terminal is where the operator who
 * has to decide whether to re-index actually is.
 *
 * Deliberately NOT covered here: the relocation semantics and the
 * reference rewriting (the core test owns those), and the tool-schema
 * shape (the MCP test owns that).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-note-lifecycle-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  // A REAL Brain tree, not a bare directory: the delete arm runs behind
  // `withDestructiveSnapshot`, which archives `Brain/` and refuses an
  // empty one - the same precondition `o2b brain forget-source` has
  // carried since it shipped.
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

test("rename moves the note and reports the index freshness in its receipt", async () => {
  note("Projects/Old.md", "x\n");
  note("Projects/Ref.md", "[[Projects/Old]]\n");

  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename",
    "Projects/Old.md",
    "Projects/New.md",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    applied: boolean;
    to: string;
    references: { files_rewritten: number; index: { state: string; next_command: string } };
  };
  expect(body.applied).toBe(true);
  expect(body.to).toBe("Projects/New.md");
  expect(body.references.files_rewritten).toBe(1);
  expect(body.references.index.state).toBe("absent");
  expect(body.references.index.next_command.length).toBeGreaterThan(0);
  expect(existsSync(join(vault, "Projects/New.md"))).toBe(true);
});

test("without --apply the verb plans and writes nothing", async () => {
  note("Projects/Old.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename",
    "Projects/Old.md",
    "Projects/New.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  expect((JSON.parse(res.stdout) as { applied: boolean }).applied).toBe(false);
  expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
});

test("delete refuses without --confirm and exits non-zero", async () => {
  note("Projects/Gone.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "delete",
    "Projects/Gone.md",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("confirm");
  expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(true);
});

test("delete under --confirm removes the note and prints the recoverability verdict", async () => {
  note("Projects/Gone.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "delete",
    "Projects/Gone.md",
    "--vault",
    vault,
    "--apply",
    "--confirm",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { recoverability: { state: string; blockers: string[] } };
  expect(body.recoverability.state).toBe("unproven");
  expect(body.recoverability.blockers).toContain("outside_brain_root");
  expect(existsSync(join(vault, "Projects/Gone.md"))).toBe(false);
});

test("archive needs no destination and refuses one", async () => {
  note("Projects/Done.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "archive",
    "Projects/Done.md",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  expect((JSON.parse(res.stdout) as { to: string }).to).toBe("Archive/Projects/Done.md");
  expect(existsSync(join(vault, "Archive/Projects/Done.md"))).toBe(true);
});

test("an unknown action is a usage error, not a fallback", async () => {
  note("Projects/Old.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "obliterate",
    "Projects/Old.md",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).toBe(2);
  expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
});

test("--expect aborts before writing when the inbound count disagrees", async () => {
  note("Projects/Old.md", "x\n");
  note("Projects/A.md", "[[Projects/Old]]\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename",
    "Projects/Old.md",
    "Projects/New.md",
    "--vault",
    vault,
    "--apply",
    "--expect",
    "4",
  ]);
  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("matched 1");
  expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
});
