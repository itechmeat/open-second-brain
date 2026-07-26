/**
 * Unit F: the doctor surfaces frontmatter lines the scanner dropped.
 *
 * A note with unsupported frontmatter grammar is never excluded from the
 * vault - individual fields simply vanish, leaving the page untyped,
 * unaliased, or undated. `runDoctor` reports the drop through its
 * `uncertain` extension point ("sub-operations the doctor attempted but
 * cannot claim completed cleanly") without changing any severity: it is
 * neither a warning nor an error, because nothing is provably broken -
 * only unverifiable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { DEGRADATION_CODE } from "../../../src/core/integrity/degradation.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-fm-notices-"));
  vault = join(tmp, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  // Unit J: an unmarked root is an uncertainty finding in its own
  // right, so a fixture standing for a clean vault carries the marker
  // `o2b brain init` would have stamped.
  writeVaultIdentity(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runDoctor frontmatter notices", () => {
  test("a clean Brain tree reports no uncertain entries", () => {
    writeFileSync(
      join(vault, "Brain", "notes", "ok.md"),
      "---\ntitle: Fine\ntopic: ok\ntags:\n  - brain\n  - brain/note\n---\n\nBody.\n",
    );
    const result = runDoctor(vault);
    expect(result.uncertain ?? []).toEqual([]);
  });

  test("an unsupported frontmatter line is reported as an uncertain entry naming the file", () => {
    writeFileSync(
      join(vault, "Brain", "notes", "odd.md"),
      "---\ntitle: Odd\ntopic: odd\n-foo\n---\n\nBody.\n",
    );
    const result = runDoctor(vault);
    const entries = result.uncertain ?? [];
    expect(entries.length).toBeGreaterThan(0);
    const hit = entries.find((e) => (e.path ?? "").endsWith("odd.md"));
    expect(hit).toBeDefined();
    expect(hit!.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
    expect(hit!.message).toContain("-foo");
  });

  test("the dropped line does not become a warning or an error", () => {
    writeFileSync(
      join(vault, "Brain", "notes", "odd.md"),
      "---\ntitle: Odd\ntopic: odd\n-foo\n---\n\nBody.\n",
    );
    const result = runDoctor(vault);
    for (const issue of [...result.warnings, ...result.errors]) {
      expect(issue.code).not.toBe(DEGRADATION_CODE.frontmatterLineDropped);
    }
  });

  test("a supported block-style list produces no uncertain entry", () => {
    writeFileSync(
      join(vault, "Brain", "notes", "block.md"),
      "---\ntitle: Block\ntopic: block\ntags:\n  - brain\n  - brain/signal\n---\n\nBody.\n",
    );
    const result = runDoctor(vault);
    expect(result.uncertain ?? []).toEqual([]);
  });

  test("the doctor still never throws on an unreadable Brain subtree", () => {
    // A directory where a Markdown file is expected: the walker cannot
    // parse it, and the doctor must still return a result.
    mkdirSync(join(vault, "Brain", "notes", "dir.md"));
    expect(() => runDoctor(vault)).not.toThrow();
  });
});
