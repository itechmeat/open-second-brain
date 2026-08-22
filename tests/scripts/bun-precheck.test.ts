/**
 * Tests for `scripts/_bun-precheck.sh`.
 *
 * The precheck is sourced by `scripts/o2b` and `scripts/vault-log`; it is
 * exercised here in isolation by sourcing it from a one-liner shell with a
 * fully controlled PATH and HOME. A Hermes gateway spawns its plugins with a
 * minimal inherited PATH, which is the environment reproduced below: Bun is
 * installed at the standard location and simply not on the search path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRECHECK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "_bun-precheck.sh",
);

const tmps: string[] = [];
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "o2b-precheck-"));
  tmps.push(home);
  return home;
}

/** Plant an executable `bun` stub reporting `version` at `<home>/.bun/bin`. */
function plantBun(home: string, version: string): void {
  const bin = join(home, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "bun");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${version}"\n`);
  chmodSync(stub, 0o755);
}

async function runPrecheck(home: string): Promise<{ code: number; stderr: string }> {
  // PATH deliberately excludes every directory a Bun install could live in.
  const proc = Bun.spawn(["bash", "-c", `. "${PRECHECK}"; echo PRECHECK_PASSED`], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

afterEach(() => {
  while (tmps.length) {
    try {
      rmSync(tmps.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("_bun-precheck.sh PATH repair", () => {
  test("adopts ~/.bun/bin when a minimal PATH hides an installed Bun", async () => {
    const home = freshHome();
    plantBun(home, "1.4.0");
    const { code, stderr } = await runPrecheck(home);
    expect(code).toBe(0);
    expect(stderr).not.toContain("'bun' is not on PATH");
  });

  test("still refuses with 127 when no Bun exists anywhere", async () => {
    const home = freshHome();
    const { code, stderr } = await runPrecheck(home);
    expect(code).toBe(127);
    expect(stderr).toContain("'bun' is not on PATH");
  });

  test("the adopted Bun is still version-checked", async () => {
    const home = freshHome();
    plantBun(home, "1.0.9");
    const { code, stderr } = await runPrecheck(home);
    expect(code).toBe(1);
    expect(stderr).toContain("is older than the required");
  });
});
