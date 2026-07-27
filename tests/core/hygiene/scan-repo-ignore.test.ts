/**
 * P1 (t_9654de80): the hygiene repo scan honors nested `.gitignore` files and
 * `.git/info/exclude`, while staying byte-identical to the static skip-dir
 * baseline when a tree carries no ignore files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("root scan files", () => {
  test("a root file ignored by .gitignore is excluded from the scan", () => {
    put("README.md", "# readme\n");
    put("src/a.ts");
    put(".gitignore", "README.md\n");
    const targets = listScanTargets(root);
    expect(targets).toContain("src/a.ts");
    expect(targets).not.toContain("README.md");
  });

  test("a root file is scanned when no ignore rule matches it", () => {
    put("README.md", "# readme\n");
    const targets = listScanTargets(root);
    expect(targets).toContain("README.md");
  });
});

/** Run `fn` with stderr captured, returning everything it wrote. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = real;
  }
  return chunks.join("");
}

describe("malformed patterns", () => {
  test("a malformed pattern warns on stderr and never silently skips", () => {
    put("src/a.ts");
    put("src/[weird.ts");
    put(".gitignore", "[unterminated\n");
    let targets: string[] = [];
    const printed = captureStderr(() => {
      targets = listScanTargets(root);
    });
    // Malformed rule produced no matcher, so nothing was silently dropped.
    expect(targets).toContain("src/a.ts");
    expect(targets).toContain("src/[weird.ts");
    expect(printed).toContain("malformed ignore pattern");
  });
});

describe("unusable ignore files", () => {
  test("an unreadable .gitignore warns on stderr instead of passing silently", () => {
    put("src/a.ts");
    put("src/secret.ts");
    put(".gitignore", "secret.ts\n");
    chmodSync(join(root, ".gitignore"), 0o000);
    let targets: string[] = [];
    const printed = captureStderr(() => {
      targets = listScanTargets(root);
    });
    // The declaration could not be applied, so the file is still scanned - and
    // the operator is told why rather than being left to guess.
    expect(targets).toContain("src/secret.ts");
    expect(printed).toContain(".gitignore");
    expect(printed).toContain("EACCES");
  });

  test("a symlinked .gitignore is refused with a stderr warning", () => {
    put("src/a.ts");
    put("src/secret.ts");
    put("outside/rules", "secret.ts\n");
    symlinkSync(join(root, "outside", "rules"), join(root, ".gitignore"));
    let targets: string[] = [];
    const printed = captureStderr(() => {
      targets = listScanTargets(root);
    });
    expect(targets).toContain("src/secret.ts");
    expect(printed).toContain("symbolic link");
  });
});
