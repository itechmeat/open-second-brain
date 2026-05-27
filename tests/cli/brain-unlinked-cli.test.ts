/**
 * CLI smoke test for `o2b brain unlinked` (v0.10.17).
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
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-unlinked-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-unlinked-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b brain unlinked", () => {
  test("missing id arg exits with usage error", async () => {
    const r = await runCli(["brain", "unlinked"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("target id");
  });

  test("clean vault returns zero count", async () => {
    const r = await runCli(["brain", "unlinked", "pref-missing"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Unlinked mentions of pref-missing: 0");
  });

  test("--json prints structured envelope with count + mentions", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "Subject Line appears here.",
    );
    const r = await runCli(["brain", "unlinked", "pref-tgt", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      id: string;
      count: number;
      mentions: Array<{
        source: string;
        line: number;
        term: string;
        context: string;
      }>;
    };
    expect(payload.id).toBe("pref-tgt");
    expect(payload.count).toBe(1);
    expect(payload.mentions[0]!.source).toBe("pref-linker");
    expect(payload.mentions[0]!.term).toBe("Subject Line");
  });

  test("rejects invalid --limit values", async () => {
    for (const limit of ["0", "abc"]) {
      const r = await runCli(["brain", "unlinked", "pref-x", "--limit", limit], {
        env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
      });
      expect(r.returncode).toBe(1);
    }
  });
});
