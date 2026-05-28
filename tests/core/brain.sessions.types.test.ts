/**
 * Tests for `sessions/types.ts` — the session-import adapter contract.
 */

import { describe, expect, test } from "bun:test";

import {
  SessionImportError,
  type SessionAdapter,
  type SessionToolCall,
  type SessionTurn,
} from "../../src/core/brain/sessions/types.ts";

describe("SessionImportError", () => {
  test("carries a typed code", () => {
    const err = new SessionImportError(
      "DETECT_FAIL",
      "no adapter recognised this file",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionImportError");
    expect(err.code).toBe("DETECT_FAIL");
  });

  test("supports IO and PARSE codes", () => {
    expect(new SessionImportError("IO", "read failed").code).toBe("IO");
    expect(new SessionImportError("PARSE", "json garbled").code).toBe("PARSE");
  });
});

describe("SessionAdapter / SessionTurn / SessionToolCall shape (compile-time)", () => {
  test("a minimal stub adapter satisfies the interface", () => {
    const stub: SessionAdapter = {
      id: "claude",
      defaultAgent: "claude",
      detect: () => false,
      iterate: async function* (_path: string) {
        void _path;
        /* empty */
      },
    };
    expect(stub.id).toBe("claude");
  });

  test("SessionTurn shape compiles with optional fields", () => {
    const turn: SessionTurn = {
      turnId: "t1",
      timestamp: "2026-05-16T00:00:00Z",
      role: "user",
    };
    expect(turn.role).toBe("user");
    expect(turn.text).toBeUndefined();
  });

  test("SessionToolCall shape compiles", () => {
    const call: SessionToolCall = {
      name: "brain_feedback",
      input: { topic: "t", signal: "negative", principle: "p" },
    };
    expect(call.name).toBe("brain_feedback");
  });
});
