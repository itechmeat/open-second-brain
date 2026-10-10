/**
 * The owner-write gate predicate (write-side-trust, Task 8).
 *
 * `integrity.owner_scope_writes` reads as a write-side sibling of
 * `owner_scope_delivery`, and until this module the explicit-owner arm of
 * every preference write was the inverse of a boundary: a caller named any
 * owner it wanted and the writer honoured it, so under a gate an operator
 * believed was closed, a caller could publish memories into another
 * agent's isolation scope by passing `owner: "someone-else"`. An owner a
 * request names is a claim, not a fact - the same rule
 * `src/mcp/owner-scope-refusal.ts` states for the read side, applied to
 * the write that CREATES the claim.
 *
 * This file pins the PURE predicate: no filesystem, no clock, no config.
 * The gate mode and the document arrive as arguments so the composition is
 * exhaustively testable, and the callers (the preference lane here, the
 * note lane in Task 13) stay thin wrappers that resolve those inputs.
 *
 * The composition is most-restrictive-wins in BOTH directions and the
 * matrix below pins every cell:
 *
 *   - the document can narrow what an `off` gate permits
 *     (`owner_write: deny` refuses even with the gate off), and
 *   - the gate can narrow what the document permits (an `allow` verdict
 *     cannot talk a `fail` gate out of refusing a foreign owner).
 *
 * `warn` refuses nothing by itself: it exists so an operator can watch
 * what `fail` would refuse, and the caller - not this predicate - logs the
 * one decision-ledger row that makes the watching possible.
 */

import { describe, expect, test } from "bun:test";

import type { PermissionsDocument } from "../../../../src/core/brain/permissions/document.ts";
import { resolvePermission } from "../../../../src/core/brain/permissions/resolve.ts";
import {
  OWNER_SCOPE_WRITES_KEY,
  refuseCrossOwnerWrite,
} from "../../../../src/core/brain/trust/owner-write-gate.ts";
import { GATE_MODE } from "../../../../src/core/integrity/stamp.ts";

const SELF = "agent-self";
const OTHER = "agent-other";

/** The gate key, spelled the way the config inventory pins it. */
test("the gate key is the integrity block's owner_scope_writes", () => {
  expect(OWNER_SCOPE_WRITES_KEY).toBe("integrity.owner_scope_writes");
});

/** A well-formed document with one overridable piece. */
function document(fields: Partial<PermissionsDocument>): PermissionsDocument {
  return {
    version: 1,
    default_action: "allow",
    roles: {},
    agents: {},
    entries: [],
    ...fields,
  };
}

const SUBJECT = { agent: SELF, via: "config" } as const;

describe("gate matrix: the gate mode alone", () => {
  test("off with no document refuses nothing and returns the bare verdict", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
    });
    expect(verdict).toEqual({ refused: false });
    // Byte-identically: no extra fields a caller could branch on.
    expect(Object.keys(verdict)).toEqual(["refused"]);
  });

  test("off with no document and no named owner is inert at every mode", () => {
    for (const gateMode of ["off", "warn", "fail"] as const) {
      const verdict = refuseCrossOwnerWrite({
        resolvedIdentity: SELF,
        gateMode,
      });
      expect(verdict).toEqual({ refused: false });
    }
  });

  test("fail refuses a named owner other than the resolved identity, naming both tokens", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(verdict.refused).toBe(true);
    if (!verdict.refused) return;
    expect(verdict.token).toBe("owner-write-refused");
    expect(verdict.reason).toContain("owner-write-refused");
    expect(verdict.reason).toContain(OTHER);
    expect(verdict.reason).toContain(SELF);
    expect(verdict.reason).toContain(OWNER_SCOPE_WRITES_KEY);
  });

  test("fail passes a named owner that agrees with the resolved identity", () => {
    // Agreement is judged on the same normalisation the read side compares
    // with, so a case or spacing difference is not a foreign owner.
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: `  ${SELF.toUpperCase()}  `,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(verdict).toEqual({ refused: false });
  });

  test("fail with an identity that cannot be verified refuses rather than trusts", () => {
    for (const unresolved of ["", "   ", "agent"]) {
      const verdict = refuseCrossOwnerWrite({
        explicitOwner: OTHER,
        resolvedIdentity: unresolved,
        gateMode: GATE_MODE.fail,
      });
      expect(verdict.refused).toBe(true);
      if (!verdict.refused) return;
      expect(verdict.token).toBe("owner-write-refused");
      expect(verdict.reason).toContain("owner-write-refused");
    }
  });

  test("warn allows a cross-owner write so the operator can watch what fail would refuse", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.warn,
    });
    expect(verdict).toEqual({ refused: false });
  });
});

