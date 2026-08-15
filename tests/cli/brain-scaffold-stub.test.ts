/**
 * `o2b brain scaffold-stub <list|write>` CLI surface (B3).
 *
 * The defect: an operator holding a doctor report full of
 * `broken-backlinks` findings had no verb that turned one into a note.
 * This file covers the CLI's own share - the two sub-actions, the exit
 * codes, and that the listing prints the index REFUSAL rather than an
 * empty list when the index cannot be believed, because a shell reading
 * "0 dangling targets" from an unbuilt index is exactly the misleading
 * success this release removes.
 *
 * Deliberately NOT covered here: the stub's contents and the fail-closed
 * target resolution (the core test owns those), and the tool schema (the
 * MCP test owns that).
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-scaffold-stub-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
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

test("list reports the index refusal, not an empty list", async () => {
  note("Projects/A.md", "[[Projects/Ghost]]\n");
  const res = await runCli(["brain", "scaffold-stub", "list", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    state: string;
    targets: unknown[];
    next_command: string;
  };
  expect(body.state).toBe("index_missing");
  expect(body.targets).toEqual([]);
  expect(body.next_command.length).toBeGreaterThan(0);
});

test("write without --apply plans and materialises nothing", async () => {
  note("Projects/A.md", "[[Projects/Ghost]]\n");
  const res = await runCli([
    "brain",
    "scaffold-stub",
    "write",
    "Projects/Ghost",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { applied: boolean; path: string };
  expect(body.applied).toBe(false);
  expect(body.path).toBe("Projects/Ghost.md");
  expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(false);
});

test("write --apply materialises a real note with real frontmatter", async () => {
  note("Projects/A.md", "[[Projects/Ghost]]\n");
  const res = await runCli([
    "brain",
    "scaffold-stub",
    "write",
    "Projects/Ghost",
    "--vault",
    vault,
    "--source",
    "Projects/A.md",
    "--apply",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  expect((JSON.parse(res.stdout) as { outcome: string }).outcome).toBe("created");
  expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(true);
});

test("a target that already resolves exits non-zero and says so", async () => {
  note("Projects/Real.md", "x\n");
  const res = await runCli([
    "brain",
    "scaffold-stub",
    "write",
    "Projects/Real",
    "--vault",
    vault,
    "--apply",
  ]);
  expect(res.returncode).not.toBe(0);
  expect(res.stderr).toContain("resolves");
});

test("an unknown sub-action is a usage error, not a fallback", async () => {
  const res = await runCli(["brain", "scaffold-stub", "invent", "--vault", vault]);
  expect(res.returncode).toBe(2);
});
