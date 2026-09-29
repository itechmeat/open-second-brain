/**
 * Unit tests for the write-path advisory (p4-silent-failure-hardening,
 * Task 3): a non-blocking, byte-identical-when-absent field on the note
 * write result that names the absolute home paths a call's authored
 * content embeds.
 *
 * The advisory reuses the hygiene grammar (`scanText` from
 * core/hygiene/hardcoded-paths.ts) AS-IS - its placeholder-segment filter
 * (`alice`, `user`, `you`, ... pass), its home-prefix scope, and its
 * `hygiene:allow-path` escape hatch. These tests pin that reuse rather
 * than a widened grammar: widening the detectors is a hygiene-module
 * decision, not a write-lane one. Path fragments are built by
 * concatenation so this file never trips the repo gate it tests against.
 */

import { describe, expect, test } from "bun:test";

import {
  WRITE_PATH_ADVISORY_KEY,
  writePathAdvisoryField,
} from "../../../src/core/brain/write-path-advisory.ts";

// The scanner is oblivious to string literals - compose the concrete
// segments so this file stays clean under the repo gate's grammar.
const HOME = "/home/";
const USERS = "/Users/";
const WIN_USERS = "C:\\Users\\";

describe("writePathAdvisoryField", () => {
  test("a body with a concrete home path yields page, line and detector", () => {
    const field = writePathAdvisoryField(
      ["intro", `see ${HOME}alice-dev/notes/x.md for details`, "outro"].join("\n"),
      "Notes/Leak.md",
    );
    const report = field[WRITE_PATH_ADVISORY_KEY]!;
    expect(report.total).toBe(1);
    expect(report.findings).toEqual([{ page: "Notes/Leak.md", line: 2, detector: "unix-home" }]);
  });

  test("the line number is the authored text's line, not the note's", () => {
    // The advisory scans the authored string on its own, so its line
    // numbers index that string: line 1 here even though the note this
    // content lands in has frontmatter above it.
    const field = writePathAdvisoryField(`path: ${USERS}devreal/docs/a.md`, "Notes/W.md");
    expect(field[WRITE_PATH_ADVISORY_KEY]!.findings).toEqual([
      { page: "Notes/W.md", line: 1, detector: "unix-home" },
    ]);
  });

  test("a windows home path names the windows detector", () => {
    const field = writePathAdvisoryField(`run ${WIN_USERS}devreal\\bin\\tool.exe`, "Notes/W.md");
    expect(field[WRITE_PATH_ADVISORY_KEY]!.findings[0]!.detector).toBe("windows-home");
  });

  test("every hit is counted, in line order", () => {
    const field = writePathAdvisoryField(
      [`${HOME}alice-dev/a.md`, "clean", `${HOME}bob-builder/b.md`].join("\n"),
      "Notes/Many.md",
    );
    const report = field[WRITE_PATH_ADVISORY_KEY]!;
    expect(report.total).toBe(2);
    expect(report.findings.map((f) => f.line)).toEqual([1, 3]);
  });

  test("a line carrying the hygiene allow marker is suppressed", () => {
    const marker = ["hygiene", "allow-path"].join(":");
    const field = writePathAdvisoryField(`${HOME}alice-dev/x.md ${marker}`, "Notes/W.md");
    expect(WRITE_PATH_ADVISORY_KEY in field).toBe(false);
  });

  test("a clean body contributes no field at all", () => {
    const field = writePathAdvisoryField("totally clean prose", "Notes/Clean.md");
    expect(WRITE_PATH_ADVISORY_KEY in field).toBe(false);
    expect(field).toEqual({});
  });

  test("no authored content contributes no field", () => {
    expect(WRITE_PATH_ADVISORY_KEY in writePathAdvisoryField(undefined, "Notes/W.md")).toBe(false);
    expect(WRITE_PATH_ADVISORY_KEY in writePathAdvisoryField("", "Notes/W.md")).toBe(false);
  });

  test("a placeholder segment passes - the grammar is reused, not widened", () => {
    // `alice` is one of the hygiene grammar's placeholder segments: an
    // intended example rather than a leak. The advisory keeps that rule
    // (and the plan's own example path) instead of widening the detector.
    const field = writePathAdvisoryField(`see ${HOME}alice/notes/x.md`, "Notes/W.md");
    expect(WRITE_PATH_ADVISORY_KEY in field).toBe(false);
  });

  test("findings never echo the matched path fragment", () => {
    const field = writePathAdvisoryField(`see ${HOME}alice-dev/notes/x.md`, "Notes/W.md");
    expect(JSON.stringify(field)).not.toContain(`${HOME}alice-dev`);
  });
});
