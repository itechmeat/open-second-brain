/**
 * P5 (t_d067a153): `o2b brain batch-plan --reconcile` plumbs the dispatched-vs-
 * ingested gap report through to the CLI. The reconcile logic is covered at the
 * core level; this asserts the flag reaches the reconciler, the report rides on
 * the JSON output, and omitting the flag leaves the output unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "../helpers/run-cli.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reconcile-cli-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reconcile-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function write(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "content\n", "utf8");
}

const ENV = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b brain batch-plan --reconcile", () => {
  test("emits a gap report naming un-ingested dispatched sources", async () => {
    write("Docs/a.md");
    write("Docs/b.md");
    // No ingest has happened, so every dispatched source is in the gap.
    const res = await runCli(["brain", "batch-plan", "Docs", "--reconcile", "--json"], {
      env: ENV(),
    });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.reconcile.dispatched).toEqual(["Docs/a.md", "Docs/b.md"]);
    expect(plan.reconcile.missing).toEqual(["Docs/a.md", "Docs/b.md"]);
    expect(plan.reconcile.complete).toBe(false);
  });

  test("without the flag the JSON omits the reconcile report", async () => {
    write("Docs/a.md");
    const res = await runCli(["brain", "batch-plan", "Docs", "--json"], { env: ENV() });
    expect(res.returncode).toBe(0);
    const plan = JSON.parse(res.stdout);
    expect(plan.reconcile).toBeUndefined();
  });
});
