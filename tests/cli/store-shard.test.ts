/**
 * `o2b store shard quarantine|list|release` (change store-hardening,
 * design D6; spec `store-shard-gaps`): the device-local quarantine of one
 * bad line of a shard another device owns, its listing and its release,
 * every refusal reason under `--json`, and the usage errors.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { readListedShard } from "../../src/cli/store-shard.ts";
import { brainSettingKey } from "../../src/core/store-migration/brain-settings.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import {
  SETTING_SET_KIND,
  STORE_IDENTITY_FILE,
  STORE_ROOT_ENV,
} from "../../src/core/store/constants.ts";
import { parseHlc } from "../../src/core/store/hlc.ts";
import {
  QUARANTINE_HASH_CAP_BYTES,
  SHARD_QUARANTINE_DIR,
} from "../../src/core/store/shard-quarantine.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { partitionDir, storesStateDir } from "../../src/core/store/store-paths.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";

// Every test here runs the CLI, most of them several times.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-shard-"));
  root = join(parent, "store");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function env(): Record<string, string> {
  return {
    [STORE_ROOT_ENV]: root,
    HOME: join(parent, "home"),
    XDG_STATE_HOME: join(parent, "state"),
    LOCALAPPDATA: join(parent, "state"),
    OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"),
    O2B_DEVICE_ID: "dev-a",
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const cli = (args: ReadonlyArray<string>) =>
  runCli(["store", "shard", ...args], { env: env(), stdin: "" });

async function init(partitions?: string): Promise<void> {
  const args = ["store", "init", ...(partitions === undefined ? [] : ["--partitions", partitions])];
  const r = await runCli(args, { env: env(), stdin: "" });
  expect(r.returncode).toBe(0);
}

/** Append one record as `device`, with that device's own local state, `ageMs` ago. */
function write(
  device: string,
  stream: "events" | "settings",
  body: Record<string, unknown>,
  ageMs = 0,
): string {
  const store = openStore({
    root,
    device,
    dirs: {
      platform: process.platform,
      home: join(parent, "home", device),
      env: {
        XDG_STATE_HOME: join(parent, "state", device),
        LOCALAPPDATA: join(parent, "state", device),
      },
    },
  });
  const kind = stream === "settings" ? SETTING_SET_KIND : "note";
  return appendRecord(
    store,
    { partition: "shared", stream, kind, agent: "t", body },
    { now: () => Date.now() - ageMs },
  ).path;
}

/** Three notes of `device` in one shard. */
function threeNotes(device = "dev-b"): string {
  let path = "";
  for (let n = 1; n <= 3; n += 1) path = write(device, "events", { n });
  return path;
}

const shardArg = (path: string): string =>
  `shared/${relative(partitionDir(root, "shared"), path).split("\\").join("/")}`;

