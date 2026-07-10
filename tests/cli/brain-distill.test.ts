/**
 * `o2b brain distill` CLI (t_2e2e959f): condense a source into atomic claims
 * with block-level provenance, supplied as JSON.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-distill-"));
  vault = join(tmp, "vault");
  const config = join(tmp, "config.yaml");
  env = { OPEN_SECOND_BRAIN_CONFIG: config };
  await runCli(["init", "--vault", vault, "--name", "Test"], { env });
  await runCli(["brain", "init", "--vault", vault], { env });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, "Articles", "src.md"), "# Src\n\nBody.\n", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("distills a source into a citeable claims page", async () => {
  const claims = JSON.stringify([
    { text: "First atomic claim.", block: "abc" },
    { text: "Second atomic claim." },
  ]);
  const res = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", claims, "--vault", vault, "--json"],
    { env },
  );
  expect(res.returncode).toBe(0);
  const out = JSON.parse(res.stdout) as { distillation_path: string; claim_count: number };
  expect(out.claim_count).toBe(2);
  const md = readFileSync(join(vault, out.distillation_path), "utf8");
  expect(md).toContain("## Claims");
  expect(md).toContain("([[Articles/src.md#^abc]])");
  expect(existsSync(join(vault, out.distillation_path))).toBe(true);
});

test("an empty claim list is rejected (validation error, exit 1)", async () => {
  const res = await runCli(
    ["brain", "distill", "Articles/src.md", "--claims", "[]", "--vault", vault],
    { env },
  );
  expect(res.returncode).toBe(1);
});

test("missing <source> or --claims is a usage error (exit 2)", async () => {
  const noSource = await runCli(["brain", "distill", "--claims", "[]", "--vault", vault], { env });
  expect(noSource.returncode).toBe(2);
  const noClaims = await runCli(["brain", "distill", "Articles/src.md", "--vault", vault], { env });
  expect(noClaims.returncode).toBe(2);
});
