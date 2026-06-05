/**
 * `o2b brain attr` CLI surface (t_f5633190): per-type attribute
 * fields - assign validates against the schema pack's declared
 * descriptors (errors teach the vocabulary), remove drops one field,
 * show renders the current map.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-attr-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    [
      "schema_version: 1",
      "schema:",
      "  page_types: [paper]",
      "  attributes:",
      "    - paper.status=reading status, e.g. queued or finished",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(vault, "Brain", "notes", "paper.md"),
    "---\ntype: paper\n---\n\n# Paper\n\nbody\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("assign writes the attribute, show renders it, remove drops it", async () => {
  const assign = await runCli([
    "brain",
    "attr",
    "Brain/notes/paper.md",
    "status=queued",
    "--vault",
    vault,
    "--json",
  ]);
  expect(assign.returncode).toBe(0);
  const assigned = JSON.parse(assign.stdout) as { ok: boolean; attributes: string[] };
  expect(assigned.ok).toBe(true);
  expect(assigned.attributes).toEqual(["status=queued"]);
  expect(readFileSync(join(vault, "Brain", "notes", "paper.md"), "utf8")).toContain(
    "status=queued",
  );

  const show = await runCli([
    "brain",
    "attr",
    "Brain/notes/paper.md",
    "--show",
    "--vault",
    vault,
    "--json",
  ]);
  expect(show.returncode).toBe(0);
  expect(JSON.parse(show.stdout)).toEqual({
    ok: true,
    path: "Brain/notes/paper.md",
    attributes: { status: "queued" },
  });

  const remove = await runCli([
    "brain",
    "attr",
    "Brain/notes/paper.md",
    "--remove",
    "status",
    "--vault",
    vault,
    "--json",
  ]);
  expect(remove.returncode).toBe(0);
  const removed = JSON.parse(remove.stdout) as { removed: boolean; attributes: string[] };
  expect(removed.removed).toBe(true);
  expect(removed.attributes).toEqual([]);
});

test("an undeclared field is a usage error teaching the vocabulary", async () => {
  const result = await runCli([
    "brain",
    "attr",
    "Brain/notes/paper.md",
    "rating=5",
    "--vault",
    vault,
  ]);
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain(
    "declared fields: status (reading status, e.g. queued or finished)",
  );
});

test("missing mode or conflicting modes are usage errors", async () => {
  const none = await runCli(["brain", "attr", "Brain/notes/paper.md", "--vault", vault]);
  expect(none.returncode).toBe(2);
  const both = await runCli([
    "brain",
    "attr",
    "Brain/notes/paper.md",
    "status=queued",
    "--show",
    "--vault",
    vault,
  ]);
  expect(both.returncode).toBe(2);
});