describe("gate matrix: the document composes most-restrictive-wins, both ways", () => {
  test("a document owner_write deny refuses even when the gate mode is off", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({ default_action: "deny" }),
      subject: SUBJECT,
    });
    expect(verdict.refused).toBe(true);
    if (!verdict.refused) return;
    expect(verdict.token).toBe("owner-write-refused");
    expect(verdict.reason).toContain("owner-write-refused");
    expect(verdict.reason).toContain("default");
  });

  test("a document allow cannot override gate fail", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
      document: document({ agents: { [SELF]: { owner_write: "allow" } } }),
      subject: SUBJECT,
    });
    expect(verdict.refused).toBe(true);
    if (!verdict.refused) return;
    expect(verdict.reason).toContain(OTHER);
    expect(verdict.reason).toContain(SELF);
  });

  test("a document allow with the gate off leaves the cross-owner write alone", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({ agents: { [SELF]: { owner_write: "allow" } } }),
      subject: SUBJECT,
    });
    expect(verdict).toEqual({ refused: false });
  });

  test("a document ask refuses: this gate has no review lane to stage an owner write into", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({ default_action: "ask" }),
      subject: SUBJECT,
    });
    expect(verdict.refused).toBe(true);
    if (!verdict.refused) return;
    expect(verdict.reason).toContain("ask");
  });

  test("a document deny binds every owner write this subject attempts, its own token included", () => {
    // The action the document gates is "naming an owner at all", not
    // "naming a foreign one": most-restrictive-wins means the operator's
    // deny is not demoted to a cross-owner-only rule.
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: SELF,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({ default_action: "deny" }),
      subject: SUBJECT,
    });
    expect(verdict.refused).toBe(true);
  });

  test("the document speaks only when the subject names who is asking", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({ default_action: "deny" }),
    });
    expect(verdict).toEqual({ refused: false });
  });

  test("a target-scoped entry outranks a lenient default for this subject", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.off,
      document: document({
        default_action: "deny",
        entries: [
          {
            id: "self-may-own",
            agent: SELF,
            action: "owner_write",
            verdict: "allow",
          },
        ],
      }),
      subject: SUBJECT,
    });
    expect(verdict).toEqual({ refused: false });
  });

  test("the resolved decision the matrix relies on is the shared resolver's", () => {
    // Guard against this suite drifting from the resolver's precedence
    // table: the document cases above assume entry > agent override.
    const decision = resolvePermission(
      document({
        default_action: "deny",
        agents: { [SELF]: { owner_write: "deny" } },
        entries: [{ id: "allow-self", agent: SELF, action: "owner_write", verdict: "allow" }],
      }),
      SUBJECT,
      "owner_write",
    );
    expect(decision.source).toBe("entry:allow-self");
  });
});

describe("gate matrix: the frontmatter spelling rides the same rule", () => {
  test("a frontmatter owner the gate would refuse refuses like an explicit one", () => {
    const verdict = refuseCrossOwnerWrite({
      frontmatterOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(verdict.refused).toBe(true);
    if (!verdict.refused) return;
    expect(verdict.token).toBe("owner-write-refused");
    expect(verdict.reason).toContain(OTHER);
  });

  test("a frontmatter owner matching the resolved identity passes under fail", () => {
    const verdict = refuseCrossOwnerWrite({
      frontmatterOwner: SELF,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(verdict).toEqual({ refused: false });
  });

  test("when both spellings name an owner, one that disagrees decides", () => {
    const agreesExplicit = refuseCrossOwnerWrite({
      explicitOwner: SELF,
      frontmatterOwner: OTHER,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(agreesExplicit.refused).toBe(true);

    const agreesFrontmatter = refuseCrossOwnerWrite({
      explicitOwner: OTHER,
      frontmatterOwner: SELF,
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(agreesFrontmatter.refused).toBe(true);
  });

  test("a blank owner spelling is no owner at all", () => {
    const verdict = refuseCrossOwnerWrite({
      explicitOwner: "   ",
      frontmatterOwner: "",
      resolvedIdentity: SELF,
      gateMode: GATE_MODE.fail,
    });
    expect(verdict).toEqual({ refused: false });
  });
});
