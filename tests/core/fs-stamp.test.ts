/**
 * The racily clean rule of `fs-stamp.ts` in the shape of a key: a stamp
 * too recent to vouch for a file's bytes is unique to its call, also
 * across processes, since some caches keep their keys on disk.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RACY_WINDOW_MS, stampKey } from "../../src/core/fs-stamp.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "o2b-fs-stamp-"));
  path = join(dir, "f.txt");
  writeFileSync(path, "abc");
});
afterEach(() => {
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

describe("stampKey", () => {
  test("a settled stamp gives the same key every time", () => {
    setSystemTime(new Date(Date.now() + RACY_WINDOW_MS + 1_000));
    const at = Date.now();
    const stat = statSync(path, { bigint: true });
    expect(stampKey(stat, at)).toBe(stampKey(statSync(path, { bigint: true }), Date.now()));
  });

  test("a stamp too recent to vouch for the bytes matches no other key", () => {
    const at = Date.now();
    const stat = statSync(path, { bigint: true });
    expect(stampKey(stat, at)).not.toBe(stampKey(stat, at));
  });

  test("another process never takes the racy key this one took", () => {
    // A persisted key (the transition watermark) is compared by a later
    // process; a per-process counter would give both the same first key.
    const script = `import { statSync } from "node:fs";
import { stampKey } from ${JSON.stringify(join(import.meta.dir, "../../src/core/fs-stamp.ts"))};
const at = Date.now();
process.stdout.write(stampKey(statSync(${JSON.stringify(path)}, { bigint: true }), at));`;
    const run = () => {
      const out = Bun.spawnSync([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(out.exitCode).toBe(0);
      return out.stdout.toString();
    };
    const [first, second] = [run(), run()];
    expect(first).toContain(":racy-");
    expect(first).not.toBe(second);
  });
});
