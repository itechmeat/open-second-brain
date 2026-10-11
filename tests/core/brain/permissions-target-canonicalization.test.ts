/**
 * Target-scoped permission rules match canonically (PR #247 review M5).
 *
 * The permissions document is a vault FILE the operator hand-edits and
 * syncs across devices, while the targets the gates consult are stored
 * POSIX note paths - so a rule written as `Notes\a.md` (Windows
 * separators, `.\` prefix) or `./Notes/a.md` (dot segment) used to be
 * silently dead: an exact byte comparison against the stored path never
 * matched, and the operator got no hint. Both sides now compare through
 * the same canonical note identity (backslash folding, dot-segment
 * folding, NFC), and the loader warns about a target whose written form
 * is not canonical instead of leaving it dead in silence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalPermissionTarget,
  loadPermissionsDocument,
  type PermissionsDocument,
  resetPermissionWarnings,
} from "../../../src/core/brain/permissions/document.ts";
import {
  resolvePermission,
  type PermissionSubject,
} from "../../../src/core/brain/permissions/resolve.ts";

let vault: string;
let docPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-perm-target-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  docPath = join(vault, "Brain", "_permissions.yaml");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const SUBJECT: PermissionSubject = { agent: "codex", via: "token" };

/** An allow-by-default document whose one entry scopes `target` for codex. */
function docWithTarget(target: string): PermissionsDocument {
  return {
    version: 1,
    default_action: "allow",
    roles: {},
    agents: {},
    entries: [{ id: "t1", agent: "codex", action: "write", target, verdict: "deny" }],
  };
}

/** Capture what the loader warns while `fn` runs. */
function captureWarnings(fn: () => void): string {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.join("");
}

describe("permission target canonicalization", () => {
  test("a backslash-separator target matches the stored POSIX path", () => {
    const doc = docWithTarget("Notes\\a.md");
    const decision = resolvePermission(doc, SUBJECT, "write", "Notes/a.md");
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("entry:t1");
  });

  test("a `.\\`-prefixed target matches the stored POSIX path", () => {
    const doc = docWithTarget(".\\Notes\\a.md");
    const decision = resolvePermission(doc, SUBJECT, "write", "Notes/a.md");
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("entry:t1");
  });

  test("a `./`-prefixed target matches the stored POSIX path", () => {
    const doc = docWithTarget("./Notes/a.md");
    const decision = resolvePermission(doc, SUBJECT, "write", "Notes/a.md");
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("entry:t1");
  });

  test("an NFC stored path matches a decomposed (NFD) written target", () => {
    const nfd = "Notes/cafe\u0301.md".normalize("NFD");
    const nfc = "Notes/cafe\u0301.md".normalize("NFC");
    expect(nfd).not.toBe(nfc);
    const decision = resolvePermission(docWithTarget(nfd), SUBJECT, "write", nfc);
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("entry:t1");
  });

  test("a target-scoped entry still never matches a target-less query", () => {
    const decision = resolvePermission(docWithTarget("Notes\\a.md"), SUBJECT, "write");
    expect(decision.verdict).toBe("allow");
    expect(decision.source).toBe("default");
  });

  test("a genuinely different path still does not match", () => {
    const decision = resolvePermission(docWithTarget("Notes/a.md"), SUBJECT, "write", "Notes/b.md");
    expect(decision.verdict).toBe("allow");
    expect(decision.source).toBe("default");
  });

  test("an already-canonical target keeps matching exactly", () => {
    const decision = resolvePermission(docWithTarget("Notes/a.md"), SUBJECT, "write", "Notes/a.md");
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("entry:t1");
  });

  test("canonicalPermissionTarget is idempotent on canonical input", () => {
    expect(canonicalPermissionTarget("Notes/a.md")).toBe("Notes/a.md");
  });

  test("a `..`-segment target stays inert: exact match, never the path it climbs to", () => {
    // Exact-match semantics are unchanged on purpose: the resolver
    // compares canonical identities byte for byte, and a stored note path
    // is vault-relative, so an entry spelled with `..` can never match
    // the real note it seems to reach.
    const decision = resolvePermission(
      docWithTarget("../secrets/a.md"),
      SUBJECT,
      "write",
      "secrets/a.md",
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.source).toBe("default");
  });
});

describe("loadPermissionsDocument target warnings", () => {
  test("an unnormalized target in the document draws a naming warning", () => {
    writeFileSync(
      docPath,
      [
        "version: 1",
        "default_action: allow",
        "entries:",
        "  - id: t1",
        "    agent: codex",
        "    action: write",
        "    target: Notes\\a.md",
        "    verdict: deny",
      ].join("\n") + "\n",
      "utf8",
    );
    resetPermissionWarnings();
    const warning = captureWarnings(() => loadPermissionsDocument(vault));
    expect(warning).toContain("entries[0].target");
    expect(warning).toContain("Notes/a.md");
    // The document still loads; the rule is in force.
    const { document } = loadPermissionsDocument(vault);
    expect(document!.entries[0]!.target).toBe("Notes\\a.md");
  });

  test("a canonical target draws no target warning", () => {
    writeFileSync(
      docPath,
      [
        "version: 1",
        "default_action: allow",
        "entries:",
        "  - id: t1",
        "    agent: codex",
        "    action: write",
        "    target: Notes/a.md",
        "    verdict: deny",
      ].join("\n") + "\n",
      "utf8",
    );
    const warning = captureWarnings(() => loadPermissionsDocument(vault));
    expect(warning).not.toContain("entries[0].target");
  });

  test("a `..`-segment target still loads but warns that it can never match", () => {
    writeFileSync(
      docPath,
      [
        "version: 1",
        "default_action: allow",
        "entries:",
        "  - id: t1",
        "    agent: codex",
        "    action: write",
        "    target: ../secrets/a.md",
        "    verdict: deny",
      ].join("\n") + "\n",
      "utf8",
    );
    resetPermissionWarnings();
    const warning = captureWarnings(() => loadPermissionsDocument(vault));
    expect(warning).toContain("entries[0].target");
    expect(warning).toContain("..");
    // The document still loads; the entry stays inert by exact match.
    const { document } = loadPermissionsDocument(vault);
    expect(document!.entries[0]!.target).toBe("../secrets/a.md");
    const decision = resolvePermission(document!, SUBJECT, "write", "secrets/a.md");
    expect(decision.verdict).toBe("allow");
    expect(decision.source).toBe("default");
  });
});
