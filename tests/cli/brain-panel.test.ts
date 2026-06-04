/**
 * `o2b brain panel` CLI surface (Agent Write Contract Suite,
 * t_0cc6fdff).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-panel-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function submitText(sessionId: string, text: string) {
  const file = join(tmp, "step.md");
  writeFileSync(file, text);
  const res = await runCli([
    "brain",
    "panel",
    "submit",
    sessionId,
    "--file",
    file,
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  return JSON.parse(res.stdout) as { status: string; step: string; target_path: string };
}

test("panel open walks personas to a committed decision note", async () => {
  const opened = await runCli([
    "brain",
    "panel",
    "open",
    "Should we ship feature X",
    "--personas",
    "technical,risk",
    "--vault",
    vault,
    "--json",
  ]);
  expect(opened.returncode).toBe(0);
  const env = JSON.parse(opened.stdout) as { session_id: string; step: string; prompt: string };
  expect(env.step).toBe("persona:technical");
  expect(env.prompt).toContain("Should we ship feature X");

  let next = await submitText(env.session_id, "Feasible.");
  expect(next.step).toBe("persona:risk");
  next = await submitText(env.session_id, "Acceptable risk.");
  expect(next.step).toBe("synthesis");
  next = await submitText(env.session_id, "Ship it.");
  expect(next.status).toBe("done");

  const note = readFileSync(join(vault, next.target_path), "utf8");
  expect(note).toContain("kind: decision-panel");
  expect(note).toContain("## Synthesis");
});

test("panel status reports the live envelope", async () => {
  const opened = await runCli(["brain", "panel", "open", "Topic", "--vault", vault, "--json"]);
  const env = JSON.parse(opened.stdout) as { session_id: string };
  const status = await runCli([
    "brain",
    "panel",
    "status",
    env.session_id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(status.returncode).toBe(0);
  expect(JSON.parse(status.stdout).kind).toBe("panel");
});

test("panel open without a topic exits 2", async () => {
  const res = await runCli(["brain", "panel", "open", "--vault", vault]);
  expect(res.returncode).toBe(2);
});
