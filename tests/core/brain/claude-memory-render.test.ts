import { describe, expect, test } from "bun:test";
import {
  renderPreferenceFromMemory,
  slugifyMemoryName,
} from "../../../src/core/brain/claude-memory-render.ts";

describe("renderPreferenceFromMemory", () => {
  test("emits frontmatter + body + Origin block", () => {
    const out = renderPreferenceFromMemory({
      name: "no-em-dashes",
      description: "No em-dashes in Russian writing for this user.",
      body: "Body text.\n\n**Why:** said so.\n**How to apply:** apply everywhere.",
      memoryPath: "/root/.claude/projects/-root/memory/feedback_no_em_dashes.md",
      importedAt: "2026-05-18T10:00:00Z",
      bodySha256: "a".repeat(64),
    });
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("id: pref-no-em-dashes");
    expect(out).toContain("status: confirmed");
    expect(out).toContain("scope: writing");
    expect(out).toContain("confidence: high");
    expect(out).toContain("_force_confirmed_via: claude-memory");
    expect(out).toContain(
      '_imported_from: "/root/.claude/projects/-root/memory/feedback_no_em_dashes.md"',
    );
    expect(out).toContain("Body text.");
    expect(out).toContain("**Why:**");
    expect(out).toContain("## Origin");
    expect(out).toContain("on 2026-05-18.");
  });

  test("body scope marker overrides default writing scope", () => {
    const out = renderPreferenceFromMemory({
      name: "x",
      description: "x",
      body: "First line.\nscope: testing\nrest.",
      memoryPath: "/m.md",
      importedAt: "2026-05-18T10:00:00Z",
      bodySha256: "a".repeat(64),
    });
    expect(out).toContain("scope: testing");
  });
});

describe("slugifyMemoryName", () => {
  test("simple kebab name is unchanged", () => {
    expect(slugifyMemoryName("no-em-dashes")).toBe("no-em-dashes");
  });

  test("underscores → dashes", () => {
    expect(slugifyMemoryName("no_em_dashes")).toBe("no-em-dashes");
  });

  test("punctuation and spaces collapse to single dash", () => {
    expect(slugifyMemoryName("Phase-by-phase approval: don't conflate plan/code")).toBe(
      "phase-by-phase-approval-don-t-conflate-plan-code",
    );
  });

  test("em-dashes do not produce runs of dashes in the slug", () => {
    expect(slugifyMemoryName("Daily/ event log — append after every artifact")).toBe(
      "daily-event-log-append-after-every-artifact",
    );
  });

  test("leading and trailing dashes are trimmed", () => {
    expect(slugifyMemoryName("  hello  ")).toBe("hello");
    expect(slugifyMemoryName("--hello--")).toBe("hello");
  });
});
