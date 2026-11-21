/**
 * The pieces of the stall evidence `spawnWithLimit` gathers at its limit
 * (`stall-probe.ts`, `windows-process-probe.ts`) that can be checked on
 * any platform: the disk probe and the descendant tree.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diskProbeLines } from "./stall-probe.ts";
import { descendantsOf, formatDescendants } from "./windows-process-probe.ts";

const scratch = mkdtempSync(join(tmpdir(), "o2b-stall-probe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("diskProbeLines", () => {
  test("a folder that answers gets its write-and-flush time, and the probe file is gone", async () => {
    const lines = await diskProbeLines([scratch], 2_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^disk at the limit \\(.+\\): write and flush \\d+ ms$`));
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a folder that cannot be written says why, and one folder is probed once", async () => {
    const missing = join(scratch, "missing");
    const lines = await diskProbeLines([missing, missing], 2_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`disk at the limit (${missing}): failed: `);
  });
});

describe("descendantsOf", () => {
  const rows = [
    { pid: 10, ppid: 1, name: "bun.exe", commandLine: "bun test" },
    { pid: 20, ppid: 10, name: "bun.exe", commandLine: "bun run main.ts" },
    { pid: 30, ppid: 20, name: "bun.exe", commandLine: "bun run main.ts reindex" },
    { pid: 31, ppid: 30, name: "git.exe", commandLine: "git status" },
    { pid: 40, ppid: 10, name: "powershell.exe", commandLine: "powershell -NoProfile" },
  ];

  test("every process below the root, depth first, and nothing beside it", () => {
    expect(descendantsOf(20, rows).map((r) => r.pid)).toEqual([30, 31]);
    expect(descendantsOf(31, rows)).toEqual([]);
  });

  test("a parent id that loops back is walked once", () => {
    const loop = [
      { pid: 5, ppid: 6, name: "a", commandLine: "" },
      { pid: 6, ppid: 5, name: "b", commandLine: "" },
    ];
    expect(descendantsOf(5, loop).map((r) => r.pid)).toEqual([6]);
  });

  test("the lines name each descendant and the pipes they may hold", () => {
    expect(formatDescendants(20, rows, 120)).toBe(
      [
        "descendants at the limit (Win32_Process, 120 ms): 2, any of them may hold the child's stdout and stderr",
        "  pid 30 (parent 20) bun.exe: bun run main.ts reindex",
        "  pid 31 (parent 30) git.exe: git status",
      ].join("\n"),
    );
    expect(formatDescendants(31, rows, 80)).toBe(
      "descendants at the limit (Win32_Process, 80 ms): none found in this snapshot",
    );
  });

  test("a grandchild whose parent exited is not found, so an empty list clears no one of the pipes", () => {
    // Windows keeps a ParentProcessId that names a process that has gone:
    // 31 still runs, but nothing links it back to 20 once 30 has exited.
    const orphaned = rows.filter((r) => r.pid !== 30);
    expect(descendantsOf(20, orphaned)).toEqual([]);
    const line = formatDescendants(20, orphaned, 95);
    expect(line).toBe(
      "descendants at the limit (Win32_Process, 95 ms): none found in this snapshot",
    );
    expect(line).not.toContain("pipes");
  });
});
