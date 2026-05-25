/**
 * CLI smoke test for `o2b brain synthesise` (v0.10.17).
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

function writePref(
  slug: string,
  frontmatter: Record<string, string>,
  body = "",
): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) lines.push(`${k}: ${v}`);
  lines.push("---", "", body);
  writeFileSync(join(vault, "Brain", "preferences", `${slug}.md`), lines.join("\n"));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-synth-cli-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");

  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-synth-cli-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("o2b brain synthesise", () => {
  test("missing id arg exits with usage error", async () => {
    const r = await runCli(["brain", "synthesise"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("target id");
  });

  test("--json prints envelope with target + linkers", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject",
    });
    writePref(
      "pref-linker",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "Refers to [[pref-tgt]] in body.",
    );
    const r = await runCli(["brain", "synthesise", "pref-tgt", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      target_id: string;
      target_title: string;
      linkers: Array<{ source: string }>;
    };
    expect(payload.target_id).toBe("pref-tgt");
    expect(payload.target_title).toBe("Subject");
    expect(payload.linkers.length).toBe(1);
    expect(payload.linkers[0]!.source).toBe("pref-linker");
  });

  test("--include-unlinked also populates unlinked_mentions", async () => {
    writePref("pref-tgt", {
      kind: "preference",
      topic: "t",
      status: "confirmed",
      principle: "p",
      title: "Subject Line",
    });
    writePref(
      "pref-prose",
      {
        kind: "preference",
        topic: "l",
        status: "confirmed",
        principle: "p",
      },
      "I mention Subject Line in prose.",
    );
    const r = await runCli(
      ["brain", "synthesise", "pref-tgt", "--include-unlinked", "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      unlinked_mentions: Array<{ source: string }>;
    };
    expect(payload.unlinked_mentions.length).toBe(1);
    expect(payload.unlinked_mentions[0]!.source).toBe("pref-prose");
  });
});