function offsetOfLine(path: string, index: number): number {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

function editLine(path: string, index: number, edit: (line: string) => string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  lines[index] = edit(lines[index]!);
  writeFileSync(path, lines.join("\n"));
}

const breakLine = (line: string): string => line.replace(/"n":(\d+)/, '"n":9$1');

/** Move the shared blobs aside, so every blob body is pending. */
function hideBlobs(): void {
  renameSync(join(partitionDir(root, "shared"), "blobs"), join(parent, "blobs-aside"));
}

/** The store identity file of `partition`. */
const identity = (partition: "shared" | "private"): string =>
  join(partitionDir(root, partition), STORE_IDENTITY_FILE);

async function refusal(args: ReadonlyArray<string>): Promise<string> {
  const r = await cli([...args, "--json"]);
  expect(r.returncode).toBe(1);
  const body = JSON.parse(r.stdout) as { ok: boolean; reason: string; error: unknown };
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe("string");
  return body.reason;
}

describe("o2b store shard", () => {
  test("quarantine, already, list, release and not-quarantined", async () => {
    await init();
    const path = threeNotes();
    editLine(path, 1, breakLine);
    const shard = shardArg(path);
    const offset = String(offsetOfLine(path, 1));

    const first = await cli(["quarantine", shard, "--offset", offset, "--json"]);
    expect(first.returncode).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      ok: true,
      status: "quarantined",
      partition: "shared",
      shard: shard.slice("shared/".length),
      offset: Number(offset),
      kind: "corrupt-line",
    });

    const again = await cli(["quarantine", shard, "--offset", offset]);
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain("already quarantined");

    const listed = await cli(["list", "--json"]);
    expect(listed.returncode).toBe(0);
    const body = JSON.parse(listed.stdout) as {
      ok: boolean;
      lines: Array<Record<string, unknown>>;
    };
    expect(body.ok).toBe(true);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({
      partition: "shared",
      shard: shard.slice("shared/".length),
      offset: Number(offset),
      kind: "corrupt-line",
      state: "held",
    });
    expect(typeof body.lines[0]!["quarantined_at"]).toBe("string");
    const text = await cli(["list"]);
    expect(text.stdout).toContain(`${shard} at byte ${offset}`);

    const released = await cli(["release", shard, "--offset", offset, "--json"]);
    expect(released.returncode).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({ ok: true, status: "released" });

    const none = await cli(["release", shard, "--offset", offset]);
    expect(none.returncode).toBe(0);
    expect(none.stdout).toContain("Nothing was quarantined");
    const noneJson = await cli(["release", shard, "--offset", offset, "--json"]);
    expect(JSON.parse(noneJson.stdout)).toMatchObject({ ok: true, status: "not-quarantined" });

    const empty = await cli(["list", "--json"]);
    expect(JSON.parse(empty.stdout)).toEqual({ ok: true, lines: [] });
  }, 60_000);

  test("an old pending blob is quarantined as blob-pending", async () => {
    await init();
    // A device's clock never runs back, so the old record is its first.
    const path = write("dev-b", "events", { n: 1, text: "x".repeat(20_000) }, 8 * DAY_MS);
    write("dev-b", "events", { n: 2 });
    hideBlobs();
    const r = await cli(["quarantine", shardArg(path), "--offset", "0", "--json"]);
    expect(r.returncode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "quarantined", kind: "blob-pending" });
    // The blob arrives: the entry is resolved, and its release reopens nothing.
    renameSync(join(parent, "blobs-aside"), join(partitionDir(root, "shared"), "blobs"));
    const listed = JSON.parse((await cli(["list", "--json"])).stdout) as {
      lines: Array<{ state: string }>;
    };
    expect(listed.lines.map((l) => l.state)).toEqual(["resolved"]);
    const released = await cli(["release", shardArg(path), "--offset", "0"]);
    expect(released.returncode).toBe(0);
    expect(released.stdout).toContain("its mark is removed");
    expect(released.stdout).toContain("a gap again only if it still is one");
    expect(released.stdout).not.toContain("read only in part again");
  }, 60_000);

  test("each refusal has its own reason", async () => {
    const missing = "shared/events/dev-b/2026-11.jsonl";
    expect(await refusal(["quarantine", missing, "--offset", "0"])).toBe("no-store");
    expect(await refusal(["list"])).toBe("no-store");

    await init("shared");
    expect(
      await refusal(["quarantine", "private/events/dev-b/2026-11.jsonl", "--offset", "0"]),
    ).toBe("not-held");
    expect(
      await refusal(["quarantine", "shared/events/dev-b/1999-01.jsonl", "--offset", "0"]),
    ).toBe("unknown-shard");
    expect(await refusal(["quarantine", "shared/../store.json", "--offset", "0"])).toBe(
      "unknown-shard",
    );

    const notes = threeNotes();
    expect(
      await refusal(["quarantine", shardArg(notes), "--offset", String(offsetOfLine(notes, 1))]),
    ).toBe("no-gap");
    editLine(notes, 1, (line) => line.replace('"v":1', '"v":99'));
    expect(
      await refusal(["quarantine", shardArg(notes), "--offset", String(offsetOfLine(notes, 1))]),
    ).toBe("newer-format");

    write("dev-c", "events", { n: 1 });
    const young = write("dev-c", "events", { n: 2, text: "y".repeat(20_000) }, DAY_MS);
    // A device's clock never runs back, so the old setting is its device's
    // first record: the settings rule is then the only barrier, not its age.
    const setting = write(
      "dev-d",
      "settings",
      {
        authority: "human",
        key: brainSettingKey("dream", "candidate_threshold"),
        value: "z".repeat(20_000),
      },
      8 * DAY_MS,
    );
    const settingHlc = (
      JSON.parse(readFileSync(setting, "utf8").split("\n")[0]!) as { hlc: string }
    ).hlc;
    expect(Date.now() - parseHlc(settingHlc)!.physical).toBeGreaterThanOrEqual(7 * DAY_MS);
    // The last line of this machine's own shard: an old pending blob.
    const own = write("dev-a", "events", { n: 1, text: "o".repeat(20_000) }, 8 * DAY_MS);
    hideBlobs();
    expect(await refusal(["quarantine", shardArg(own), "--offset", "0"])).toBe("own-tail");
    expect(
      await refusal(["quarantine", shardArg(young), "--offset", String(offsetOfLine(young, 1))]),
    ).toBe("blob-too-young");
    expect(await refusal(["quarantine", shardArg(setting), "--offset", "0"])).toBe("settings-blob");
  }, 60_000);

  test("a ledger this release cannot rewrite answers ledger-unreadable and is kept", async () => {
    await init();
    const path = threeNotes();
    editLine(path, 1, breakLine);
    const shard = shardArg(path);
    const offset = String(offsetOfLine(path, 1));
    expect((await cli(["quarantine", shard, "--offset", offset])).returncode).toBe(0);
    const ledgerDir = join(
      storesStateDir({ platform: process.platform, home: join(parent, "home"), env: env() }),
      SHARD_QUARANTINE_DIR,
    );
    const files = readdirSync(ledgerDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const ledger = join(ledgerDir, files[0]!);
    const broken = JSON.stringify({ version: 2, lines: [] });
    writeFileSync(ledger, broken);
    expect(await refusal(["release", shard, "--offset", offset])).toBe("ledger-unreadable");
    expect(await refusal(["quarantine", shard, "--offset", offset])).toBe("ledger-unreadable");
    expect(readFileSync(ledger, "utf8")).toBe(broken);
  }, 60_000);

  test("a ledger lock held past the wait answers ledger-busy; the release message claims no gap", async () => {
    await init();
    const path = threeNotes();
    editLine(path, 1, breakLine);
    const shard = shardArg(path);
    const offset = String(offsetOfLine(path, 1));
    expect((await cli(["quarantine", shard, "--offset", offset])).returncode).toBe(0);
    const ledgerDir = join(
      storesStateDir({ platform: process.platform, home: join(parent, "home"), env: env() }),
      SHARD_QUARANTINE_DIR,
    );
    const ledger = join(
      ledgerDir,
      readdirSync(ledgerDir).find((f) => f.endsWith(".json"))!,
    );
    // Another process holds the ledger's lock: a fresh lock directory, far
    // from stale, and a wait budget much shorter than the stale age.
    mkdirSync(`${ledger}.lock`);
    const busy = async (args: ReadonlyArray<string>) => {
      const r = await runCli(["store", "shard", ...args, "--json"], {
        env: { ...env(), OPEN_SECOND_BRAIN_LOCK_WAIT_MS: "100" },
        stdin: "",
      });
      expect(r.returncode).toBe(1);
      return JSON.parse(r.stdout) as { ok: boolean; reason: string; error: string };
    };
    for (const verb of ["release", "quarantine"]) {
      const body = await busy([verb, shard, "--offset", offset]);
      expect(body).toMatchObject({ ok: false, reason: "ledger-busy" });
      expect(body.error).toContain("run the command again");
    }
    rmSync(`${ledger}.lock`, { recursive: true });
    const released = await cli(["release", shard, "--offset", offset]);
    expect(released.returncode).toBe(0);
    expect(released.stdout).toContain("its mark is removed");
    expect(released.stdout).toContain("a gap again only if it still is one");
    expect(released.stdout).not.toContain("read only in part again");
  }, 60_000);

  test("a shard removed between the listing and the read answers shard-changed", async () => {
    await init();
    const path = threeNotes();
    rmSync(path);
    let caught: unknown;
    try {
      readListedShard(path, partitionDir(root, "shared"), shardArg(path));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { reason?: unknown }).reason).toBe("shard-changed");
    expect((caught as Error).message).toContain("run the command again");
  });

  test.skipIf(process.platform === "win32")(
    "a shard that is a link answers shard-unreadable, not no-gap",
    async () => {
      await init();
      const path = threeNotes();
      editLine(path, 1, breakLine);
      const offset = String(offsetOfLine(path, 1));
      const moved = join(parent, "moved.jsonl");
      renameSync(path, moved);
      symlinkSync(moved, path);
      const r = await cli(["quarantine", shardArg(path), "--offset", offset, "--json"]);
      expect(r.returncode).toBe(1);
      expect((JSON.parse(r.stdout) as { reason: string }).reason).toBe("shard-unreadable");
    },
    30_000,
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a shard this account cannot read answers shard-unreadable and records nothing",
    async () => {
      await init();
      const path = threeNotes();
      editLine(path, 1, () => "{ not json");
      const offset = String(offsetOfLine(path, 1));
      chmodSync(path, 0o000);
      try {
        const r = await cli(["quarantine", shardArg(path), "--offset", offset, "--json"]);
        expect(r.returncode).toBe(1);
        const body = JSON.parse(r.stdout) as { ok: boolean; reason: string; error: string };
        expect(body.ok).toBe(false);
        expect(body.reason).toBe("shard-unreadable");
      } finally {
        chmodSync(path, 0o644);
      }
      const listed = await cli(["list", "--json"]);
      expect((JSON.parse(listed.stdout) as { lines: unknown[] }).lines).toEqual([]);
    },
    30_000,
  );

  test("a corrupt line too long to hash is refused as line-too-long, with no advice to retry", async () => {
    await init();
    const path = threeNotes();
    editLine(path, 1, () => "x".repeat(QUARANTINE_HASH_CAP_BYTES + 1));
    const r = await cli([
      "quarantine",
      shardArg(path),
      "--offset",
      String(offsetOfLine(path, 1)),
      "--json",
    ]);
    expect(r.returncode).toBe(1);
    const body = JSON.parse(r.stdout) as { reason: string; error: string };
    expect(body.reason).toBe("line-too-long");
    expect(body.error).toContain(`runs past ${QUARANTINE_HASH_CAP_BYTES} bytes`);
    expect(body.error).not.toContain("run the command again");
  });

  test("a held corrupt last line of this machine's own shard answers own-tail", async () => {
    await init();
    write("dev-a", "events", { n: 1 });
    const own = write("dev-a", "events", { n: 2 });
    editLine(own, 1, breakLine);
    expect(
      await refusal(["quarantine", shardArg(own), "--offset", String(offsetOfLine(own, 1))]),
    ).toBe("own-tail");
    // Another device's held last line is no gap yet: the reader retries it.
    const theirs = threeNotes();
    editLine(theirs, 2, breakLine);
    expect(
      await refusal(["quarantine", shardArg(theirs), "--offset", String(offsetOfLine(theirs, 2))]),
    ).toBe("no-gap");
  });

  test("a pending record whose clock stamp does not parse answers blob-clock-unreadable", async () => {
    await init();
    const path = write("dev-b", "events", { n: 1, text: "x".repeat(20_000) }, 8 * DAY_MS);
    write("dev-b", "events", { n: 2 });
    editLine(path, 0, (line) =>
      line.replace(/"hlc":"[^"]*"/, `"hlc":"${Number.MAX_SAFE_INTEGER}.0"`),
    );
    hideBlobs();
    const r = await cli(["quarantine", shardArg(path), "--offset", "0", "--json"]);
    expect(r.returncode).toBe(1);
    const body = JSON.parse(r.stdout) as { reason: string; error: string };
    expect(body.reason).toBe("blob-clock-unreadable");
    expect(body.error).toContain("clock stamp does not parse");
  });

  test("store open errors answer partition-lost or store-open-error", async () => {
    await init();
    const kept = readFileSync(identity("private"), "utf8");
    rmSync(identity("private"));
    expect(await refusal(["list"])).toBe("partition-lost");
    writeFileSync(identity("private"), kept);
    writeFileSync(identity("shared"), "not a store identity");
    expect(await refusal(["list"])).toBe("store-open-error");
  });

  test("a store root inside the vault and an unreadable config are refused", async () => {
    const vault = join(parent, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(parent, "config.yaml"), `vault: ${vault}\n`);
    const inside = await runCli(["store", "shard", "list", "--json"], {
      env: { ...env(), [STORE_ROOT_ENV]: join(vault, "store") },
      stdin: "",
    });
    expect(inside.returncode).toBe(1);
    expect(JSON.parse(inside.stdout)).toMatchObject({ ok: false, reason: "store-root-in-vault" });

    rmSync(join(parent, "config.yaml"));
    mkdirSync(join(parent, "config.yaml"));
    expect(await refusal(["list"])).toBe("config");
  });

  test("usage errors exit 2, with a JSON answer under --json", async () => {
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      [],
      ["bogus"],
      ["quarantine"],
      ["quarantine", "shared/events/dev-b/2026-11.jsonl"],
      ["quarantine", "shared/events/dev-b/2026-11.jsonl", "--offset", "x"],
      ["quarantine", "shared/events/dev-b/2026-11.jsonl", "--offset", "-1"],
      ["quarantine", "nowhere/events/dev-b/2026-11.jsonl", "--offset", "0"],
      ["quarantine", "shared", "--offset", "0"],
      ["quarantine", "shared/events/dev-b/2026-11.jsonl", "extra", "--offset", "0"],
      ["release", "shared/events/dev-b/2026-11.jsonl"],
      ["list", "extra"],
    ];
    for (const args of cases) {
      const text = await cli(args);
      expect(`${args.join(" ")}: ${text.returncode}`).toBe(`${args.join(" ")}: 2`);
      expect(text.stderr.startsWith("error: ")).toBe(true);
      expect(text.stderr).toContain("usage: o2b store shard");
      const json = await cli([...args, "--json"]);
      expect(json.returncode).toBe(2);
      const body = JSON.parse(json.stdout) as { ok: boolean; reason: string; error: unknown };
      expect(body).toMatchObject({ ok: false, reason: "usage" });
      expect(typeof body.error).toBe("string");
    }
  }, 60_000);
});
