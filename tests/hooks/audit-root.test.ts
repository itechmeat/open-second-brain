/**
 * One spelling of the hook-audit root.
 *
 * `HOOK_AUDIT_DIR` and the {@link hookAuditDir} builder exist because the
 * directory stopped being only the hooks' business: the doctor's
 * recall-channel check reads it as the readable INSTALL fact for the
 * `hook` transport. Six hook files spelled it as a raw three-argument
 * join beside a `DERIVED_STORE_DIR` that already existed, and one of them
 * was converted - which left five independent spellings of a path a check
 * now depends on.
 *
 * This is the assertion that the de-duplication is finished. It reads the
 * hook sources rather than their behaviour, because the defect is not
 * that any one hook writes to the wrong place today: it is that a rename
 * would have to be performed six times and would silently succeed after
 * being performed once.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOOK_AUDIT_DIR } from "../../src/core/brain/paths.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

/** Every hook entry point, plus the shared helpers under `hooks/lib/`. */
function hookSources(): ReadonlyArray<{ readonly name: string; readonly text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  for (const dir of [HOOKS_DIR, join(HOOKS_DIR, "lib")]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      files.push({
        name: join(dir, entry.name),
        text: readFileSync(join(dir, entry.name), "utf8"),
      });
    }
  }
  return files;
}

describe("the hook-audit root has one spelling", () => {
  const sources = hookSources();

  test("the sweep actually found the hook sources", () => {
    // A census over an empty set passes for the wrong reason.
    expect(sources.length).toBeGreaterThan(5);
  });

  test("no hook spells the audit directory as a literal", () => {
    const offenders = sources
      .filter((source) => source.text.includes(`"${HOOK_AUDIT_DIR}"`))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });

  test("every hook that appends an audit record resolves the root through the builder", () => {
    const offenders = sources
      .filter((source) => source.text.includes("appendAuditRecord("))
      .filter((source) => !source.text.includes("hookAuditDir("))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });
});
