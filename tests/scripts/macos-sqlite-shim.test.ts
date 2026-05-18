/**
 * Tests for `scripts/_macos-sqlite.sh`.
 *
 * The shim is sourced by `scripts/o2b`; we test it in isolation by
 * sourcing it from a one-liner shell and probing the resulting
 * `DYLD_LIBRARY_PATH`. Platform is faked via `O2B_MACOS_FORCE_PLATFORM`,
 * Homebrew prefixes via `O2B_MACOS_SQLITE_PREFIXES_OVERRIDE` — both
 * are intentional test seams baked into the shim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "_macos-sqlite.sh",
);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-macos-shim-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function runShim(env: Record<string, string>): Promise<string> {
  // Source the shim, then echo DYLD_LIBRARY_PATH. The shim returns 0
  // even on no-op, so we always read the echoed value (possibly empty).
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `. "${SHIM}"; echo "DYLD=\${DYLD_LIBRARY_PATH-}"`,
    ],
    {
      env: { ...env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const match = stdout.match(/^DYLD=(.*)$/m);
  return match ? match[1]! : "";
}

describe("_macos-sqlite.sh", () => {
  test("Linux platform → no DYLD_LIBRARY_PATH export", async () => {
    const out = await runShim({ O2B_MACOS_FORCE_PLATFORM: "Linux" });
    expect(out).toBe("");
  });

  test("Darwin + brew prefix present → DYLD_LIBRARY_PATH set", async () => {
    const fakePrefix = join(tmp, "homebrew-sqlite-lib");
    mkdirSync(fakePrefix, { recursive: true });
    const out = await runShim({
      O2B_MACOS_FORCE_PLATFORM: "Darwin",
      O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: fakePrefix,
    });
    expect(out).toBe(fakePrefix);
  });

  test("Darwin + DYLD_LIBRARY_PATH preset → preserved verbatim", async () => {
    const fakePrefix = join(tmp, "homebrew-sqlite-lib");
    mkdirSync(fakePrefix, { recursive: true });
    const out = await runShim({
      O2B_MACOS_FORCE_PLATFORM: "Darwin",
      O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: fakePrefix,
      DYLD_LIBRARY_PATH: "/user/configured/lib",
    });
    expect(out).toBe("/user/configured/lib");
  });

  test("Darwin + no prefix exists → no DYLD_LIBRARY_PATH export", async () => {
    const missing = join(tmp, "does-not-exist");
    const out = await runShim({
      O2B_MACOS_FORCE_PLATFORM: "Darwin",
      O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: missing,
    });
    expect(out).toBe("");
  });

  test("Darwin + first prefix exists, second too → first wins", async () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const out = await runShim({
      O2B_MACOS_FORCE_PLATFORM: "Darwin",
      O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: `${a}:${b}`,
    });
    expect(out).toBe(a);
  });

  // §31.2 — covers the `${VAR+set}` branch added during the v0.10.5
  // CR fix. A user who deliberately exports an empty
  // `DYLD_LIBRARY_PATH` (some CI pipelines do this) must keep that
  // exact value; the shim must not "helpfully" populate it.
  test("Darwin + explicit empty DYLD_LIBRARY_PATH → preserved verbatim", async () => {
    const fakePrefix = join(tmp, "homebrew-sqlite-lib");
    mkdirSync(fakePrefix, { recursive: true });
    const out = await runShim({
      O2B_MACOS_FORCE_PLATFORM: "Darwin",
      O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: fakePrefix,
      DYLD_LIBRARY_PATH: "",
    });
    expect(out).toBe("");
  });
});
