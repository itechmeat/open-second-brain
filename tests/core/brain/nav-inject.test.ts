import { describe, expect, test } from "bun:test";

import {
  decideNavInject,
  navInjectAuditDetails,
  NAV_TIER_CADENCE_MINUTES_DEFAULT,
} from "../../../src/core/brain/nav-inject.ts";

describe("decideNavInject", () => {
  test("suppresses on an active cadence stamp without consulting the navmap", () => {
    const decision = decideNavInject("<block>", true);
    expect(decision.kind).toBe("suppress");
    if (decision.kind === "suppress") expect(decision.reason).toBe("cadence");
  });

  test("suppresses when the navmap is empty", () => {
    const decision = decideNavInject("", false);
    expect(decision.kind).toBe("suppress");
    if (decision.kind === "suppress") expect(decision.reason).toBe("empty");
  });

  test("injects the block and reports its char count when cadence is due", () => {
    const block = "Vault navmap (structural: ...)";
    const decision = decideNavInject(block, false);
    expect(decision.kind).toBe("inject");
    if (decision.kind === "inject") {
      expect(decision.block).toBe(block);
      expect(decision.chars).toBe(block.length);
    }
  });
});

describe("navInjectAuditDetails", () => {
  test("records why and the added char count for an inject", () => {
    const details = navInjectAuditDetails(decideNavInject("abc", false));
    expect(details["decision"]).toBe("inject");
    expect(details["added_chars"]).toBe(3);
  });

  test("records the suppress reason", () => {
    const details = navInjectAuditDetails(decideNavInject("abc", true));
    expect(details["decision"]).toBe("suppress");
    expect(details["reason"]).toBe("cadence");
  });
});

describe("named cadence default", () => {
  test("is a positive integer number of minutes", () => {
    expect(Number.isInteger(NAV_TIER_CADENCE_MINUTES_DEFAULT)).toBe(true);
    expect(NAV_TIER_CADENCE_MINUTES_DEFAULT).toBeGreaterThan(0);
  });
});
