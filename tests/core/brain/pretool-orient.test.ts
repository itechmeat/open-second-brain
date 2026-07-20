import { describe, expect, test } from "bun:test";

import {
  decideOrient,
  ORIENT_DENY_MESSAGE,
  ORIENT_NUDGE_MESSAGE,
  type OrientInput,
} from "../../../src/core/brain/pretool-orient.ts";

const VAULT = "/home/dev/vault";

function base(overrides: Partial<OrientInput> = {}): OrientInput {
  return {
    runtime: "claudecode",
    toolName: "Read",
    toolInput: { file_path: `${VAULT}/Brain/note.md` },
    vaultRoot: VAULT,
    isOriented: false,
    alreadyBlocked: false,
    ...overrides,
  };
}

describe("decideOrient", () => {
  test("a brain search tool refreshes orientation", () => {
    const d = decideOrient(base({ toolName: "mcp__plugin_x_open-second-brain__brain_search" }));
    expect(d.kind).toBe("refresh_orientation");
  });

  test("first raw vault read (claudecode, not oriented, not blocked) -> deny naming the search surface", () => {
    const d = decideOrient(base());
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.reason).toBe(ORIENT_DENY_MESSAGE);
      expect(d.reason.toLowerCase()).toContain("search");
    }
  });

  test("subsequent raw vault read (already blocked) -> nudge", () => {
    const d = decideOrient(base({ alreadyBlocked: true }));
    expect(d.kind).toBe("nudge");
    if (d.kind === "nudge") expect(d.reason).toBe(ORIENT_NUDGE_MESSAGE);
  });

  test("an orientation stamp suppresses the block -> allow", () => {
    const d = decideOrient(base({ isOriented: true }));
    expect(d.kind).toBe("allow");
  });

  test("non-Claude-Code harness never hard-blocks -> allow (fail open)", () => {
    for (const runtime of ["codex", "grok", "unknown"] as const) {
      expect(decideOrient(base({ runtime })).kind).toBe("allow");
    }
  });

  test("a read whose path resolves OUTSIDE the vault root -> allow", () => {
    const d = decideOrient(base({ toolInput: { file_path: "/etc/passwd" } }));
    expect(d.kind).toBe("allow");
  });

  test("a mutate tool inside the vault is not a raw read -> allow (never blocks writes)", () => {
    for (const toolName of ["Edit", "Write", "MultiEdit"]) {
      const d = decideOrient(base({ toolName }));
      expect(d.kind).toBe("allow");
    }
  });

  test("a read tool with no file path in its input -> allow", () => {
    const d = decideOrient(base({ toolInput: {} }));
    expect(d.kind).toBe("allow");
  });

  test("the vault root itself resolving as the path is treated as inside the vault", () => {
    const d = decideOrient(base({ toolInput: { path: VAULT } }));
    expect(d.kind).toBe("deny");
  });

  test("orientation refresh wins even for a read-shaped brain tool call", () => {
    // A brain search tool never carries a raw vault file_path, but even if a
    // future tool did, the refresh branch must take priority over the block.
    const d = decideOrient(
      base({
        toolName: "mcp__srv__brain_query",
        toolInput: { file_path: `${VAULT}/Brain/x.md` },
      }),
    );
    expect(d.kind).toBe("refresh_orientation");
  });
});
