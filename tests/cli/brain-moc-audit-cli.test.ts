/**
 * CLI smoke test for `o2b brain moc-audit` (v0.10.17).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configHome: string;
let configPath: string;

function writePref(slug: string, frontmatter: Record<string, string>, body = ""): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-moc-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-moc-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b brain moc-audit", () => {
  test("missing id arg exits with usage error", async () => {
    const r = await runCli(["brain", "moc-audit"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("hub note id");
  });

  test("non-MOC hub is rejected with a usage error", async () => {
    writePref(
      "pref-thin",
      { kind: "preference", topic: "t", status: "confirmed", principle: "p" },
      "Just [[pref-a]] and [[pref-b]] here.",
    );
    const r = await runCli(["brain", "moc-audit", "pref-thin"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("not a MOC");
  });

  test("MOC hub: --json prints bucketed envelope", async () => {
    writePref("pref-a", { kind: "preference", topic: "a", status: "confirmed", principle: "p" });
    writePref("pref-b", { kind: "preference", topic: "b", status: "confirmed", principle: "p" });
    writePref("pref-c", { kind: "preference", topic: "c", status: "confirmed", principle: "p" });
    writePref("pref-d", { kind: "preference", topic: "d", status: "confirmed", principle: "p" });
    writePref("pref-e", { kind: "preference", topic: "e", status: "confirmed", principle: "p" });
    writePref(
      "pref-hub",
      { kind: "preference", topic: "hub", status: "confirmed", principle: "p" },
      "[[pref-a]] [[pref-b]] [[pref-c]] [[pref-d]] [[pref-e]] [[pref-missing]]",
    );
    const r = await runCli(["brain", "moc-audit", "pref-hub", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      hub_id: string;
      outbound_count: number;
      candidate_missing: Array<{ id: string }>;
    };
    expect(payload.hub_id).toBe("pref-hub");
    expect(payload.outbound_count).toBe(6);
    expect(payload.candidate_missing.some((c) => c.id === "pref-missing")).toBe(true);
  });
});
