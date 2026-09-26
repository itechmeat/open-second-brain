/**
 * `o2b brain payload get|list|gc` (payload registry, t_35440e83).
 *
 * The operator surface over `Brain/.payloads/`: a paged read that returns
 * the exact stored bytes, a listing that separates live, orphaned and
 * missing payloads, and a gc whose default is a dry run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { payloadPath, payloadsDir } from "../../src/core/brain/paths.ts";
import { PAYLOAD_GC_GRACE_MS, PayloadRegistry } from "../../src/core/brain/payload-registry.ts";
import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

const BLOB = "QUJD".repeat(500);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-payload-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/** Import one turn carrying a blob; return the ref it was stored under. */
function importBlob(): string {
  importSessionRecall(vault, {
    sessionId: "cli-session",
    createdAt: "2026-09-20T10:00:00.000Z",
    turns: [{ turnId: "t1", role: "user", timestamp: "2026-09-20T10:00:01.000Z", text: BLOB }],
  });
  const [name] = readdirSync(payloadsDir(vault));
  return `osb-payload://${name!.replace(/\.txt$/, "")}`;
}

describe("o2b brain payload get", () => {
  test("pages the exact bytes with --offset/--limit and writes them raw without --json", async () => {
    const ref = importBlob();
    const first = await runCli(
      ["brain", "payload", "get", ref, "--offset", "0", "--limit", "1500", "--json"],
      { env: env() },
    );
    expect(first.returncode).toBe(0);
    const page = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(page["total_chars"]).toBe(BLOB.length);
    expect(page["next_offset"]).toBe(1500);

    const second = await runCli(["brain", "payload", "get", ref, "--offset", "1500"], {
      env: env(),
    });
    expect(second.returncode).toBe(0);
    expect(`${page["content"] as string}${second.stdout}`).toBe(BLOB);
  });

  test("refuses a traversing ref and names a missing one", async () => {
    const bad = await runCli(["brain", "payload", "get", "osb-payload://../../etc/passwd"], {
      env: env(),
    });
    expect(bad.returncode).toBe(1);
    expect(bad.stderr).toContain("invalid payload ref");

    const missing = await runCli(["brain", "payload", "get", `osb-payload://${"d".repeat(64)}`], {
      env: env(),
    });
    expect(missing.returncode).toBe(1);
    expect(missing.stderr).toContain("missing payload");
  });
});

describe("o2b brain payload list and gc", () => {
  test("list separates live, orphaned and missing; gc is a dry run until --apply", async () => {
    const live = importBlob();
    const orphan = new PayloadRegistry({ vault, maxInlineChars: 10 }).externalizeOversized(
      "QkNE".repeat(300),
    ).payloads[0]!.ref;
    const missing = `osb-payload://${"e".repeat(64)}`;
    writeFileSync(join(vault, "note.md"), `See ${missing}\n`);

    const listed = await runCli(["brain", "payload", "list", "--json"], { env: env() });
    expect(listed.returncode).toBe(0);
    const inventory = JSON.parse(listed.stdout) as {
      stored: Array<{ ref: string; orphan: boolean }>;
      missing: Array<{ ref: string; referrers: Array<{ path: string }> }>;
    };
    expect(inventory.stored.find((e) => e.ref === live)?.orphan).toBe(false);
    expect(inventory.stored.find((e) => e.ref === orphan)?.orphan).toBe(true);
    expect(inventory.missing).toEqual([{ ref: missing, referrers: [{ path: "note.md" }] }]);

    const orphanFile = payloadPath(vault, orphan.slice("osb-payload://".length));
    // A fresh orphan is inside the grace period an import needs.
    const young = await runCli(["brain", "payload", "gc", "--apply", "--json"], { env: env() });
    expect(young.returncode).toBe(0);
    expect(JSON.parse(young.stdout)).toMatchObject({ removed: [], deferred: [{ ref: orphan }] });
    expect(existsSync(orphanFile)).toBe(true);
    const aged = new Date(Date.now() - PAYLOAD_GC_GRACE_MS - 60_000);
    utimesSync(orphanFile, aged, aged);

    const dry = await runCli(["brain", "payload", "gc"], { env: env() });
    expect(dry.returncode).toBe(0);
    expect(dry.stdout).toContain("--apply");
    expect(existsSync(orphanFile)).toBe(true);

    const applied = await runCli(["brain", "payload", "gc", "--apply", "--json"], { env: env() });
    expect(applied.returncode).toBe(0);
    const result = JSON.parse(applied.stdout) as { removed: string[]; snapshot: string | null };
    expect(result.removed).toHaveLength(1);
    expect(result.snapshot).toStartWith("payload-gc-");
    expect(existsSync(orphanFile)).toBe(false);
    expect(existsSync(payloadPath(vault, live.slice("osb-payload://".length)))).toBe(true);
  });
});
