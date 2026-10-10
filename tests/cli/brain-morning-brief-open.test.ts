/**
 * `o2b brain morning-brief` - the open-decisions section
 * (write-side-trust wave, Lane E, Task 10).
 *
 * The section rides the existing verb: parked questions surface every
 * morning (a standing question has no cooldown), unreadable records are
 * named rather than hidden, and rendering mutates nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { openDecision } from "../../src/core/brain/decisions/open-store.ts";

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-morning-brief-open-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-morning-brief-open-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const env = { OPEN_SECOND_BRAIN_CONFIG: "", VAULT_AGENT_NAME: "" } as const;

function park(title: string, question: string): void {
  openDecision(vault, {
    title,
    question,
    options: ["a", "b"],
    agent: "tester",
  });
}

describe("o2b brain morning-brief open decisions", () => {
  test("a vault with no open decisions keeps a byte-identical brief", async () => {
    const r = await runCli(["brain", "morning-brief", "--vault", vault], { env });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("## Open decisions");
  });

  test("open decisions surface in the text and --json envelopes", async () => {
    park("Parked question", "Do we keep the legacy importer?");
    const text = await runCli(["brain", "morning-brief", "--vault", vault], { env });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("## Open decisions");
    expect(text.stdout).toContain("Do we keep the legacy importer?");

    const json = await runCli(["brain", "morning-brief", "--vault", vault, "--json"], {
      env,
    });
    expect(json.returncode).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(payload.open_decisions).toHaveLength(1);
    expect(payload.open_decisions[0].question).toBe("Do we keep the legacy importer?");
  });

  test("an unreadable record is named and never hides the readable one; rendering mutates nothing", async () => {
    park("Fragile", "Does the fragile record survive?");
    park("Healthy", "Does the healthy record surface?");
    const fragile = join(vault, "Brain", "decisions", "open-fragile.md");
    writeFileSync(
      fragile,
      readFileSync(fragile, "utf8").replace("status: open", "status: gone"),
      "utf8",
    );
    const before = readFileSync(join(vault, "Brain", "decisions", "open-healthy.md"), "utf8");
    const r = await runCli(["brain", "morning-brief", "--vault", vault], { env });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("## Unreadable open decisions");
    expect(r.stdout).toContain("Does the healthy record surface?");
    expect(readFileSync(join(vault, "Brain", "decisions", "open-healthy.md"), "utf8")).toBe(before);
  });
});
