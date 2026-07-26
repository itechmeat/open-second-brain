/**
 * Unit F, CLI surface: a frontmatter line the scanner dropped is visible
 * to an operator through `o2b search index` and `o2b brain doctor`, and a
 * vault with no malformed frontmatter produces output byte-identical to
 * the previous release (the new keys are conditional, never empty).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeVaultIdentity } from "../../src/core/brain/vault-identity.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

const CLEAN_NOTE =
  "---\ntitle: Clean\ntype: note\ntags:\n  - a\n  - b\n---\n\nA body with enough words to chunk.\n";
const ODD_NOTE = "---\ntitle: Odd\n-foo\ntype: note\n---\n\nA body with enough words to chunk.\n";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-fm-notices-cli-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  // Unit J: an unmarked root is itself reported through `uncertain`, so
  // the "clean tree emits no uncertain key" assertion needs the marker
  // `o2b brain init` would have stamped on a real vault.
  writeVaultIdentity(vault);
  configPath = join(tmp, "config.yaml");
  writeFileSync(
    configPath,
    `vault: ${vault}\nagent_name: test\ndb_path: ${join(tmp, "b.sqlite")}\n`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

describe("o2b search index frontmatter notices", () => {
  test("a clean vault emits no frontmatter_notices key at all", async () => {
    writeFileSync(join(vault, "clean.md"), CLEAN_NOTE);
    const r = await runCli(["search", "index", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("frontmatter_notices");
    expect(JSON.parse(r.stdout)).not.toHaveProperty("frontmatter_notices");
  });

  test("a dropped line is named in the JSON payload", async () => {
    writeFileSync(join(vault, "odd.md"), ODD_NOTE);
    const r = await runCli(["search", "index", "--json"], { env: env() });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      frontmatter_notices?: Array<{ code: string; path?: string; detail: string }>;
      errors: unknown[];
    };
    expect(payload.errors).toEqual([]);
    expect(payload.frontmatter_notices).toHaveLength(1);
    expect(payload.frontmatter_notices![0]!.code).toBe("frontmatter-line-dropped");
    expect(payload.frontmatter_notices![0]!.path).toBe("odd.md");
    expect(payload.frontmatter_notices![0]!.detail).toContain("-foo");
  });

  test("a dropped line is named in the human render, and a clean run is unchanged", async () => {
    writeFileSync(join(vault, "clean.md"), CLEAN_NOTE);
    const clean = await runCli(["search", "index"], { env: env() });
    expect(clean.returncode).toBe(0);
    expect(clean.stdout).not.toContain("frontmatter");

    writeFileSync(join(vault, "odd.md"), ODD_NOTE);
    const odd = await runCli(["search", "index"], { env: env() });
    expect(odd.returncode).toBe(0);
    expect(odd.stdout).toContain("frontmatter-line-dropped");
    expect(odd.stdout).toContain("odd.md");
  });
});

describe("o2b brain doctor frontmatter notices", () => {
  test("a clean Brain tree emits no uncertain key", async () => {
    const r = await runCli(["brain", "doctor", "--json"], { env: env() });
    expect(JSON.parse(r.stdout)).not.toHaveProperty("uncertain");
    expect(r.stdout).not.toContain("uncertain");
  });

  test("a dropped line reaches the doctor JSON and the human render", async () => {
    writeFileSync(
      join(vault, "Brain", "notes", "odd.md"),
      "---\ntitle: Odd\ntopic: odd\n-foo\n---\n\nBody.\n",
    );
    const asJson = await runCli(["brain", "doctor", "--json"], { env: env() });
    const payload = JSON.parse(asJson.stdout) as {
      uncertain?: Array<{ code: string; path?: string; message: string }>;
    };
    expect(payload.uncertain).toBeDefined();
    const hit = payload.uncertain!.find((e) => (e.path ?? "").endsWith("odd.md"));
    expect(hit).toBeDefined();
    expect(hit!.code).toBe("frontmatter-line-dropped");

    const human = await runCli(["brain", "doctor"], { env: env() });
    expect(human.stdout).toContain("frontmatter-line-dropped");
  });

  test("a dropped line alone does not change the doctor exit code", async () => {
    writeFileSync(
      join(vault, "Brain", "notes", "odd.md"),
      "---\ntitle: Odd\ntopic: odd\n-foo\n---\n\nBody.\n",
    );
    // Uncertainty is neither a warning nor an error, so even --strict
    // must stay at 0 when nothing else is wrong.
    const r = await runCli(["brain", "doctor", "--strict"], { env: env() });
    expect(r.returncode).toBe(0);
  });
});
