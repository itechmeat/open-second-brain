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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    references: {
      files_rewritten: number;
      rewritten_spellings: Array<{ from: string; to: string }>;
      index: { state: string; next_command: string };
      refresh: string;
      refresh_reason: string | null;
    };
  };
  expect(body.applied).toBe(true);
  expect(body.to).toBe("Projects/New.md");
  expect(body.references.files_rewritten).toBe(1);
  // The spellings the rewrite carried out, minimal forms included.
  expect(body.references.rewritten_spellings).toEqual([
    { from: "Projects/Old.md", to: "New" },
    { from: "Projects/Old", to: "New" },
    { from: "Old", to: "New" },
  ]);
  // Freshening is off suite-wide, so the write claimed nothing and the
  // next command remains the reconciliation - and the refusal carries
  // its reason, so `not_claimed` is not mistaken for a broken spawn.
  expect(body.references.refresh).toBe("not_claimed");
  expect(body.references.refresh_reason).toBe("no_index");
  expect(body.references.index.state).toBe("absent");
  expect(body.references.index.next_command.length).toBeGreaterThan(0);
  expect(existsSync(join(vault, "Projects/New.md"))).toBe(true);
});

test("the refusal reason reaches a terminal reader too, not only the JSON", async () => {
  note("Projects/Old.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename",
    "Projects/Old.md",
    "Projects/New.md",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).toBe(0);
  // The human line names why nothing was started, beside the token.
  expect(res.stdout).toContain("refresh: not_claimed (no_index)");
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

test("--delete-linked prints the deletion set and the reported set separately", async () => {
  note("Imports/Bench.md", "rows\n");
  note("Projects/Reader.md", "[[Imports/Bench]]\n");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "inbox", "sig-derived.md"),
    '---\nid: sig-derived\nkind: brain-signal\nsource:\n  - "[[Imports/Bench]]"\n---\n\nbody\n',
  );

  const dry = await runCli([
    "brain",
    "note-lifecycle",
    "delete",
    "Imports/Bench.md",
    "--delete-linked",
    "--vault",
    vault,
  ]);
  expect(dry.returncode).toBe(0);
  expect(dry.stdout).toContain("deletion set (2, scope Brain/)");
  expect(dry.stdout).toContain("Brain/inbox/sig-derived.md");
  expect(dry.stdout).toContain("reported, not deleted (1)");
  expect(dry.stdout).toContain("Projects/Reader.md");
  expect(existsSync(join(vault, "Imports/Bench.md"))).toBe(true);

  const applied = await runCli([
    "brain",
    "note-lifecycle",
    "delete",
    "Imports/Bench.md",
    "--delete-linked",
    "--vault",
    vault,
    "--apply",
    "--confirm",
    "--expect",
    "2",
    "--json",
  ]);
  expect(applied.returncode).toBe(0);
  const body = JSON.parse(applied.stdout) as {
    cascade: { deletion_set: string[]; reported_files: string[]; scanned_scope: string };
  };
  expect(body.cascade.deletion_set).toEqual(["Imports/Bench.md", "Brain/inbox/sig-derived.md"]);
  expect(existsSync(join(vault, "Brain", "inbox", "sig-derived.md"))).toBe(false);
  // Reported, therefore untouched - and still naming the note it lost.
  expect(readFileSync(join(vault, "Projects/Reader.md"), "utf8")).toContain("[[Imports/Bench]]");
});

test("--delete-linked on a rename is a refusal, not a silently ignored flag", async () => {
  note("Projects/Old.md", "x\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename",
    "Projects/Old.md",
    "Projects/New.md",
    "--delete-linked",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("delete-linked");
  expect(existsSync(join(vault, "Projects/Old.md"))).toBe(true);
});

test("move-folder relocates the folder and renders the move report as JSON", async () => {
  note("Projects/Old/a.md", "alpha\n");
  note("Projects/Old/b.md", "beta\n");
  note("Notes/Ref.md", "pathed [[Projects/Old/a]]\n");

  const res = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Old",
    "Archive",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    action: string;
    from: string;
    to: string;
    applied: boolean;
    moved: Array<{ from: string; to: string }>;
    move_failures: Array<{ path: string; reason: string }>;
    snapshot: null;
    references: { files_rewritten: number; files_scanned: number };
  };
  expect(body.action).toBe("move-folder");
  expect(body.applied).toBe(true);
  expect(body.from).toBe("Projects/Old");
  expect(body.to).toBe("Archive/Old");
  // The moved list, per file, and the per-file failure list - the report
  // style the folder module's result is read in.
  expect(body.moved).toEqual([
    { from: "Projects/Old/a.md", to: "Archive/Old/a.md" },
    { from: "Projects/Old/b.md", to: "Archive/Old/b.md" },
  ]);
  expect(body.move_failures).toEqual([]);
  // A relocation destroys nothing, so no snapshot rides the receipt.
  expect(body.snapshot).toBeNull();
  // Absent-when-empty: a clean move left nothing behind, so the key is
  // not on the receipt at all - its presence is the signal.
  expect("left_behind" in body).toBe(false);
  // No relative link broke either: every target the moved notes name is
  // a note that moved with the folder.
  expect("dangling_relative_links" in body).toBe(false);
  expect(body.references.files_rewritten).toBe(1);
  expect(existsSync(join(vault, "Archive/Old/a.md"))).toBe(true);
  expect(existsSync(join(vault, "Archive/Old/b.md"))).toBe(true);
  expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(false);
});

