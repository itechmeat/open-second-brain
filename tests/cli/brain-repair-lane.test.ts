/**
 * `o2b brain repair-lane` (G1, t_6832aac6). Dry-run is the default and writes
 * nothing; --apply requires the exact --confirm phrase before any edge is
 * written; a rerun after apply converges to zero writes.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-repair-lane-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "Notes"), { recursive: true });
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
  writeNote("Notes/alpha.md", "Alpha", "This note discusses Beta at length.");
  writeNote("Notes/beta.md", "Beta", "standalone");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeNote(rel: string, title: string, body: string): void {
  writeFileSync(
    join(vault, rel),
    ["---", "kind: brain-note", `title: ${title}`, "---", "", body, ""].join("\n"),
    "utf8",
  );
}

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("dry-run reports a candidate and writes nothing", async () => {
  const before = readFileSync(join(vault, "Notes/alpha.md"), "utf8");
  const res = await runCli(["brain", "repair-lane", "--json"], { env: env() });
  expect(res.returncode).toBe(0);
  const report = JSON.parse(res.stdout) as { mode: string; decisions: unknown[] };
  expect(report.mode).toBe("dry-run");
  expect(report.decisions.length).toBeGreaterThan(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toBe(before);
});

test("apply without the exact confirmation phrase is refused", async () => {
  const res = await runCli(["brain", "repair-lane", "--apply", "--confirm", "nope"], {
    env: env(),
  });
  expect(res.returncode).not.toBe(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).not.toContain("[[");
});

test("a refused apply under --json emits a JSON error envelope, not plain text", async () => {
  const res = await runCli(["brain", "repair-lane", "--apply", "--confirm", "nope", "--json"], {
    env: env(),
  });
  expect(res.returncode).toBe(1);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; message: string };
  expect(parsed.ok).toBe(false);
  expect(parsed.message).toContain("confirmation phrase");
});

test("apply with the exact phrase writes the edge, and a rerun is a no-op", async () => {
  const applied = await runCli(
    ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
    { env: env() },
  );
  expect(applied.returncode).toBe(0);
  const first = JSON.parse(applied.stdout) as { written: number };
  expect(first.written).toBeGreaterThan(0);
  expect(readFileSync(join(vault, "Notes/alpha.md"), "utf8")).toContain("beta");

  const rerun = await runCli(
    ["brain", "repair-lane", "--apply", "--confirm", "apply repair", "--json"],
    { env: env() },
  );
  const second = JSON.parse(rerun.stdout) as { written: number };
  expect(second.written).toBe(0);
});
