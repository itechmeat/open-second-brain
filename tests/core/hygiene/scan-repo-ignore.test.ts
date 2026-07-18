/**
 * P1 (t_9654de80): the hygiene repo scan honors nested `.gitignore` files and
 * `.git/info/exclude`, while staying byte-identical to the static skip-dir
 * baseline when a tree carries no ignore files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listScanTargets } from "../../../src/core/hygiene/scan-repo.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scan-ignore-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `content` to `<root>/<rel>`, creating parent directories. */
function put(rel: string, content = "x\n"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("byte-identical baseline", () => {
  test("with no ignore files, every scannable file is a target", () => {
    put("src/a.ts");
    put("src/nested/b.ts");
    put("docs/c.md");
    const targets = listScanTargets(root);
    expect(targets).toEqual(["docs/c.md", "src/a.ts", "src/nested/b.ts"]);
  });
});

describe("nested gitignore composition", () => {
  test("a nested .gitignore scopes only its own subtree", () => {
    put("src/keep.ts");
    put("src/pkg/drop.ts");
    put("src/pkg/keep.ts");
    put("src/other/drop.ts");
    // The nested file under src/pkg only governs src/pkg.
    put("src/pkg/.gitignore", "drop.ts\n");
    const targets = listScanTargets(root);
    expect(targets).toContain("src/keep.ts");
    expect(targets).toContain("src/pkg/keep.ts");
    expect(targets).toContain("src/other/drop.ts");
    expect(targets).not.toContain("src/pkg/drop.ts");
  });

  test("the root .gitignore skips paths under a scan dir", () => {
    put("src/a.ts");
    put("src/generated/b.ts");
    put(".gitignore", "generated/\n");
    const targets = listScanTargets(root);
    expect(targets).toContain("src/a.ts");
    expect(targets).not.toContain("src/generated/b.ts");
  });

  test("a nearer ! re-include wins over an outer ignore", () => {
    put("src/skip/important.ts");
    put("src/keep/important.ts");
    put("src/keep/other.ts");
    put(".gitignore", "important.ts\n");
    put("src/keep/.gitignore", "!important.ts\n");
    const targets = listScanTargets(root);
    // Outer rule ignores important.ts everywhere...
    expect(targets).not.toContain("src/skip/important.ts");
    // ...but the nearer re-include under src/keep wins.
    expect(targets).toContain("src/keep/important.ts");
    expect(targets).toContain("src/keep/other.ts");
  });

  test(".git/info/exclude participates in the scan", () => {
    put("src/a.ts");
    put("src/secret.ts");
    put(".git/info/exclude", "secret.ts\n");
    const targets = listScanTargets(root);
    expect(targets).toContain("src/a.ts");
    expect(targets).not.toContain("src/secret.ts");
  });
});

describe("malformed patterns", () => {
  test("a malformed pattern warns on stderr and never silently skips", () => {
    put("src/a.ts");
    put("src/[weird.ts");
    put(".gitignore", "[unterminated\n");
    const lines: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      lines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let targets: string[];
    try {
      targets = listScanTargets(root);
    } finally {
      process.stderr.write = real;
    }
    // Malformed rule produced no matcher, so nothing was silently dropped.
    expect(targets).toContain("src/a.ts");
    expect(targets).toContain("src/[weird.ts");
    expect(lines.join("")).toContain("malformed ignore pattern");
  });
});
