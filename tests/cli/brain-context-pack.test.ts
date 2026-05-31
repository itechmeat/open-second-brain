import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-pack-cli-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, principle: string, extra = ""): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    ["---", `id: pref-${slug}`, "topic: t", `principle: ${principle}`, extra, "---", ""].join("\n"),
  );
}

test("brain context-pack --lanes --json returns polarity lanes", async () => {
  writePref("directive", "Prefer concise answers", "tier: core");
  writePref("constraint", "Never expose tokens", "tier: core");

  const out = await runCli(
    ["brain", "context-pack", "--vault", vault, "--max-tokens", "10000", "--lanes", "--json"],
    {},
  );

  expect(out.returncode).toBe(0);
  const json = JSON.parse(out.stdout);
  expect(json.lanes.directives.map((item: { id: string }) => item.id)).toContain("pref-directive");
  expect(json.lanes.constraints.map((item: { id: string }) => item.id)).toContain(
    "pref-constraint",
  );
});
