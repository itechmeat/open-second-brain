/**
 * `o2b brain capture` - the operator-facing ingress into the capture
 * contract (unit 3b / t_5e338af1).
 *
 * The defect. `writeCaptureNote` had exactly one caller, the inbound
 * Telegram bot, so a capture could only enter a vault through a chat
 * channel that most installs never configure. Everything downstream of it
 * - the staging area, the drain, `/catchup` - was reachable only through
 * that one door.
 *
 * Claims pinned here:
 *
 *  1. The verb writes a real capture note into the staging area, carrying
 *     the source, the sender and the guidance it was given.
 *  2. The body may arrive as an argument or on stdin; the two produce the
 *     same page.
 *  3. Guidance reaches the page's `## Guidance` section rather than the
 *     captured body.
 *  4. A refusal is NAMED and exits 2, on both the human and the `--json`
 *     surface - never a bare stack trace and never exit 0.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { listStagedCaptures } from "../../src/core/brain/capture/capture-note.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-capture-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  const configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("captures a body argument with its source, sender and guidance", async () => {
  const res = await runCli([
    "brain",
    "capture",
    "read the Rust async book",
    "--source",
    "cli",
    "--sender",
    "sol",
    "--guidance",
    "queue as reading, not a task",
    "--vault",
    vault,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    id: string;
    path: string;
    guidance: string | null;
    source: string;
    sender: string;
  };
  expect(body.id.startsWith("cap-")).toBe(true);
  expect(body.source).toBe("cli");
  expect(body.sender).toBe("sol");
  expect(body.guidance).toBe("queue as reading, not a task");

  const staged = listStagedCaptures(vault);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.body).toBe("read the Rust async book");
  expect(staged[0]!.guidance).toBe("queue as reading, not a task");
  // The guidance is a body section, not a frontmatter value.
  expect(readFileSync(join(vault, body.path), "utf8")).toContain("## Guidance");
  expect(existsSync(join(vault, body.path))).toBe(true);
});

test("the body may arrive on stdin instead of as an argument", async () => {
  const res = await runCli(["brain", "capture", "--source", "cli", "--vault", vault, "--json"], {
    stdin: "piped from somewhere\n",
  });
  expect(res.returncode).toBe(0);
  const staged = listStagedCaptures(vault);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.body).toBe("piped from somewhere");
});

test("an empty body is refused by name, exit 2, and writes nothing", async () => {
  const res = await runCli(["brain", "capture", "--source", "cli", "--vault", vault], {
    stdin: "   \n",
  });
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("body");
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("--json carries the refusal too, rather than printing it to stderr alone", async () => {
  const res = await runCli(["brain", "capture", "--source", "cli", "--vault", vault, "--json"], {
    stdin: "\n",
  });
  expect(res.returncode).toBe(2);
  const body = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(body.ok).toBe(false);
  expect(body.message).toContain("body");
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("blank guidance is refused rather than stored as an empty section", async () => {
  const res = await runCli([
    "brain",
    "capture",
    "text",
    "--source",
    "cli",
    "--guidance",
    "   ",
    "--vault",
    vault,
  ]);
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("guidance");
  expect(listStagedCaptures(vault)).toHaveLength(0);
});
