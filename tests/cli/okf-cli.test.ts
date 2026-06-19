/**
 * CLI surface for the Open Knowledge Format round-trip:
 * `o2b brain okf-export` / `okf-import`. Locks argument shape, the
 * trusted vs review staging behaviour, and exit codes; the core has its
 * own unit coverage in tests/core/brain/portability/okf.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-okf-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  const env = { OPEN_SECOND_BRAIN_CONFIG: config };
  expect((await runCli(["init", "--vault", vault, "--name", "T"], { env })).returncode).toBe(0);
  expect((await runCli(["brain", "init", "--vault", vault], { env })).returncode).toBe(0);
}

describe("o2b brain okf-export / okf-import", () => {
  test("export requires --out", async () => {
    await bootstrap();
    const r = await runCli(["brain", "okf-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });

  test("export then trusted import round-trips a user page", async () => {
    await bootstrap();
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");

    const out = join(tmp, "bundle");
    const exp = await runCli(["brain", "okf-export", "--out", out], { env });
    expect(exp.returncode).toBe(0);
    expect(existsSync(join(out, "okf.json"))).toBe(true);
    expect(existsSync(join(out, "concepts/Note.md"))).toBe(true);

    const dest = join(tmp, "dest");
    const destConfig = join(tmp, "dest-config.yaml");
    const destEnv = { OPEN_SECOND_BRAIN_CONFIG: destConfig };
    expect(
      (await runCli(["init", "--vault", dest, "--name", "D"], { env: destEnv })).returncode,
    ).toBe(0);
    expect((await runCli(["brain", "init", "--vault", dest], { env: destEnv })).returncode).toBe(0);

    const imp = await runCli(["brain", "okf-import", out, "--trusted"], { env: destEnv });
    expect(imp.returncode).toBe(0);
    expect(existsSync(join(dest, "Note.md"))).toBe(true);
    expect(readFileSync(join(dest, "Note.md"), "utf8")).toContain("links to [[Other]].");
  });

  test("default import stages pages under OKF Review/", async () => {
    await bootstrap();
    const env = { OPEN_SECOND_BRAIN_CONFIG: config };
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nbody.\n");
    const out = join(tmp, "bundle");
    expect((await runCli(["brain", "okf-export", "--out", out], { env })).returncode).toBe(0);

    const imp = await runCli(["brain", "okf-import", out], { env });
    expect(imp.returncode).toBe(0);
    expect(imp.stdout).toContain("review mode");
    expect(existsSync(join(vault, "OKF Review", "Note.md"))).toBe(true);
  });

  test("import rejects a directory that is not an OKF bundle", async () => {
    await bootstrap();
    const r = await runCli(["brain", "okf-import", tmp], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });
});
