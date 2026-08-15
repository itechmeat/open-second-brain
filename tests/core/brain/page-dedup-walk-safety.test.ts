/**
 * The link-rewrite walk, once its root became the whole vault.
 *
 * The defects. `retargetWikilinks` was written for one root - `Brain/` -
 * and the note-file lifecycle now points it at `""`, the vault. Five
 * things that were harmless inside a machinery directory stopped being
 * harmless the moment the walk reached user notes:
 *
 *   1. `statSync` follows symlinks and the walk pushed whatever it
 *      found, so `vault/linked -> /tmp/OUTSIDE` - an ordinary Obsidian
 *      arrangement - was read, rewritten, and reported back under a
 *      vault-relative path it does not have.
 *   4. it consulted a hard-coded skip list and never
 *      `vault.ignore_paths` / `include_paths`, so a rename refused as
 *      `excluded` on its own endpoints happily rewrote and NAMED the
 *      files of a directory the operator declared out of scope.
 *   6. `replaceAll` plus a regex, with no markdown awareness, so a
 *      `[[Projects/Old]]` quoted inside a fenced block or an inline
 *      code span in a README was edited into describing a vault that
 *      never existed.
 *  13. no visited set, so a symlink cycle read the same file until the
 *      kernel raised `ELOOP`, inflating both the scanned count and the
 *      carrier population the bare-basename decision is made from.
 *   3. a write failure threw out of the pass, discarding the record of
 *      the files it had already rewritten.
 *
 * Also pinned here: the `neverRewrite` prefix list, which is how the
 * lifecycle keeps the append-only observation log readable and
 * reportable without letting a rename edit what it says was said.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retargetWikilinks } from "../../../src/core/brain/page-dedup.ts";

let vault: string;
let outside: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-retarget-walk-"));
  outside = mkdtempSync(join(tmpdir(), "o2b-retarget-outside-"));
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Write a file under the vault, creating its parents. */
function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function read(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

/** The retarget a `Projects/Old.md -> Projects/New.md` rename issues. */
const RENAME = Object.freeze([
  { from: "Projects/Old.md", to: "Projects/New.md" },
  { from: "Projects/Old", to: "Projects/New" },
]);

describe("a symlink that leaves the vault", () => {
  test("is neither read, rewritten, nor reported - on the counting pass", () => {
    writeFileSync(join(outside, "secret.md"), "see [[Projects/Old]]\n");
    symlinkSync(outside, join(vault, "linked"));
    note("Projects/Old.md", "x\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: false });

    expect(report.files).not.toContain("linked/secret.md");
    expect(report.matched).toEqual([]);
  });

  test("is not rewritten on the applying pass", () => {
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "see [[Projects/Old]]\n");
    symlinkSync(outside, join(vault, "linked"));
    note("Projects/Old.md", "x\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(readFileSync(secret, "utf8")).toBe("see [[Projects/Old]]\n");
    expect(report.rewritten).toEqual([]);
  });

  test("a symlinked FILE pointing outside is refused as well", () => {
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "see [[Projects/Old]]\n");
    mkdirSync(join(vault, "Notes"), { recursive: true });
    symlinkSync(secret, join(vault, "Notes", "alias.md"));

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.files).not.toContain("Notes/alias.md");
    expect(readFileSync(secret, "utf8")).toBe("see [[Projects/Old]]\n");
  });

  test("a symlink that stays INSIDE the vault is followed, and counted once", () => {
    note("Real/Ref.md", "see [[Projects/Old]]\n");
    symlinkSync(join(vault, "Real"), join(vault, "Alias"));

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    // One inode, one entry: the alias is not an escape and is not
    // dropped, but reporting the same bytes under two spellings is the
    // double-counting the visited set exists to stop.
    const refs = report.files.filter((rel) => rel.endsWith("Ref.md"));
    expect(refs.length).toBe(1);
    expect(["Real/Ref.md", "Alias/Ref.md"]).toContain(refs[0]!);
    expect(report.rewritten).toEqual(refs);
    expect(read("Real/Ref.md")).toBe("see [[Projects/New]]\n");
  });
});

describe("a symlink cycle", () => {
  test("terminates at the first repeat instead of at ELOOP", () => {
    mkdirSync(join(vault, "Loop"), { recursive: true });
    note("Loop/Ref.md", "see [[Projects/Old]]\n");
    // `Loop/self` points back at `Loop`, so a walk with no visited set
    // descends Loop/self/self/self/... until the kernel gives up.
    symlinkSync(join(vault, "Loop"), join(vault, "Loop", "self"));

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.files.filter((rel) => rel.endsWith("Ref.md"))).toEqual(["Loop/Ref.md"]);
    expect(report.rewritten).toEqual(["Loop/Ref.md"]);
    expect(read("Loop/Ref.md")).toBe("see [[Projects/New]]\n");
  });
});

