/**
 * A broken `Brain/_brain.yaml` must reach an operator as a named verb
 * failure, never as an unhandled throw.
 *
 * Commit 96b14d72 made `loadGuardrailsConfigSafe` raise on a config that
 * is present and unreadable, which is right: the operator's settings are
 * not in force and serving the defaults would hide that. Two verbs on the
 * `packContext` path had no boundary for it, so `o2b brain context-pack`
 * and `o2b brain anticipate` printed a stack trace - which names the
 * repo's file layout rather than the operator's file. Every sibling verb
 * on this path (`scan-inline`, `scan-citations`, `apply-markers`) already
 * had that boundary and reported `<verb> failed: <cause>`.
 *
 * The absent-config case is asserted beside each one: a vault that has
 * never run `o2b brain init` must keep succeeding, which is the whole
 * reason the `*Safe` readers exist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Parses as YAML, fails validation, in a block neither verb reads. */
const BROKEN_CONFIG = `schema_version: 1\ndream:\n  candidate_threshold: 0\n`;

let vault: string;
let configHome: string;
/**
 * A machine config is required, not incidental: `anticipate` resolves the
 * search-index path through it, so without one the absent-`_brain.yaml`
 * case would fail for an unrelated reason and prove nothing.
 */
let env: Record<string, string>;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-broken-config-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), "o2b-cli-broken-config-cfg-"));
  const configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
  env = { OPEN_SECOND_BRAIN_CONFIG: configPath };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function breakConfig(): void {
  writeFileSync(brainConfigPath(vault), BROKEN_CONFIG, "utf8");
}

describe("o2b brain context-pack", () => {
  test("an uninitialised vault still packs", async () => {
    const res = await runCli(["brain", "context-pack", "--max-tokens", "500", "--vault", vault], {
      env,
    });
    expect(res.returncode).toBe(0);
  });

  test("an unreadable config fails by name, with the file the operator must fix", async () => {
    breakConfig();
    const res = await runCli(["brain", "context-pack", "--max-tokens", "500", "--vault", vault], {
      env,
    });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("context-pack failed");
    expect(res.stderr).toContain(brainConfigPath(vault));
  });

  test("the failure does not carry a stack trace into stderr", async () => {
    breakConfig();
    const res = await runCli(["brain", "context-pack", "--max-tokens", "500", "--vault", vault], {
      env,
    });
    expect(res.stderr).not.toContain("src/core/brain/policy/load.ts");
  });
});

describe("o2b brain anticipate", () => {
  test("an uninitialised vault still reports a cache state", async () => {
    const res = await runCli(["brain", "anticipate", "--session", "s1", "--vault", vault], { env });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("cache:");
  });

  test("an unreadable config fails by name, with the file the operator must fix", async () => {
    breakConfig();
    const res = await runCli(["brain", "anticipate", "--session", "s1", "--vault", vault], { env });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("anticipate failed");
    expect(res.stderr).toContain(brainConfigPath(vault));
  });
});

/**
 * `resolveNoteRoots` reads `notes.read_paths` through the same split, and
 * an empty root list is indistinguishable from a scan that found nothing
 * - so it raises. Every verb that walks note space already owned a
 * boundary for it; these two are the representatives, one per shape (a
 * scanner and a writeback), and they need no change. They are pinned so
 * a later refactor cannot quietly remove the boundary and leave the raise
 * escaping the way `context-pack`'s did.
 */
describe("note-space verbs already name the raise", () => {
  test("scan-inline: absent config scans nothing and succeeds", async () => {
    const res = await runCli(["brain", "scan-inline", "--dry-run", "--vault", vault], { env });
    expect(res.returncode).toBe(0);
  });

  test("scan-inline: an unreadable config fails by name", async () => {
    breakConfig();
    const res = await runCli(["brain", "scan-inline", "--dry-run", "--vault", vault], { env });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("scan-inline failed");
    expect(res.stderr).toContain(brainConfigPath(vault));
  });

  test("apply-markers: an unreadable config fails by name", async () => {
    breakConfig();
    const res = await runCli(["brain", "apply-markers", "--vault", vault], { env });
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("apply-markers");
    expect(res.stderr).toContain(brainConfigPath(vault));
  });
});
