/**
 * Tests for `o2b brain lifecycle <action>` CLI verb, focused on the
 * temporal-replace action (Belief lifecycle suite, A2, t_3ba9c404).
 *
 * The core `temporalReplace` had no reachable production caller; this
 * asserts the CLI verb wires it end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFrontmatter, parseFrontmatter } from "../../src/core/vault.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let configDir: string;
let vault: string;
let configPath: string;

const env = { OPEN_SECOND_BRAIN_CONFIG: "", VAULT_AGENT_NAME: "" } as const;
const AT = "2026-07-18T12:00:00Z";

function writeFact(slug: string): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `fact ${slug}`,
    },
    "Prose.",
  );
  return rel;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-lifecycle-cli-"));
  configDir = mkdtempSync(join(tmpdir(), "o2b-brain-lifecycle-cli-cfg-"));
  vault = join(tmp, "vault");
  configPath = join(configDir, "config.yaml");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  Bun.write(configPath, `vault: ${vault}\nagent_name: tester\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe("o2b brain lifecycle temporal-replace", () => {
  test("closes the predecessor and opens the successor at one shared instant", async () => {
    const pred = writeFact("old");
    const succ = writeFact("new");
    const r = await runCli(
      [
        "brain",
        "lifecycle",
        "temporal-replace",
        pred,
        succ,
        "--config",
        configPath,
        "--at",
        AT,
        "--json",
      ],
      { env },
    );
    expect(r.returncode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.at).toBe(AT);
    expect(out.predecessor).toBe("Brain/preferences/pref-old.md");
    expect(out.successor).toBe("Brain/preferences/pref-new.md");

    const [predMeta] = parseFrontmatter(join(vault, pred));
    const [succMeta] = parseFrontmatter(join(vault, succ));
    expect(predMeta["valid_until"]).toBe(AT);
    expect(predMeta["superseded_by"]).toBe("[[pref-new]]");
    expect(succMeta["valid_from"]).toBe(AT);
  });

  test("requires predecessor, successor, and --at", async () => {
    const pred = writeFact("old");
    const succ = writeFact("new");
    const missingAt = await runCli(
      ["brain", "lifecycle", "temporal-replace", pred, succ, "--config", configPath],
      { env },
    );
    expect(missingAt.returncode).not.toBe(0);

    const missingSucc = await runCli(
      ["brain", "lifecycle", "temporal-replace", pred, "--config", configPath, "--at", AT],
      { env },
    );
    expect(missingSucc.returncode).not.toBe(0);
  });
});
