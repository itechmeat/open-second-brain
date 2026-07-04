/**
 * Tests for the hardcoded home / absolute path hygiene scanner.
 *
 * Two layers:
 *   1. Unit coverage of the pure {@link scanText} core — detectors,
 *      placeholder allowlist, the `hygiene:allow-path` escape hatch.
 *   2. A repo gate: the shipped surfaces this check owns must be clean
 *      today, and stay clean. This is the enforcing counterpart to the
 *      report-only `scripts/check-hardcoded-paths.ts`.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFinding, scanText } from "../../../src/core/hygiene/hardcoded-paths.ts";
import { listScanTargets, scanRepo } from "../../../src/core/hygiene/scan-repo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The scanner is oblivious to string literals — build path fragments by
// concatenation so this very test file is not itself flagged when the
// repo gate scans the tree (tests are excluded, but belt and braces).
const HOME = "/home/";
const USERS = "/Users/";

describe("scanText — detectors", () => {
  test("flags a concrete POSIX /home/<user> path", () => {
    const found = scanText(`export const p = "${HOME}sergey/vault";`, "x.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.detector).toBe("unix-home");
    expect(found[0]!.segment).toBe("sergey");
    expect(found[0]!.match).toBe(`${HOME}sergey`);
    expect(found[0]!.line).toBe(1);
  });

  test("flags a concrete /Users/<user> path", () => {
    const found = scanText(`vault: ${USERS}alexander/notes`, "doc.md");
    expect(found).toHaveLength(1);
    expect(found[0]!.detector).toBe("unix-home");
    expect(found[0]!.segment).toBe("alexander");
  });

  test("flags a Windows X:\\Users\\<user> path (raw and escaped backslash)", () => {
    const raw = scanText("path = C:\\Users\\Vladimir\\vault", "doc.md");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.detector).toBe("windows-home");
    expect(raw[0]!.segment).toBe("Vladimir");

    const escaped = scanText('const p = "D:\\\\Users\\\\Natalia\\\\v";', "x.ts");
    expect(escaped).toHaveLength(1);
    expect(escaped[0]!.segment).toBe("Natalia");
  });

  test("reports 1-based line and column", () => {
    const found = scanText(`a\nb\n  x = ${HOME}dmitry/v`, "x.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(3);
    expect(found[0]!.column).toBe(`  x = `.length + 1);
  });

  test("finds multiple hits on one line", () => {
    const found = scanText(`${HOME}petr/a and ${HOME}igor/b`, "x.ts");
    expect(found.map((f) => f.segment)).toEqual(["petr", "igor"]);
  });
});

describe("scanText — placeholders and non-home paths pass", () => {
  const cleanCases: ReadonlyArray<readonly [string, string]> = [
    ["placeholder 'user'", `${HOME}user/vault`],
    ["placeholder 'you'", `${HOME}you/vault`],
    ["placeholder 'youruser'", `${HOME}youruser/vault`],
    ["single-letter stand-in", `${USERS}x/vault`],
    ["two-letter stand-in", `${HOME}me/vault`],
    ["literal ellipsis segment", `${USERS}...`],
    ["tilde home", "~/vaults/brain"],
    ["$HOME env", "$HOME/vaults/brain"],
    ["generic /path/to", "/path/to/vault"],
    ["system path /usr/bin", "#!/usr/bin/env bun"],
    ["system path /etc", "/etc/hosts"],
    ["temp path /tmp", "/tmp/o2b-test"],
    ["repo path /srv", "/srv/projects/open-second-brain"],
  ];
  for (const [label, line] of cleanCases) {
    test(`no finding: ${label}`, () => {
      expect(scanText(line, "x.ts")).toHaveLength(0);
    });
  }
});

describe("scanText — hygiene:allow-path escape hatch", () => {
  test("suppresses findings on an annotated line", () => {
    const line = `const p = "${HOME}sergey/vault"; // hygiene:allow-path intentional demo`;
    expect(scanText(line, "x.ts")).toHaveLength(0);
  });

  test("only suppresses the annotated line, not its neighbours", () => {
    const content = [`${HOME}sergey/a // hygiene:allow-path`, `${HOME}sergey/b`].join("\n");
    const found = scanText(content, "x.ts");
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
  });
});

describe("formatFinding", () => {
  test("renders file:line:column with segment and detector", () => {
    const [f] = scanText(`${HOME}sergey/vault`, "src/x.ts");
    expect(formatFinding(f!)).toBe(
      `src/x.ts:1:1: hardcoded home path '${HOME}sergey' (segment 'sergey', unix-home)`,
    );
  });
});

describe("repo gate", () => {
  test("shipped surfaces contain no hardcoded home paths", () => {
    const findings = scanRepo(ROOT);
    // Surface the offenders in the failure message so a regression is
    // actionable without re-running the scanner by hand.
    expect(findings.map(formatFinding)).toEqual([]);
  });

  test("scan reaches the surfaces the task names", () => {
    const targets = listScanTargets(ROOT);
    expect(targets).toContain("README.md");
    expect(targets.some((t) => t.startsWith("src/"))).toBe(true);
    expect(targets.some((t) => t.startsWith("docs/"))).toBe(true);
    expect(targets.some((t) => t.startsWith("templates/"))).toBe(true);
    expect(targets.some((t) => t.startsWith("plugins/"))).toBe(true);
    // Fixtures and the test tree are intentionally out of scope.
    expect(targets.some((t) => t.startsWith("tests/"))).toBe(false);
    expect(targets.some((t) => t.includes("/fixtures/"))).toBe(false);
  });
});
