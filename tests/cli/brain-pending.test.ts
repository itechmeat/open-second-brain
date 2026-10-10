import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { stagePendingSignal } from "../../src/core/brain/pending.ts";
import { stageForReview } from "../../src/core/brain/pending/pending-lanes.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pending-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function stage(slug: string): string {
  const res = stagePendingSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "test-agent",
    principle: `https://${slug}.dev`,
    created_at: "2026-07-18T12:00:00Z",
    date: "2026-07-18",
    slug,
    source_type: "extracted",
    dedup_hash: `hash-${slug}`,
  });
  return res.id;
}

function inboxNames(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter((f) => f.startsWith("sig-"));
}

describe("o2b brain pending", () => {
  test("list --json reports the staged queue", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "list", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { pending: Array<{ id: string }>; total: number };
    expect(payload.total).toBe(1);
    expect(payload.pending[0]!.id).toBe(id);
  });

  test("apply moves a staged signal into the inbox", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "apply", id], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain(`applied: ${id}`);
    expect(inboxNames()).toContain(`${id}.md`);
    expect(existsSync(join(brainDirs(vault).pending, `${id}.md`))).toBe(false);
  });

  test("reject moves a staged signal to retired with a reason", async () => {
    const id = stage("fact-url");
    const out = await runCli(
      ["brain", "pending", "reject", id, "--reason", "not useful", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { status: string; reason: string };
    expect(payload.status).toBe("rejected");
    expect(payload.reason).toBe("not useful");
    expect(existsSync(join(brainDirs(vault).retired, `${id}.md`))).toBe(true);
  });

  test("apply --dry-run reports the move and leaves the queue alone", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "apply", id, "--dry-run", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { id: string; status: string; path: string };
    expect(payload.id).toBe(id);
    // A distinct status, so a JSON caller cannot read a preview as a move.
    expect(payload.status).toBe("would-apply");
    expect(payload.path.endsWith(`${id}.md`)).toBe(true);
    // Nothing moved: the staged copy is still queued and the inbox is untouched.
    expect(existsSync(join(brainDirs(vault).pending, `${id}.md`))).toBe(true);
    expect(inboxNames()).not.toContain(`${id}.md`);
  });

  test("apply of a missing id exits 2 (typed error, not a no-op)", async () => {
    const out = await runCli(["brain", "pending", "apply", "sig-2026-07-18-nope"], {
      env: env(),
    });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("pending signal not found");
  });

  test("reject without --reason is a usage error", async () => {
    const id = stage("fact-url");
    const out = await runCli(["brain", "pending", "reject", id], { env: env() });
    expect(out.returncode).not.toBe(0);
  });

  test("list on an empty queue reports nothing", async () => {
    const out = await runCli(["brain", "pending", "list"], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("no entries in any review lane");
  });
});

/**
 * The multi-lane queue (write-side trust, Task 9): list shows every lane
 * sorted with a lane column, `--lane` filters one, unreadable entries are
 * named with a reason, and both appliers preview honestly under
 * `--dry-run`.
 */
describe("o2b brain pending across lanes", () => {
  test("list shows all lanes sorted with lane columns and publish targets", async () => {
    stage("fact-url");
    stageForReview(vault, "notes", "Notes/Zed.md", () => "zed");
    stageForReview(vault, "ingest", "Brain/sources/src-a-bcdef1234567.md", () => "summary");
    const out = await runCli(["brain", "pending", "list", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      pending: Array<{ id: string; lane: string; publish_target?: string }>;
      total: number;
    };
    expect(payload.total).toBe(3);
    const ids = payload.pending.map((e) => e.id);
    expect(ids).toEqual(ids.toSorted());
    expect(payload.pending.map((e) => e.lane)).toEqual(["ingest", "notes", "signals"]);
    const note = payload.pending.find((e) => e.lane === "notes")!;
    expect(note.publish_target).toBe("Notes/Zed.md");
    const ingest = payload.pending.find((e) => e.lane === "ingest")!;
    expect(ingest.publish_target).toBe("Brain/sources/src-a-bcdef1234567.md");
  });

  test("--lane filters one lane", async () => {
    stageForReview(vault, "notes", "Notes/Only.md", () => "n");
    stageForReview(vault, "ingest", "Brain/sources/src-only-abcd12345678.md", () => "i");
    const out = await runCli(["brain", "pending", "list", "--lane", "notes", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      pending: Array<{ lane: string }>;
      unreadable: unknown[];
    };
    expect(payload.pending.map((e) => e.lane)).toEqual(["notes"]);
  });

  test("an unknown --lane value is a usage error naming the choices", async () => {
    const out = await runCli(["brain", "pending", "list", "--lane", "squid"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("signals, notes, ingest, all");
  });

  test("an unreadable queue file is listed with a reason instead of vanishing", async () => {
    stage("fact-url");
    mkdirSync(join(brainDirs(vault).pending, "notes"), { recursive: true });
    writeFileSync(join(brainDirs(vault).pending, "notes", "stray-notes.md"), "stray");
    const out = await runCli(["brain", "pending", "list", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      unreadable: Array<{ path: string; reason: string }>;
    };
    expect(payload.unreadable).toHaveLength(1);
    expect(payload.unreadable[0]!.path.endsWith("stray-notes.md")).toBe(true);
    expect(payload.unreadable[0]!.reason.length).toBeGreaterThan(0);
  });

  test("apply of a note- id publishes the decoded target", async () => {
    const staged = stageForReview(vault, "notes", "Notes/From CLI.md", () => "bytes");
    const out = await runCli(["brain", "pending", "apply", staged.pendingId, "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(existsSync(join(vault, "Notes/From CLI.md"))).toBe(true);
    expect(existsSync(staged.path)).toBe(false);
  });

  test("reject --dry-run previews the retire and writes nothing", async () => {
    const staged = stageForReview(vault, "notes", "Notes/Keep.md", () => "keep");
    const out = await runCli(
      ["brain", "pending", "reject", staged.pendingId, "--reason", "maybe", "--dry-run", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { status: string };
    expect(payload.status).toBe("would-reject");
    expect(existsSync(staged.path)).toBe(true);
    expect(existsSync(join(brainDirs(vault).retired, `${staged.pendingId}.md`))).toBe(false);
  });
});
