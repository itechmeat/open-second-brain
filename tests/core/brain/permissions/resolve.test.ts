/**
 * `resolvePermission` precedence (write-side-trust, Task 1).
 *
 * The resolver is the one answer to "which rule decided this", so the
 * precedence table is pinned here row by row: a target-scoped entry
 * beats the agent's per-action override, which beats the agent's role,
 * which beats `default_action`; among rules of equal specificity deny
 * beats ask beats allow. Every row also pins the `source` string a
 * ledger row will carry, so the accountability trail and the resolver
 * cannot drift apart.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPermissionsDocument,
  type PermissionVerdict,
  type PermissionsDocument,
} from "../../../../src/core/brain/permissions/document.ts";
import {
  resolvePermission,
  type PermissionSubject,
} from "../../../../src/core/brain/permissions/resolve.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-resolve-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const SUBJECT: PermissionSubject = { agent: "codex", via: "token" };

function docWith(overrides: Partial<PermissionsDocument> = {}): PermissionsDocument {
  return {
    version: 1,
    default_action: "ask",
    roles: {},
    agents: {},
    entries: [],
    ...overrides,
  };
}

/** A two-entry document pinning the tie-break rows of the precedence table. */
function tieDoc(first: PermissionVerdict, second: PermissionVerdict): PermissionsDocument {
  return docWith({
    default_action: "allow",
    entries: [
      { id: "e1", agent: "codex", action: "write", target: "t.md", verdict: first },
      { id: "e2", agent: "codex", action: "write", target: "t.md", verdict: second },
    ],
  });
}

