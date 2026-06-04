/**
 * `o2b brain session` CLI surface (Agent Write Contract Suite,
 * t_bc36a8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

const GOOD = "---\nkind: note\n---\n\n# Session note\n\nBody.\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-session-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function openSession(extra: string[] = []): Promise<{ session_id: string }> {
  const res = await runCli([
    "brain",
    "session",
    "open",
    "--target",
    "Brain/notes/cli.md",
    "--vault",
    vault,
    "--json",
    ...extra,
  ]);
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as { session_id: string };
}

test("open -> submit --file drives a session to done", async () => {
  const opened = await openSession();
  const artifact = join(tmp, "artifact.md");
  writeFileSync(artifact, GOOD);
  const submitted = await runCli([
    "brain",
    "session",
    "submit",
    (opened as { session_id: string }).session_id,
    "--file",
    artifact,
    "--vault",
    vault,
    "--json",
  ]);
  expect(submitted.returncode).toBe(0);
  const env = JSON.parse(submitted.stdout) as { status: string };
  expect(env.status).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "cli.md"), "utf8")).toContain("# Session note");
});

test("invalid submit exits 1 with the correction envelope on stdout", async () => {
  const opened = await openSession();
  const artifact = join(tmp, "bad.md");
  writeFileSync(artifact, "no frontmatter");
  const submitted = await runCli([
    "brain",
    "session",
    "submit",
    opened.session_id,
    "--file",
    artifact,
    "--vault",
    vault,
    "--json",
  ]);
  expect(submitted.returncode).toBe(1);
  const env = JSON.parse(submitted.stdout) as {
    status: string;
    errors: Array<{ code: string }>;
  };
  expect(env.status).toBe("needs-correction");
  expect(env.errors.map((e) => e.code)).toContain("frontmatter-missing");
});

test("status, list, abandon, and sweep round-trip", async () => {
  const opened = await openSession();
  const status = await runCli([
    "brain",
    "session",
    "status",
    opened.session_id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(status.stdout).status).toBe("needs-llm-step");

  const list = await runCli(["brain", "session", "list", "--vault", vault, "--json"]);
  expect(JSON.parse(list.stdout).sessions).toHaveLength(1);

  const abandoned = await runCli([
    "brain",
    "session",
    "abandon",
    opened.session_id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(abandoned.stdout).status).toBe("failed");

  const swept = await runCli(["brain", "session", "sweep", "--vault", vault, "--json"]);
  expect(JSON.parse(swept.stdout).removed).toBe(1);
});

test("approve commits a reviewed session", async () => {
  const opened = await openSession(["--require-review"]);
  const artifact = join(tmp, "artifact.md");
  writeFileSync(artifact, GOOD);
  const submitted = await runCli([
    "brain",
    "session",
    "submit",
    opened.session_id,
    "--file",
    artifact,
    "--vault",
    vault,
    "--json",
  ]);
  expect(JSON.parse(submitted.stdout).status).toBe("needs-review");
  const approved = await runCli([
    "brain",
    "session",
    "approve",
    opened.session_id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(approved.returncode).toBe(0);
  expect(JSON.parse(approved.stdout).status).toBe("done");
});

test("a reserved target is refused with exit 1 and structured errors", async () => {
  const res = await runCli([
    "brain",
    "session",
    "open",
    "--target",
    "Brain/preferences/pref-x.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(1);
  const body = JSON.parse(res.stdout) as { errors: Array<{ code: string }> };
  expect(body.errors.map((e) => e.code)).toContain("target-reserved");
});

test("usage errors exit 2", async () => {
  const res = await runCli(["brain", "session", "open", "--vault", vault]);
  expect(res.returncode).toBe(2);
});
