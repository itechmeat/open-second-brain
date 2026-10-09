/**
 * Resolved-literal redaction on the egress paths (trust-surface-
 * hardening, t_e5807974 / Lane B3).
 *
 * A `$secret:NAME` reference resolves to a value the structural passes
 * cannot see: the value is an opaque string whose key may say nothing
 * (`note:`) and whose shape may carry no vendor prefix. Once such a value
 * is resolved at a use site, every path that carries its carrier outward
 * - the egress guard and the MCP error redactor - must scrub the literal
 * itself, longest first, before the truncation guard can cut a fragment
 * of it into the kept prefix.
 *
 * Every credential-shaped string below is assembled at runtime via the
 * fake-credentials helper, so no source line carries a literal shaped
 * like a real credential.
 */

import { describe, expect, test } from "bun:test";

import { redactConfigMapping, redactForEgress } from "../../src/core/egress/guard.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import {
  MAX_REDACTOR_INPUT,
  REDACTION_PLACEHOLDER,
  SCAN_TRUNCATED_MARKER,
  redactStructured,
} from "../../src/core/redactor.ts";
import { redactErrorForCaller } from "../../src/mcp/error-redaction.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

// Two overlapping placeholder credentials: SHORT is a suffix of LONG, so
// a shortest-first substitution would destroy LONG's match and leak its
// head as a fragment. Neither is vendor-shaped or digit-bearing, so the
// structural passes leave both alone and the test isolates the literal
// mechanism.
const LONG_VALUE = fakeCredential("alpha-bravo-", "charlie-delta-echo");
const SHORT_VALUE = fakeCredential("charlie-delta-", "echo");

const VAULT = fakeCredential("/tmp/", "vault-under-test");

describe("redactForEgress with resolved literals", () => {
  test("replaces each resolved value with the standard marker, longest first", () => {
    const verdict = redactForEgress(
      "config-export",
      { note: `see ${LONG_VALUE} then ${SHORT_VALUE} end` },
      { resolvedLiterals: [SHORT_VALUE, LONG_VALUE] },
    );
    expect(verdict.outcome).toBe("released");
    if (verdict.outcome !== "released") return;
    expect(verdict.payload).toEqual({
      note: `see ${REDACTION_PLACEHOLDER} then ${REDACTION_PLACEHOLDER} end`,
    });
    expect(verdict.redacted).toBe(true);
  });

  test("scrubs before the scan window truncates and still refuses the payload", () => {
    // SHORT_VALUE's head would survive in the kept prefix if the literal
    // scrub ran after the truncation cut.
    const pad = "p".repeat(MAX_REDACTOR_INPUT - 4);
    const verdict = redactForEgress(
      "config-export",
      { note: pad + LONG_VALUE },
      { resolvedLiterals: [LONG_VALUE] },
    );
    expect(verdict.outcome).toBe("refused_scan_truncated");
  });

  test("with no literals the composition is byte-identical to the bare policy", () => {
    const payload = { note: `see ${LONG_VALUE} end`, count: 2 };
    const bare = redactStructured(payload, { redactTokens: true, redactUrlCredentials: true });
    for (const policy of [{}, { resolvedLiterals: [] }]) {
      const verdict = redactForEgress("config-export", payload, policy);
      expect(verdict.outcome).toBe("released");
      if (verdict.outcome !== "released") return;
      expect(verdict.payload).toEqual(bare.value as typeof payload);
      expect(verdict.redacted).toBe(bare.redacted);
    }
  });
});

describe("redactConfigMapping with resolved literals", () => {
  test("replaces each resolved value with the standard marker, longest first", () => {
    const out = redactConfigMapping(
      { note: `see ${LONG_VALUE} then ${SHORT_VALUE} end` },
      { resolvedLiterals: [SHORT_VALUE, LONG_VALUE] },
    );
    expect(out).toEqual({
      note: `see ${REDACTION_PLACEHOLDER} then ${REDACTION_PLACEHOLDER} end`,
    });
  });

  test("scrubs before the scan window truncates a leaf", () => {
    // The straddling leaf: if the literal scrub ran after the truncation
    // cut, the kept prefix would end with the head of LONG_VALUE as a
    // fragment. A leaf wholly inside the window proves the marker itself.
    const straddling = "p".repeat(MAX_REDACTOR_INPUT - 4) + LONG_VALUE;
    const out = redactConfigMapping(
      { head: LONG_VALUE, tail: straddling },
      { resolvedLiterals: [LONG_VALUE] },
    );
    const tail = String(out["tail"]);
    expect(tail.includes(LONG_VALUE.slice(0, 8))).toBe(false);
    expect(tail.includes(SCAN_TRUNCATED_MARKER)).toBe(true);
    expect(out["head"]).toBe(REDACTION_PLACEHOLDER);
  });

  test("with no literals the output is byte-identical to today's single-argument call", () => {
    const data = { note: `see ${LONG_VALUE} end`, keep: "kept" };
    expect(redactConfigMapping(data, {})).toEqual(redactConfigMapping(data));
    expect(redactConfigMapping(data, { resolvedLiterals: [] })).toEqual(redactConfigMapping(data));
  });
});

describe("MCP error redaction with resolved literals", () => {
  test("local reach scrubs resolved literals beside the vault root", () => {
    const raw = `read failed at ${VAULT}/notes/x.md: ${LONG_VALUE} refused`;
    const out = redactErrorForCaller(raw, VAULT, TRANSPORT_REACH.local, [LONG_VALUE]);
    expect(out.includes(LONG_VALUE)).toBe(false);
    expect(out.includes(REDACTION_PLACEHOLDER)).toBe(true);
    expect(out.includes(`${VAULT}/notes/x.md`)).toBe(false);
  });

  test("remote reach scrubs resolved literals beside the root placeholders", () => {
    const raw = `read failed at ${VAULT}/notes/x.md: ${LONG_VALUE} refused`;
    const out = redactErrorForCaller(raw, VAULT, TRANSPORT_REACH.remote, [LONG_VALUE]);
    expect(out.includes(LONG_VALUE)).toBe(false);
    expect(out.includes("<vault>/notes/x.md")).toBe(true);
  });

  test("without literals the output is byte-identical to the three-argument call", () => {
    const raw = `read failed at ${VAULT}/notes/x.md: details`;
    for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote]) {
      expect(redactErrorForCaller(raw, VAULT, reach, [])).toBe(
        redactErrorForCaller(raw, VAULT, reach),
      );
    }
  });
});
