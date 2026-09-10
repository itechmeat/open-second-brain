/**
 * `o2b brain writes` (who-wrote-what, Task A / t_662f4e82).
 *
 * The operator surface over the note-write record: the default listing,
 * the filters, and the image prune with its dry run - which is the one
 * place a wrong verb in the output would cost real bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { storeBeforeImage } from "../../src/core/brain/notes/write-record.ts";
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

  test("an unknown subcommand names the two that exist", async () => {
    const res = await runCli(["brain", "writes", "purge"], { env: env() });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain("expected list or prune-images");
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
});