describe("vault scope", () => {
  /** Declare `Private` out of scope, the way an operator would. */
  function declareIgnored(entry: string): void {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      `schema_version: 1\nvault:\n  ignore_paths:\n    - ${entry}\n`,
    );
  }

  test("an excluded directory is not read, not rewritten, and not named", () => {
    declareIgnored("Private");
    note("Private/Journal.md", "see [[Projects/Old]]\n");
    note("Public/Ref.md", "see [[Projects/Old]]\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.files).not.toContain("Private/Journal.md");
    expect(report.matched).toEqual(["Public/Ref.md"]);
    expect(report.rewritten).toEqual(["Public/Ref.md"]);
    expect(read("Private/Journal.md")).toBe("see [[Projects/Old]]\n");
  });

  test("an allowlist narrows the walk to what the operator declared", () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nvault:\n  include_paths:\n    - Public\n",
    );
    note("Public/Ref.md", "see [[Projects/Old]]\n");
    note("Elsewhere/Ref.md", "see [[Projects/Old]]\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.rewritten).toEqual(["Public/Ref.md"]);
    expect(read("Elsewhere/Ref.md")).toBe("see [[Projects/Old]]\n");
  });

  test("the hard skip list holds even when the operator replaces the defaults", () => {
    // Declaring `ignore_paths` REPLACES the built-in list rather than
    // extending it, so `.git` is only excluded by the floor under the
    // policy.
    declareIgnored("Private");
    note(".git/objects/Ref.md", "see [[Projects/Old]]\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.files).toEqual([]);
    expect(read(".git/objects/Ref.md")).toBe("see [[Projects/Old]]\n");
  });
});

describe("code regions", () => {
  test("a wikilink inside a fenced block is neither counted nor rewritten", () => {
    note("Docs/Tutorial.md", "How to link:\n\n```\nsee [[Projects/Old]]\n```\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.matched).toEqual([]);
    expect(report.rewritten).toEqual([]);
    expect(read("Docs/Tutorial.md")).toContain("[[Projects/Old]]");
  });

  test("a wikilink inside an inline code span is left alone", () => {
    note("Docs/Readme.md", "Write `[[Projects/Old]]` to link there.\n");

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.rewritten).toEqual([]);
    expect(read("Docs/Readme.md")).toBe("Write `[[Projects/Old]]` to link there.\n");
  });

  test("prose around a code region is still rewritten, byte for byte", () => {
    note(
      "Docs/Mixed.md",
      "live [[Projects/Old]]\n\n```md\nquoted [[Projects/Old]]\n```\n\nalso [[Projects/Old]]\n",
    );

    const report = retargetWikilinks(vault, RENAME, { root: "", apply: true });

    expect(report.rewritten).toEqual(["Docs/Mixed.md"]);
    expect(read("Docs/Mixed.md")).toBe(
      "live [[Projects/New]]\n\n```md\nquoted [[Projects/Old]]\n```\n\nalso [[Projects/New]]\n",
    );
  });
});

describe("a write that fails", () => {
  test("is reported rather than thrown, and the pass keeps going", () => {
    note("A/Ref.md", "see [[Projects/Old]]\n");
    note("Z/Ref.md", "see [[Projects/Old]]\n");
    // A read-only directory: the atomic write cannot create its sibling
    // temp file, so this one file is unwritable while its neighbour is
    // fine.
    chmodSync(join(vault, "Z"), 0o500);

    let report;
    try {
      report = retargetWikilinks(vault, RENAME, { root: "", apply: true });
    } finally {
      chmodSync(join(vault, "Z"), 0o700);
    }

    expect(report.rewritten).toEqual(["A/Ref.md"]);
    expect(report.failed.map((f) => f.path)).toEqual(["Z/Ref.md"]);
    expect(report.failed[0]!.reason.length).toBeGreaterThan(0);
    expect(read("A/Ref.md")).toBe("see [[Projects/New]]\n");
    expect(read("Z/Ref.md")).toBe("see [[Projects/Old]]\n");
  });
});

describe("neverRewrite", () => {
  test("reads and reports the prefix, and writes not one byte of it", () => {
    note("Brain/log/2026-08-15.md", "- agent said [[Projects/Old]] at 10:00\n");
    note("Notes/Ref.md", "see [[Projects/Old]]\n");

    const report = retargetWikilinks(vault, RENAME, {
      root: "",
      apply: true,
      neverRewrite: ["Brain/log"],
    });

    expect(report.matched).toEqual(["Brain/log/2026-08-15.md", "Notes/Ref.md"]);
    expect(report.rewritten).toEqual(["Notes/Ref.md"]);
    expect(read("Brain/log/2026-08-15.md")).toBe("- agent said [[Projects/Old]] at 10:00\n");
  });

  test("matches segment-wise, so a sibling with a shared prefix is not spared", () => {
    note("Brain/log-archive/2026-08-15.md", "see [[Projects/Old]]\n");

    const report = retargetWikilinks(vault, RENAME, {
      root: "",
      apply: true,
      neverRewrite: ["Brain/log"],
    });

    expect(report.rewritten).toEqual(["Brain/log-archive/2026-08-15.md"]);
  });
});
