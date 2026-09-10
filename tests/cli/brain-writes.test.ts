/**
 * `o2b brain writes` (who-wrote-what, Task A / t_662f4e82).
 *
 * The operator surface over the note-write record: the default listing,
 * the filters, and the image prune with its dry run - which is the one
 * place a wrong verb in the output would cost real bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { recordNoteWrite, storeBeforeImage } from "../../src/core/brain/notes/write-record.ts";
import { writeImagePath } from "../../src/core/brain/paths.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-writes-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function seedWrite(opts: {
  readonly timestamp: string;
  readonly agent: string;
  readonly target: string;
  readonly op: string;
  readonly deviceId?: string;
}): void {
  appendLogEvent(
    vault,
    {
      timestamp: opts.timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent: opts.agent,
      body: {
        write_id: `nw_${opts.timestamp.replace(/\D/g, "")}_${"0".repeat(16)}`,
        op: opts.op,
        target: opts.target,
        hash_before: "a".repeat(64),
        hash_after: "b".repeat(64),
        bytes_before: "10",
        bytes_after: "20",
        agent: opts.agent,
      },
    },
    { deviceId: opts.deviceId ?? "" },
  );
}

describe("o2b brain writes", () => {
  test("lists every recorded write newest first, with no subcommand typed", async () => {
    seedWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "claude", target: "A.md", op: "create" });
    seedWrite({ timestamp: "2026-03-04T02:00:00Z", agent: "codex", target: "B.md", op: "update" });

    const res = await runCli(["brain", "writes"], { env: env() });
    expect(res.returncode).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toContain("B.md");
    expect(lines[1]).toContain("A.md");
    // Every column of the row: when, what, who, where, and both digests.
    expect(lines[0]).toContain("2026-03-04T02:00:00Z");
    expect(lines[0]).toContain("update");
    expect(lines[0]).toContain("codex");
    expect(lines[0]).toContain("aaaaaaaa -> bbbbbbbb");
  });

  test("a legacy un-sharded log prints an absent device, not an invented one", async () => {
    seedWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "claude", target: "A.md", op: "create" });
    const res = await runCli(["brain", "writes", "list"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain(" - ");
  });

  test("--json carries the full record, the count and the device", async () => {
    seedWrite({
      timestamp: "2026-03-04T01:00:00Z",
      agent: "claude",
      target: "A.md",
      op: "append",
      deviceId: "laptop",
    });
    const res = await runCli(["brain", "writes", "--json"], { env: env() });
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      count: number;
      writes: Array<Record<string, unknown>>;
    };
    expect(payload.count).toBe(1);
    expect(payload.writes[0]).toMatchObject({
      op: "append",
      target: "A.md",
      agent: "claude",
      device: "laptop",
      bytes_before: 10,
      bytes_after: 20,
    });
  });

  test("filters by agent, path and op", async () => {
    seedWrite({ timestamp: "2026-03-04T01:00:00Z", agent: "claude", target: "A.md", op: "create" });
    seedWrite({ timestamp: "2026-03-04T02:00:00Z", agent: "codex", target: "B.md", op: "update" });

    const byAgent = await runCli(["brain", "writes", "--agent", "codex"], { env: env() });
    expect(byAgent.stdout).toContain("B.md");
    expect(byAgent.stdout).not.toContain("A.md");

    const byPath = await runCli(["brain", "writes", "--path", "A.md"], { env: env() });
    expect(byPath.stdout).toContain("A.md");
    expect(byPath.stdout).not.toContain("B.md");

    const byOp = await runCli(["brain", "writes", "--op", "create"], { env: env() });
    expect(byOp.stdout).toContain("A.md");
    expect(byOp.stdout).not.toContain("B.md");
  });

  test("an empty history says so rather than printing nothing", async () => {
    const res = await runCli(["brain", "writes"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("no recorded note writes");
  });

  test("an unknown --op is refused by name and lists the vocabulary", async () => {
    const res = await runCli(["brain", "writes", "--op", "delete"], { env: env() });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--op must be one of create|update|append|revert");
  });

  test("an unknown subcommand names the three that exist", async () => {
    const res = await runCli(["brain", "writes", "purge"], { env: env() });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("expected list, revert or prune-images");
  });
});

describe("o2b brain writes prune-images", () => {
  test("--dry-run lists what would go and removes nothing", async () => {
    const image = storeBeforeImage(vault, "prior bytes");
    const res = await runCli(
      ["brain", "writes", "prune-images", "--older-than-days", "0", "--dry-run"],
      { env: env() },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("would remove 1");
    expect(res.stdout).toContain(image.sha256);
    expect(existsSync(writeImagePath(vault, image.sha256))).toBe(true);
  });

  test("--older-than-days 0 removes them", async () => {
    const image = storeBeforeImage(vault, "prior bytes");
    const res = await runCli(["brain", "writes", "prune-images", "--older-than-days", "0"], {
      env: env(),
    });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("removed 1");
    expect(existsSync(writeImagePath(vault, image.sha256))).toBe(false);
  });

  test("the default window keeps a fresh image, and --json reports it", async () => {
    storeBeforeImage(vault, "prior bytes");
    const res = await runCli(["brain", "writes", "prune-images", "--json"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      removed: [],
      removed_count: 0,
      kept: 1,
      dry_run: false,
      older_than_days: 30,
    });
  });

  test("a negative window is refused by name before anything is read", async () => {
    const res = await runCli(["brain", "writes", "prune-images", "--older-than-days", "-1"], {
      env: env(),
    });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("--older-than-days must be a non-negative integer");
  });

  test("a name the store did not write is named, not removed and not fatal", async () => {
    const image = storeBeforeImage(vault, "prior bytes");
    const stray = join(dirname(writeImagePath(vault, image.sha256)), "readme.txt");
    writeFileSync(stray, "not an image", "utf8");

    const res = await runCli(["brain", "writes", "prune-images", "--older-than-days", "0"], {
      env: env(),
    });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("removed 1");
    expect(res.stdout).toContain("skipped 1 name(s) that are not before-images");
    expect(res.stdout).toContain("readme.txt");
    expect(existsSync(writeImagePath(vault, image.sha256))).toBe(false);
    expect(existsSync(stray)).toBe(true);
  });
});

describe("o2b brain writes revert", () => {
  /** Do what the write seams do, so the plan reads a real history. */
  function seedNote(opts: {
    readonly target: string;
    readonly bytes: string;
    readonly agent: string;
    readonly at: string;
  }): void {
    const abs = join(vault, opts.target);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    mkdirSync(dirname(abs), { recursive: true });
    if (before !== null) storeBeforeImage(vault, before);
    writeFileSync(abs, opts.bytes);
    recordNoteWrite(vault, {
      op: before === null ? "create" : "update",
      target: opts.target,
      before: before === null ? null : { bytes: before },
      after: { bytes: opts.bytes },
      timestamp: opts.at,
      agent: opts.agent,
    });
  }

  const TARGET = "notes/A.md";

  function seedTwoUpdatesByA(): void {
    seedNote({ target: TARGET, bytes: "v0", agent: "seed", at: "2026-03-04T01:00:00Z" });
    seedNote({ target: TARGET, bytes: "v1", agent: "claude", at: "2026-03-04T02:00:00Z" });
    seedNote({ target: TARGET, bytes: "v2", agent: "claude", at: "2026-03-04T03:00:00Z" });
  }

  test("prints the plan, the digest and the exact --apply invocation", async () => {
    seedTwoUpdatesByA();
    const res = await runCli(["brain", "writes", "revert", "--agent", "claude"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain(TARGET);
    expect(res.stdout).toContain("restore");
    expect(res.stdout).toMatch(/digest: [0-9a-f]{64}/);
    const digest = res.stdout
      .split("\n")
      .find((l) => l.startsWith("digest:"))!
      .slice("digest:".length)
      .trim();
    expect(res.stdout).toContain(`o2b brain writes revert --agent claude --apply ${digest}`);
    // A plan is a report: nothing moved.
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe("v2");
  });

  test("a selector naming nobody and nothing is refused, and exits 1", async () => {
    const res = await runCli(["brain", "writes", "revert", "--since", "2026-03-04"], {
      env: env(),
    });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("unbounded_selector");
  });

  test("a plan that refuses every target is a report, not a failure", async () => {
    seedTwoUpdatesByA();
    writeFileSync(join(vault, TARGET), "drifted");
    const res = await runCli(["brain", "writes", "revert", "--agent", "claude"], { env: env() });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("drift");
  });

  test("--apply restores the bytes and names the snapshot it took", async () => {
    seedTwoUpdatesByA();
    const plan = await runCli(["brain", "writes", "revert", "--agent", "claude", "--json"], {
      env: env(),
    });
    const digest = (JSON.parse(plan.stdout) as { digest: string }).digest;

    const res = await runCli(
      ["brain", "writes", "revert", "--agent", "claude", "--apply", digest],
      { env: env() },
    );
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("note-revert-");
    expect(res.stdout).toContain(`restore  ${TARGET}`);
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe("v0");
  });

  test("a stale digest is refused by name and exits 1", async () => {
    seedTwoUpdatesByA();
    const res = await runCli(
      ["brain", "writes", "revert", "--agent", "claude", "--apply", "f".repeat(64)],
      { env: env() },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("digest_mismatch");
    expect(readFileSync(join(vault, TARGET), "utf8")).toBe("v2");
  });

  test("a plan with nothing to apply is refused by name and exits 1", async () => {
    seedTwoUpdatesByA();
    writeFileSync(join(vault, TARGET), "drifted");
    const plan = await runCli(["brain", "writes", "revert", "--agent", "claude", "--json"], {
      env: env(),
    });
    const digest = (JSON.parse(plan.stdout) as { digest: string }).digest;
    const res = await runCli(
      ["brain", "writes", "revert", "--agent", "claude", "--apply", digest],
      { env: env() },
    );
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("nothing_to_apply");
  });

  test("--json carries the entries and the digest", async () => {
    seedTwoUpdatesByA();
    const res = await runCli(["brain", "writes", "revert", "--path", TARGET, "--json"], {
      env: env(),
    });
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      digest: string;
      entries: ReadonlyArray<Record<string, unknown>>;
      selector: Record<string, unknown>;
    };
    expect(payload.selector).toEqual({ path: TARGET });
    expect(payload.entries).toHaveLength(1);
    // A path with no agent selects EVERY write on that note, including
    // the one that created it, so undoing them all removes the note.
    expect(payload.entries[0]!["action"]).toBe("delete");
  });
});
