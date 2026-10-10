/**
 * `Brain/_permissions.yaml` loader (write-side-trust, Task 1).
 *
 * Two failure modes, never collapsed: the file ABSENT is the default
 * posture (`{ document: null }`, every gate proceeds as today) and the
 * file PRESENT BUT UNREADABLE fails closed with a field-named
 * {@link PermissionsDocumentError}. The second half is the whole point
 * of the loader: a permissions document the machine cannot parse is an
 * operator's trust policy that is not in force, and silently proceeding
 * would read the silence as consent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPermissionsDocument,
  PERMISSIONS_DOCUMENT_REL,
  PERMISSIONS_SCHEMA_VERSION,
  PermissionsDocumentError,
} from "../../../../src/core/brain/permissions/document.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let vault: string;
let docPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-permissions-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  docPath = join(vault, "Brain", "_permissions.yaml");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeDoc(text: string): void {
  writeFileSync(docPath, text, "utf8");
}

/** One-entry document body; `entry` captures nothing from any test scope. */
function entryDoc(body: string): string {
  return `version: 1\ndefault_action: allow\nentries:\n  - ${body}\n`;
}

/** Capture what the loader warns while `fn` runs. */
function captureWarnings(fn: () => void): string[] {
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
  return lines;
}

describe("loadPermissionsDocument", () => {
  test("an absent document is null and names the path it looked at", () => {
    const result = loadPermissionsDocument(vault);
    expect(result.document).toBeNull();
    expect(result.path).toBe(docPath);
  });

  test("the constant names the vault-relative document, and the schema version is 1", () => {
    expect(PERMISSIONS_DOCUMENT_REL).toBe("Brain/_permissions.yaml");
    expect(PERMISSIONS_SCHEMA_VERSION).toBe(1);
  });

  test("a minimal valid document loads with its explicit default action", () => {
    writeDoc("version: 1\ndefault_action: ask\n");
    const { document } = loadPermissionsDocument(vault);
    expect(document).not.toBeNull();
    expect(document!.version).toBe(1);
    expect(document!.default_action).toBe("ask");
    expect(document!.roles).toEqual({});
    expect(document!.agents).toEqual({});
    expect(document!.entries).toEqual([]);
  });

  test("a full document round-trips roles, agents, entries and the ledger block", () => {
    writeDoc(
      [
        "version: 1",
        "default_action: deny",
        "ledger:",
        "  record_allows: true",
        "roles:",
        "  reviewer:",
        "    write: ask",
        "    ingest: deny",
        "agents:",
        "  codex:",
        "    role: reviewer",
        "    write: allow",
        "entries:",
        "  - id: freeze-notes",
        "    agent: codex",
        "    action: write",
        "    target: notes/foo.md",
        "    verdict: deny",
      ].join("\n") + "\n",
    );
    const { document } = loadPermissionsDocument(vault);
    expect(document).not.toBeNull();
    expect(document!.ledger).toEqual({ record_allows: true });
    expect(document!.roles["reviewer"]).toEqual({ write: "ask", ingest: "deny" });
    expect(document!.agents["codex"]).toEqual({ role: "reviewer", write: "allow" });
    expect(document!.entries).toEqual([
      {
        id: "freeze-notes",
        agent: "codex",
        action: "write",
        target: "notes/foo.md",
        verdict: "deny",
      },
    ]);
  });

  test("a missing default_action refuses with the field named, never a silent default", () => {
    writeDoc("version: 1\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(PermissionsDocumentError);
    expect(() => loadPermissionsDocument(vault)).toThrow(/default_action/);
  });

  test("a missing or unsupported version hard-refuses naming the file and the field", () => {
    writeDoc("default_action: allow\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/version/);
    try {
      loadPermissionsDocument(vault);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionsDocumentError);
      expect((err as Error).message).toContain(docPath);
    }

    writeDoc("version: 2\ndefault_action: allow\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/version/);
    expect(() => loadPermissionsDocument(vault)).toThrow(new RegExp("_permissions\\.yaml"));
  });

  test("malformed YAML throws PermissionsDocumentError naming the file", () => {
    writeDoc("version: 1\ndefault_action: ask\nroles: [unclosed\n");
    try {
      loadPermissionsDocument(vault);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionsDocumentError);
      expect((err as Error).message).toContain(docPath);
    }
  });

  test("a non-mapping document refuses by name", () => {
    writeDoc("- just\n- a\n- list\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(PermissionsDocumentError);
  });

  test("wrong field types refuse with the field named", () => {
    writeDoc("version: one\ndefault_action: ask\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/version/);

    writeDoc("version: 1\ndefault_action: maybe\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/default_action/);

    writeDoc("version: 1\ndefault_action: 3\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/default_action/);

    writeDoc("version: 1\ndefault_action: ask\nroles: reviewer\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/roles/);

    writeDoc("version: 1\ndefault_action: ask\nagents:\n  codex: allow\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/agents\.codex/);

    writeDoc("version: 1\ndefault_action: ask\nledger:\n  record_allows: yes-please\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/ledger\.record_allows/);
  });

  test("entries are validated field by field", () => {
    writeDoc(entryDoc("action: write\n    verdict: deny"));
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.id/);

    writeDoc(entryDoc("id: e1\n    verdict: deny"));
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.action/);

    writeDoc(entryDoc("id: e1\n    action: explode\n    verdict: deny"));
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.action/);

    writeDoc(entryDoc("id: e1\n    action: write"));
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.verdict/);

    writeDoc(entryDoc("id: e1\n    action: write\n    verdict: perhaps"));
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.verdict/);

    writeDoc(
      entryDoc(
        "id: e1\n    agent: codex\n    role: reviewer\n    action: write\n    verdict: deny",
      ),
    );
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]/);

    // An entry naming neither a principal nor a target would match every
    // subject on every action - the document default with extra steps.
    // Allowed: it is the "nobody may do X anywhere" form.
    writeDoc(entryDoc("id: nobody-writes\n    action: write\n    verdict: deny"));
    const { document } = loadPermissionsDocument(vault);
    expect(document!.entries).toHaveLength(1);
  });

  test("entry role and agent values must be strings when present", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: e1\n    agent: 7\n    action: write\n    verdict: deny\n",
    );
    expect(() => loadPermissionsDocument(vault)).toThrow(/entries\[0\]\.agent/);
  });

  test("unknown keys warn with their field path and the document still loads", () => {
    writeDoc(
      [
        "version: 1",
        "default_action: ask",
        "future_key: 1",
        "roles:",
        "  reviewer:",
        "    write: ask",
        "    review: maybe",
        "agents:",
        "  codex:",
        "    role: reviewer",
        "    favourite_colour: blue",
        "entries:",
        "  - id: e1",
        "    agent: codex",
        "    action: write",
        "    verdict: ask",
        "    note: hello",
      ].join("\n") + "\n",
    );
    const warnings = captureWarnings(() => {
      const { document } = loadPermissionsDocument(vault);
      expect(document).not.toBeNull();
    });
    const said = warnings.join("");
    expect(said).toContain("future_key");
    expect(said).toContain("roles.reviewer.review");
    expect(said).toContain("agents.codex.favourite_colour");
    expect(said).toContain("entries[0].note");
    expect(said).toContain("unknown field ignored (forward-compat)");
  });

  test("duplicate keys in one mapping refuse", () => {
    writeDoc("version: 1\ndefault_action: ask\ndefault_action: deny\n");
    expect(() => loadPermissionsDocument(vault)).toThrow(/default_action/);
  });

  test("a directory where the document belongs fails closed", () => {
    rmSync(docPath, { force: true });
    mkdirSync(docPath);
    expect(() => loadPermissionsDocument(vault)).toThrow(PermissionsDocumentError);
    expect(() => loadPermissionsDocument(vault)).toThrow(new RegExp("_permissions\\.yaml"));
  });
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a present but unreadable file fails closed with the file named",
  () => {
    const lockedVault = mkdtempSync(join(tmpdir(), "o2b-permissions-"));
    const lockedDocPath = join(lockedVault, "Brain", "_permissions.yaml");
    mkdirSync(join(lockedVault, "Brain"), { recursive: true });
    writeFileSync(lockedDocPath, "version: 1\ndefault_action: ask\n", "utf8");
    chmodSync(lockedDocPath, 0o000);
    try {
      expect(() => loadPermissionsDocument(lockedVault)).toThrow(PermissionsDocumentError);
      try {
        loadPermissionsDocument(lockedVault);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain(lockedDocPath);
      }
    } finally {
      chmodSync(lockedDocPath, 0o644);
      rmSync(lockedVault, { recursive: true, force: true });
    }
  },
);
