/**
 * A path that cannot be examined is not a path that is absent.
 *
 * `isFile` / `isDir` answered `false` for both, the same conflation the
 * plugin-config read split removed in 96b14d72: `existsSync` reports
 * `false` for EVERY stat failure, so a file sitting behind a directory
 * without the execute bit read as one that had never been created. The
 * probes stay lenient on purpose - most callers only ask "is this worth
 * opening" - so the split lives in `statOrAbsent`, and the callers whose
 * OUTPUT distinguishes the two conditions use that instead.
 *
 * Doctor is the caller that must: its entire product is the difference
 * between "not there" and "there and wrong", and its remedy differs. A
 * manifest reported as missing sends the operator to `o2b update`, which
 * regenerates it and leaves the permission fault exactly where it was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDir, isFile, statOrAbsent } from "../../src/core/fs-utils.ts";
import {
  checkHermesManifest,
  checkJsonManifest,
  checkOpenclawInstallability,
} from "../../src/core/doctor.ts";

let tmp: string;
/** Directory whose execute bit is dropped, hiding everything beneath it. */
let sealed: string;
/** A real regular file inside `sealed`, unreachable while it is sealed. */
let buried: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-fs-probe-"));
  sealed = join(tmp, "sealed");
  mkdirSync(sealed, { recursive: true });
  buried = join(sealed, "plugin.json");
  writeFileSync(buried, '{"name": "test", "version": "1.0.0"}', "utf8");
});

afterEach(() => {
  chmodSync(sealed, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});

function seal(): void {
  chmodSync(sealed, 0o000);
}

describe("statOrAbsent separates absence from a failure to look", () => {
  test("a genuinely absent path answers undefined", () => {
    expect(statOrAbsent(join(tmp, "never-created"))).toBeUndefined();
  });

  test("an existing file answers with its stat", () => {
    expect(statOrAbsent(buried)?.isFile()).toBe(true);
  });

  test("a file behind an untraversable parent raises rather than reporting absence", () => {
    seal();
    expect(() => statOrAbsent(buried)).toThrow(/EACCES/);
  });
});

describe("isFile and isDir stay lenient, and that is the reason they are separate", () => {
  test("both answer false for the unreachable file without raising", () => {
    seal();
    expect(isFile(buried)).toBe(false);
    expect(isDir(buried)).toBe(false);
  });
});

describe("doctor names an unreadable manifest instead of calling it missing", () => {
  test("a JSON manifest behind an untraversable parent is reported unreadable", () => {
    seal();
    const r = checkJsonManifest(buried, "Test");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unreadable");
    expect(r.message).not.toContain("missing");
    // The remedy has to be the one that actually clears the condition:
    // regenerating the manifest does not restore the traversal bit.
    expect(r.fix).toContain("chmod");
  });

  test("a genuinely absent JSON manifest still reports missing", () => {
    const r = checkJsonManifest(join(tmp, "never-created.json"), "Test");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("missing");
  });

  test("the Hermes manifest check makes the same distinction", () => {
    const hermes = join(sealed, "plugin.yaml");
    writeFileSync(hermes, "name: test\nversion: 1.0.0\n", "utf8");
    seal();
    const r = checkHermesManifest(hermes);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unreadable");
    expect(r.fix).toContain("chmod");
  });

  test("an unreadable OpenClaw extension entry is not reported as missing", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t" }), "utf8");
    mkdirSync(join(tmp, ".git"), { recursive: true });
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "t", openclaw: { extensions: ["./sealed/entry.js"] } }),
      "utf8",
    );
    writeFileSync(join(sealed, "entry.js"), "export {};\n", "utf8");
    seal();
    const failing = checkOpenclawInstallability(tmp).filter((r) => !r.ok);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some((r) => r.message.includes("unreadable"))).toBe(true);
    expect(failing.some((r) => r.message.includes("missing extension entry"))).toBe(false);
  });
});
