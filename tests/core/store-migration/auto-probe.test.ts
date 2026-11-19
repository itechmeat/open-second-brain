/**
 * The other-device migration mark (change auto-store-migration, design
 * D7): the synced Brain log shows that another device started migrating
 * this vault. The probe reads a fixed amount per start however many years
 * of log shards the vault holds: per other device, only its newest
 * {@link MARK_SHARDS_PER_DEVICE} shards, and of each only the last
 * {@link MARK_TAIL_BYTES}. A migrating device writes no legacy log line
 * after its switch, so its mark sits at the end of its newest shard; a
 * device that went on writing legacy shards on later days (its migration
 * did not switch it, or it was rolled back) no longer counts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MARK_SHARDS_PER_DEVICE,
  MARK_TAIL_BYTES,
  otherDeviceMigrationMark,
} from "../../../src/core/store-migration/auto-probe.ts";

let root: string;
let vault: string;
let logDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-auto-probe-"));
  vault = join(root, "vault");
  logDir = join(vault, "Brain", "log");
  mkdirSync(logDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MARK = (runId: string): string =>
  JSON.stringify({
    ts: "2026-11-17T10:00:00Z",
    kind: "snapshot",
    payload: { run_id: runId, reason: "store-migration" },
  });

const NOTE = JSON.stringify({ ts: "2026-11-17T10:00:00Z", kind: "note", payload: { t: "x" } });

/** The shard date of day `n` after 2020-01-01. */
function day(n: number): string {
  return new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
}

function shard(n: number, device: string, lines: ReadonlyArray<string>): void {
  writeFileSync(join(logDir, `${day(n)}.${device}.jsonl`), lines.join("\n") + "\n");
}

/** The mark the scan found; the scan must have completed. */
function markOf(at: string) {
  const scan = otherDeviceMigrationMark(at, "dev-a");
  expect(scan.incomplete).toBeNull();
  return scan.mark;
}

describe("the other-device mark", () => {
  test("is found at the end of a device's newest shard among years of shards", () => {
    for (let n = 0; n < 1500; n++) shard(n, "dev-old", [NOTE]);
    for (let n = 0; n < 1200; n++) shard(n, "dev-z", [NOTE]);
    shard(1200, "dev-z", [NOTE, NOTE, MARK("store-migration-z")]);
    expect(markOf(vault)).toEqual({
      device: "dev-z",
      runId: "store-migration-z",
    });
  });

  test("is found in the newest shards of its device, not further back", () => {
    shard(10, "dev-z", [MARK("store-migration-z")]);
    for (let n = 1; n < MARK_SHARDS_PER_DEVICE; n++) shard(10 + n, "dev-z", [NOTE]);
    expect(markOf(vault)?.device).toBe("dev-z");
    // The device wrote legacy log lines on one more later day: the mark no
    // longer counts (its migration did not switch it, or it rolled back).
    shard(10 + MARK_SHARDS_PER_DEVICE, "dev-z", [NOTE]);
    expect(markOf(vault)).toBeNull();
  });

  test("is read only from the tail of a shard", () => {
    const filler = Array.from(
      { length: Math.ceil(MARK_TAIL_BYTES / NOTE.length) + 10 },
      () => NOTE,
    );
    shard(5, "dev-z", [MARK("early"), ...filler]);
    expect(markOf(vault)).toBeNull();
    shard(5, "dev-z", [...filler, MARK("late")]);
    expect(markOf(vault)?.runId).toBe("late");
  });

  test("of this device itself, or in a torn line, is not a mark", () => {
    shard(1, "dev-a", [MARK("own")]);
    shard(1, "dev-z", ['{"kind":"snapshot","payload":{"reason":"store-migration"', NOTE]);
    expect(markOf(vault)).toBeNull();
  });
});

