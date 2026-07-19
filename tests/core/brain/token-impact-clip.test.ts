import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitTokenImpact, listTokenImpact } from "../../../src/core/brain/token-impact.ts";
import { clipPayloadToBudget } from "../../../src/core/brain/continuity/store.ts";
import { normalizeContinuityRecord } from "../../../src/core/brain/continuity/read-model.ts";
import {
  CONTINUITY_AGENT_ID_KEY,
  CONTINUITY_SESSION_ID_KEY,
} from "../../../src/core/brain/continuity/types.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ti-clip-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent_id joins session_id on pack identity", () => {
  test("emit writes agent_id beside session_id when provided", () => {
    const rec = emitTokenImpact(
      vault,
      {
        baselineTokens: 100,
        packedTokens: 40,
        method: "exact",
        sessionId: "s-1",
        agentId: "claude-dev-agent",
        packId: "pk-1",
      },
      true,
    );
    expect(rec).not.toBeNull();
    expect(rec!.payload[CONTINUITY_SESSION_ID_KEY]).toBe("s-1");
    expect(rec!.payload[CONTINUITY_AGENT_ID_KEY]).toBe("claude-dev-agent");
  });

  test("without agentId no agent_id key is written (byte-identical opt-out)", () => {
    const rec = emitTokenImpact(
      vault,
      { baselineTokens: 100, packedTokens: 40, method: "exact", sessionId: "s-1" },
      true,
    );
    expect(rec).not.toBeNull();
    expect(CONTINUITY_AGENT_ID_KEY in rec!.payload).toBe(false);
  });

  test("the read-model lifts agent_id to a first-class field", () => {
    const normalized = normalizeContinuityRecord({
      id: "ctn_20260101120000_aaaaaaaaaaaaaaaa",
      kind: "token_impact",
      createdAt: "2026-01-01T12:00:00Z",
      sourceRefs: [],
      payload: { session_id: "s-1", agent_id: "claude-dev-agent", delta_tokens: 60 },
      private: false,
      redacted: false,
    });
    expect(normalized!.sessionId).toBe("s-1");
    expect(normalized!.agentId).toBe("claude-dev-agent");
  });
});

describe("clip-protected identity under an output budget", () => {
  test("a tiny-budget clip retains session_id and agent_id", () => {
    emitTokenImpact(
      vault,
      {
        baselineTokens: 100,
        packedTokens: 40,
        method: "exact",
        sessionId: "s-1",
        agentId: "claude-dev-agent",
        packId: "pk-1",
      },
      true,
    );
    // A budget far smaller than the full payload forces non-protected fields
    // to be dropped; identity must survive.
    const [rec] = listTokenImpact(vault, { payloadBudgetChars: 1 });
    expect(rec).toBeDefined();
    expect(rec!.payload[CONTINUITY_SESSION_ID_KEY]).toBe("s-1");
    expect(rec!.payload[CONTINUITY_AGENT_ID_KEY]).toBe("claude-dev-agent");
    // A non-protected field was dropped to fit.
    expect("delta_tokens" in rec!.payload).toBe(false);
  });

  test("no budget pressure leaves the payload byte-identical", () => {
    emitTokenImpact(
      vault,
      {
        baselineTokens: 100,
        packedTokens: 40,
        method: "exact",
        sessionId: "s-1",
        agentId: "claude-dev-agent",
      },
      true,
    );
    const [full] = listTokenImpact(vault);
    const [budgeted] = listTokenImpact(vault, { payloadBudgetChars: 10_000 });
    // A budget larger than the payload leaves every field intact.
    expect(JSON.stringify(budgeted!.payload)).toBe(JSON.stringify(full!.payload));
  });
});

describe("clipPayloadToBudget primitive", () => {
  test("returns the same reference when within budget", () => {
    const payload = Object.freeze({ session_id: "s", a: 1 });
    expect(clipPayloadToBudget(payload, 10_000)).toBe(payload);
  });

  test("returns the same reference when the budget is undefined", () => {
    const payload = Object.freeze({ session_id: "s", a: 1 });
    expect(clipPayloadToBudget(payload, undefined)).toBe(payload);
  });

  test("drops non-protected keys but never the protected identity keys", () => {
    const payload = Object.freeze({
      session_id: "s-1",
      agent_id: "a-1",
      big: "x".repeat(500),
      note: "y".repeat(500),
    });
    const clipped = clipPayloadToBudget(payload, 40);
    expect(clipped[CONTINUITY_SESSION_ID_KEY]).toBe("s-1");
    expect(clipped[CONTINUITY_AGENT_ID_KEY]).toBe("a-1");
    expect("big" in clipped).toBe(false);
    expect("note" in clipped).toBe(false);
  });

  test("keeps protected keys even when they alone exceed the budget", () => {
    const payload = Object.freeze({ session_id: "s".repeat(100), agent_id: "a".repeat(100) });
    const clipped = clipPayloadToBudget(payload, 1);
    expect(clipped[CONTINUITY_SESSION_ID_KEY]).toBe(payload.session_id);
    expect(clipped[CONTINUITY_AGENT_ID_KEY]).toBe(payload.agent_id);
  });
});
