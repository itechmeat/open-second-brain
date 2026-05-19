import { describe, expect, test } from "bun:test";
import { parseClaudeMemoryFile } from "../../../src/core/brain/claude-memory-parser.ts";

const FEEDBACK_FIXTURE = `---
name: no-em-dashes
description: Forbidden to use em-dashes in Russian writing for this user; use regular hyphens.
metadata:
  node_type: memory
  type: feedback
  originSessionId: abc
---

Body text here.

**Why:** because the user said so.
**How to apply:** apply everywhere.
`;

const USER_FIXTURE = `---
name: who-am-i
description: User is a senior developer.
metadata:
  type: user
---

Body.
`;

describe("parseClaudeMemoryFile", () => {
  test("feedback entry → MemoryRecord", () => {
    const r = parseClaudeMemoryFile(FEEDBACK_FIXTURE);
    expect(r.kind).toBe("feedback");
    if (r.kind !== "feedback") throw new Error("expected feedback");
    expect(r.name).toBe("no-em-dashes");
    expect(r.description).toContain("Forbidden to use em-dashes");
    expect(r.body).toContain("**Why:**");
    expect(r.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("non-feedback entry → kind='skip', reason recorded", () => {
    const r = parseClaudeMemoryFile(USER_FIXTURE);
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("expected skip");
    expect(r.skipReason).toContain("type=user");
  });

  test("missing frontmatter → kind='skip'", () => {
    const r = parseClaudeMemoryFile("no frontmatter here");
    expect(r.kind).toBe("skip");
    if (r.kind !== "skip") throw new Error("expected skip");
    expect(r.skipReason).toContain("frontmatter");
  });

  // Real Claude Code memory entries written before the `metadata: { type
  // }` nesting convention store `type` at the top level instead. Both
  // shapes must parse identically — see v0.10.7 smoke test against
  // /root/.claude/projects/-root/memory where 12 of 17 files use the
  // older layout.
  test("top-level `type: feedback` (older Claude Memory shape) → feedback", () => {
    const fixture =
      "---\n" +
      "name: always-russian\n" +
      "description: Reply in Russian to this user always.\n" +
      "type: feedback\n" +
      "originSessionId: x\n" +
      "---\n\n" +
      "Body.\n";
    const r = parseClaudeMemoryFile(fixture);
    expect(r.kind).toBe("feedback");
    if (r.kind !== "feedback") throw new Error("expected feedback");
    expect(r.name).toBe("always-russian");
    expect(r.description).toContain("Reply in Russian");
  });
});