describe("resolvePermission", () => {
  test("an empty document resolves everything to default_action", () => {
    const decision = resolvePermission(docWith({ default_action: "deny" }), SUBJECT, "write");
    expect(decision).toEqual({ verdict: "deny", source: "default", reason: "default_action" });
  });

  test("the default applies to every action and any target", () => {
    const doc = docWith({ default_action: "allow" });
    for (const action of ["write", "ingest", "owner_write"] as const) {
      expect(resolvePermission(doc, SUBJECT, action).verdict).toBe("allow");
      expect(resolvePermission(doc, SUBJECT, action, "notes/foo.md").source).toBe("default");
    }
  });

  test("an agent override beats default_action, naming the agent as source", () => {
    const doc = docWith({
      default_action: "deny",
      agents: { codex: { write: "allow" } },
    });
    expect(resolvePermission(doc, SUBJECT, "write")).toEqual({
      verdict: "allow",
      source: "agent:codex",
      reason: "agent override",
    });
    // Only the action it overrides.
    expect(resolvePermission(doc, SUBJECT, "ingest").source).toBe("default");
  });

  test("the agent's role mapping beats default_action but not the agent override", () => {
    const doc = docWith({
      default_action: "deny",
      roles: { reviewer: { write: "ask" } },
      agents: { codex: { role: "reviewer" } },
    });
    expect(resolvePermission(doc, SUBJECT, "write")).toEqual({
      verdict: "ask",
      source: "role:reviewer",
      reason: "role mapping",
    });

    const withOverride: PermissionsDocument = {
      ...doc,
      agents: { codex: { role: "reviewer", write: "allow" } },
    };
    expect(resolvePermission(withOverride, SUBJECT, "write").source).toBe("agent:codex");
  });

  test("an agent with no role never reads a role it was not granted", () => {
    const doc = docWith({ default_action: "deny", roles: { reviewer: { write: "ask" } } });
    expect(resolvePermission(doc, SUBJECT, "write").source).toBe("default");
  });

  test("a target-scoped entry beats every blanket rule", () => {
    const doc = docWith({
      default_action: "allow",
      agents: { codex: { write: "allow" } },
      roles: { reviewer: { write: "allow" } },
      entries: [
        {
          id: "freeze-target",
          agent: "codex",
          action: "write",
          target: "notes/foo.md",
          verdict: "deny",
        },
      ],
    });
    expect(resolvePermission(doc, SUBJECT, "write", "notes/foo.md")).toEqual({
      verdict: "deny",
      source: "entry:freeze-target",
      reason: "target-scoped entry freeze-target",
    });
    // The same entry says nothing about any other target.
    expect(resolvePermission(doc, SUBJECT, "write", "notes/bar.md").source).toBe("agent:codex");
  });

  test("an untargeted entry applies everywhere but loses to a target-scoped one", () => {
    const doc = docWith({
      default_action: "allow",
      entries: [
        { id: "blanket", agent: "codex", action: "write", verdict: "ask" },
        { id: "narrow", agent: "codex", action: "write", target: "notes/foo.md", verdict: "deny" },
      ],
    });
    expect(resolvePermission(doc, SUBJECT, "write", "notes/foo.md").source).toBe("entry:narrow");
    expect(resolvePermission(doc, SUBJECT, "write", "notes/bar.md").source).toBe("entry:blanket");
    expect(resolvePermission(doc, SUBJECT, "write", "notes/bar.md").verdict).toBe("ask");
  });

  test("at equal specificity deny beats ask beats allow, regardless of order", () => {
    expect(resolvePermission(tieDoc("ask", "deny"), SUBJECT, "write", "t.md").verdict).toBe("deny");
    expect(resolvePermission(tieDoc("deny", "ask"), SUBJECT, "write", "t.md").verdict).toBe("deny");
    expect(resolvePermission(tieDoc("allow", "ask"), SUBJECT, "write", "t.md").verdict).toBe("ask");
    expect(resolvePermission(tieDoc("ask", "allow"), SUBJECT, "write", "t.md").verdict).toBe("ask");
    expect(resolvePermission(tieDoc("allow", "deny"), SUBJECT, "write", "t.md").verdict).toBe(
      "deny",
    );
    expect(resolvePermission(tieDoc("deny", "allow"), SUBJECT, "write", "t.md").verdict).toBe(
      "deny",
    );
  });

  test("a deny entry beats an allow role at the same tier boundary", () => {
    const doc = docWith({
      default_action: "allow",
      roles: { reviewer: { write: "allow" } },
      agents: { codex: { role: "reviewer" } },
      entries: [{ id: "stop", role: "reviewer", action: "write", verdict: "deny" }],
    });
    expect(resolvePermission(doc, SUBJECT, "write")).toEqual({
      verdict: "deny",
      source: "entry:stop",
      reason: "entry stop",
    });
  });

  test("entries match by agent, by role, or globally - never by the wrong principal", () => {
    const doc = docWith({
      default_action: "allow",
      roles: { reviewer: { write: "ask" } },
      agents: { codex: { role: "reviewer" } },
      entries: [
        { id: "for-codex", agent: "codex", action: "write", verdict: "deny" },
        { id: "for-reviewer", role: "reviewer", action: "ingest", verdict: "deny" },
        { id: "for-everyone", action: "owner_write", verdict: "deny" },
      ],
    });
    const other: PermissionSubject = { agent: "gemini", via: "token" };

    expect(resolvePermission(doc, SUBJECT, "write").source).toBe("entry:for-codex");
    expect(resolvePermission(doc, SUBJECT, "ingest").source).toBe("entry:for-reviewer");
    expect(resolvePermission(doc, SUBJECT, "owner_write").source).toBe("entry:for-everyone");

    // gemini holds no role, so no principal entry reaches it; only the
    // global one decides its own action, and the rest fall to the default.
    expect(resolvePermission(doc, other, "owner_write").source).toBe("entry:for-everyone");
    expect(resolvePermission(doc, other, "write").source).toBe("default");
    expect(resolvePermission(doc, other, "ingest").source).toBe("default");
  });

  test("an entry for another agent does not leak onto this one at any tier", () => {
    const doc = docWith({
      default_action: "deny",
      agents: { gemini: { write: "allow" }, codex: { role: "reviewer" } },
      roles: { reviewer: { write: "ask" } },
      entries: [{ id: "gemini-only", agent: "gemini", action: "write", verdict: "allow" }],
    });
    const decision = resolvePermission(doc, SUBJECT, "write");
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("role:reviewer");
  });

  test("an entry whose action differs never decides this action", () => {
    const doc = docWith({
      default_action: "deny",
      entries: [{ id: "ingest-only", agent: "codex", action: "ingest", verdict: "allow" }],
    });
    expect(resolvePermission(doc, SUBJECT, "write").source).toBe("default");
  });

  test("the subject's via never changes the verdict", () => {
    const doc = docWith({
      default_action: "deny",
      agents: { codex: { write: "allow" } },
    });
    for (const via of ["token", "config", "operator"] as const) {
      expect(resolvePermission(doc, { agent: "codex", via }, "write").verdict).toBe("allow");
    }
  });

  test("a document that denies by default is visible through the resolver on a real file", () => {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_permissions.yaml"),
      "version: 1\ndefault_action: deny\n",
      "utf8",
    );
    const { document } = loadPermissionsDocument(vault);
    expect(document).not.toBeNull();
    const decision = resolvePermission(document!, SUBJECT, "ingest", "sources/x.md");
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("default");
  });
});
