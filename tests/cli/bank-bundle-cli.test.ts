/**
 * CLI surface for the Brain Portability & Interop suite (Unit A):
 * `o2b brain bank-export | bank-import`. Locks argument shape, --json,
 * --mode validation, and exit codes; the core has its own unit coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bank-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  expect(
    (
      await runCli(["init", "--vault", vault, "--name", "T"], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
  expect(
    (
      await runCli(["brain", "init", "--vault", vault], {
        env: { OPEN_SECOND_BRAIN_CONFIG: config },
      })
    ).returncode,
  ).toBe(0);
}

describe("o2b brain bank-export / bank-import", () => {
  test("bank-export emits a schema-versioned bundle with content sections", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");
    const exp = await runCli(["brain", "bank-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(exp.returncode).toBe(0);
    const bundle = JSON.parse(exp.stdout);
    expect(bundle.schema).toBe("1");
    expect(Array.isArray(bundle.graph.nodes)).toBe(true);
    expect(Array.isArray(bundle.pages)).toBe(true);
    expect(Array.isArray(bundle.preferences)).toBe(true);
  });

  test("bank-export then bank-import round-trips the page graph", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Note.md"), "---\ntitle: Note\n---\nlinks to [[Other]].\n");
    const exp = await runCli(["brain", "bank-export"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(exp.returncode).toBe(0);
    const bundleFile = join(tmp, "bank.json");
    writeFileSync(bundleFile, exp.stdout);
    const imp = await runCli(["brain", "bank-import", bundleFile, "--mode", "skip", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(imp.returncode).toBe(0);
    const result = JSON.parse(imp.stdout);
    // The page already exists in the same vault -> skipped (idempotent).
    expect(result.graph.skipped).toContain("Note.md");
    expect(typeof result.pagesCarried).toBe("number");
  });

  test("bank-import rejects an unknown --mode", async () => {
    await bootstrap();
    writeFileSync(join(tmp, "b.json"), '{"schema":"1","graph":{"nodes":[]}}');
    const r = await runCli(["brain", "bank-import", join(tmp, "b.json"), "--mode", "bogus"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
  });

  test("bank-import fails loudly on an unsupported schema", async () => {
    await bootstrap();
    writeFileSync(join(tmp, "old.json"), '{"schema":"999","graph":{"nodes":[]}}');
    const r = await runCli(["brain", "bank-import", join(tmp, "old.json")], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("schema");
  });
});