describe("a scan that could not read everything", () => {
  test("a shard that cannot be opened makes the scan incomplete, not markless", () => {
    shard(1, "dev-z", [NOTE]);
    const real = fs.openSync;
    const refused = spyOn(fs, "openSync").mockImplementation(((
      path: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode | null,
    ) => {
      if (String(path).includes("dev-z")) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      return real(path, flags ?? "r", mode);
    }) as typeof fs.openSync);
    try {
      const scan = otherDeviceMigrationMark(vault, "dev-a");
      expect(scan.mark).toBeNull();
      expect(scan.incomplete).toContain("EBUSY");
    } finally {
      refused.mockRestore();
    }
    expect(markOf(vault)).toBeNull();
  });

  test("a log folder that cannot be listed makes the scan incomplete", () => {
    const refused = spyOn(fs, "readdirSync").mockImplementation((() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }) as unknown as typeof fs.readdirSync);
    try {
      expect(otherDeviceMigrationMark(vault, "dev-a").incomplete).toContain("EACCES");
    } finally {
      refused.mockRestore();
    }
  });
});

describe("the tail window", () => {
  test("keeps a complete mark that starts exactly where the window starts", () => {
    const mark = MARK("edge");
    // The window's first byte is the mark's first byte.
    const after = `${mark}\n`;
    const pad = MARK_TAIL_BYTES - after.length - 1;
    const padLine = JSON.stringify({
      ts: "2026-11-17T10:00:00Z",
      kind: "note",
      payload: { t: "" },
    });
    const fill = padLine.replace('"t":""', `"t":"${"x".repeat(pad - padLine.length)}"`);
    expect(Buffer.byteLength(after + fill + "\n")).toBe(MARK_TAIL_BYTES);
    writeFileSync(join(logDir, `${day(3)}.dev-z.jsonl`), `${NOTE}\n${after}${fill}\n`);
    expect(markOf(vault)?.runId).toBe("edge");
  });
});

/** A note line of exactly `bytes` bytes. */
function padTo(bytes: number): string {
  const line = JSON.stringify({ ts: "2026-11-17T10:00:00Z", kind: "note", payload: { t: "" } });
  return line.replace('"t":""', `"t":"${"x".repeat(bytes - line.length)}"`);
}

describe("the tail read", () => {
  test("reads a mark the window starts inside back to its start", () => {
    // The mark begins 40 bytes before the window: the window cuts it.
    const mark = MARK("cut");
    const tailAfterMark = padTo(MARK_TAIL_BYTES - (mark.length - 40) - 2);
    const text = `${NOTE}\n${mark}\n${tailAfterMark}\n`;
    expect(Buffer.byteLength(`${mark}\n${tailAfterMark}\n`) - MARK_TAIL_BYTES).toBe(40);
    writeFileSync(join(logDir, `${day(3)}.dev-z.jsonl`), text);
    expect(markOf(vault)?.runId).toBe("cut");
  });

  test("a line too long to read back to its start makes the scan incomplete", () => {
    // One line from the file's start runs far past the window's first byte.
    const long = padTo(MARK_TAIL_BYTES + 200 * 1024);
    writeFileSync(join(logDir, `${day(3)}.dev-z.jsonl`), `${long}\n${NOTE}\n`);
    const scan = otherDeviceMigrationMark(vault, "dev-a");
    expect(scan.mark).toBeNull();
    expect(scan.incomplete).toContain("too long");
  });

  test("a last line sync is still writing makes the scan incomplete", () => {
    const mark = MARK("torn");
    writeFileSync(join(logDir, `${day(3)}.dev-z.jsonl`), `${NOTE}\n${mark.slice(0, 40)}`);
    const scan = otherDeviceMigrationMark(vault, "dev-a");
    expect(scan.mark).toBeNull();
    expect(scan.incomplete).toContain("still writing");
  });

  test("a read that comes back short makes the scan incomplete", () => {
    shard(3, "dev-z", [NOTE, NOTE, MARK("late")]);
    const real = fs.readSync;
    const short = spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: fs.ReadPosition | null,
    ) => {
      // The shard shrank under the read: half of it, then the end.
      const half = Math.floor(length / 2);
      const got = real(fd, buffer, offset, Math.min(half, length), position);
      return got === length ? got : offset === 0 ? got : 0;
    }) as typeof fs.readSync);
    try {
      const scan = otherDeviceMigrationMark(vault, "dev-a");
      expect(scan.mark).toBeNull();
      expect(scan.incomplete).toContain("dev-z");
    } finally {
      short.mockRestore();
    }
    expect(markOf(vault)?.runId).toBe("late");
  });
});