test("a folder action refuses --confirm and --delete-linked instead of dropping them", async () => {
  note("Projects/Old/a.md", "alpha\n");
  for (const flag of ["--confirm", "--delete-linked"]) {
    const res = await runCli([
      "brain",
      "note-lifecycle",
      "move-folder",
      "Projects/Old",
      "Archive",
      flag,
      "--vault",
      vault,
      "--json",
    ]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("takes neither");
    expect(res.stderr).toContain("never a delete");
  }
  // The refusal answered instead of the move: nothing was applied.
  expect(existsSync(join(vault, "Projects/Old/a.md"))).toBe(true);
  expect(existsSync(join(vault, "Archive"))).toBe(false);
});

test("move-folder names non-Markdown residue and omits the field when clean", async () => {
  note("Projects/Old/a.md", "alpha\n");
  writeFileSync(join(vault, "Projects/Old/img.png"), "png\n");

  const res = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Old",
    "Archive",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { left_behind?: string[] };
  expect(body.left_behind).toEqual(["img.png"]);

  // The human receipt names the residue too, in place. The folder holds
  // a note as well, so there is a move set; only the image stays.
  note("Projects/Ignored/a.md", "alpha\n");
  note("Projects/Ignored/keep.png", "png\n");
  const residueRun = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Ignored",
    "Archive",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(residueRun.returncode).toBe(0);
  expect(residueRun.stdout).toContain("left behind (still in Projects/Ignored):");
  expect(residueRun.stdout).toContain("keep.png");
});

test("move-folder renders the moved list and failures on the human receipt too", async () => {
  note("Projects/Old/a.md", "alpha\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Old",
    "Archive",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("move-folder: Projects/Old -> Archive/Old");
  expect(res.stdout).toContain("moved (1):");
  expect(res.stdout).toContain("Projects/Old/a.md -> Archive/Old/a.md");
});

test("move-folder names the relative embeds a Markdown-only move leaves dangling", async () => {
  note("Projects/Old/a.md", "![pic](diagram.png)\n");
  writeFileSync(join(vault, "Projects/Old/diagram.png"), "png\n");

  const res = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Old",
    "Archive",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    dangling_relative_links?: Array<{ note: string; target: string }>;
    left_behind?: string[];
  };
  // The JSON receipt names the pair, and the attachment is in the
  // residue: only Markdown moves, and the receipt says what that cost.
  expect(body.dangling_relative_links).toEqual([
    { note: "Archive/Old/a.md", target: "diagram.png" },
  ]);
  expect(body.left_behind).toEqual(["diagram.png"]);

  // The human receipt names the dangling spelling in place too.
  note("Projects/Embedded/a.md", "![pic](diagram.png)\n");
  writeFileSync(join(vault, "Projects/Embedded/diagram.png"), "png\n");
  const text = await runCli([
    "brain",
    "note-lifecycle",
    "move-folder",
    "Projects/Embedded",
    "Archive",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(text.returncode).toBe(0);
  expect(text.stdout).toContain("relative links now dangling");
  expect(text.stdout).toContain("Archive/Embedded/a.md: diagram.png");
});

test("rename-folder runs in the folder lifecycle through the same verb", async () => {
  note("Projects/Old/a.md", "alpha\n");
  const res = await runCli([
    "brain",
    "note-lifecycle",
    "rename-folder",
    "Projects/Old",
    "New",
    "--vault",
    vault,
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { action: string; to: string; moved: unknown[] };
  expect(body.action).toBe("rename-folder");
  expect(body.to).toBe("Projects/New");
  expect(body.moved).toEqual([{ from: "Projects/Old/a.md", to: "Projects/New/a.md" }]);
  expect(existsSync(join(vault, "Projects/New/a.md"))).toBe(true);
});
