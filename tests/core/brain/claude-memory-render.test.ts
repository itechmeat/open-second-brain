import { describe, expect, test } from "bun:test";
import {
  renderPreferenceFromMemory,
  slugifyMemoryName,
} from "../../../src/core/brain/claude-memory-render.ts";
import { TagSyntaxError, isObsidianTagValue } from "../../../src/core/brain/tag-syntax.ts";

describe("renderPreferenceFromMemory", () => {
  test("emits frontmatter + body + Origin block, under trial (t_sec_memory_trial)", () => {
    const out = renderPreferenceFromMemory({
      name: "no-em-dashes",
      description: "No em-dashes in Russian writing for this user.",
      body: "Body text.\n\n**Why:** said so.\n**How to apply:** apply everywhere.",
      memoryPath: "/root/.claude/projects/-root/memory/feedback_no_em_dashes.md",
      importedAt: "2026-05-18T10:00:00Z",
      unconfirmedUntil: "2026-06-01T10:00:00Z",
      bodySha256: "a".repeat(64),
    });
    expect(out).toMatch(/^---\n/);
    expect(out).toContain("id: pref-no-em-dashes");
    // MEMORY.md is session-derived - agent-writable from conversation
    // content - so the import lands under trial like every first-party
    // write, not as a live confirmed rule.
    expect(out).toContain("_status: unconfirmed");
    expect(out).toContain('unconfirmed_until: "2026-06-01T10:00:00Z"');
    expect(out).toContain("_confidence: low");
    expect(out).toContain("scope: writing");
    // The old marker claimed a confirmation that no longer happens, and
    // its provenance job is covered by the _imported_* fields.
    expect(out).not.toContain("_force_confirmed_via");
    expect(out).not.toContain("_confirmed_at");
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
      unconfirmedUntil: "2026-06-01T10:00:00Z",
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

// ── t_11ee559f: the rendered frontmatter tags always parse-shaped ────────────

describe("renderPreferenceFromMemory — tag syntax (t_11ee559f)", () => {
  const baseRender = (
    overrides: Partial<Parameters<typeof renderPreferenceFromMemory>[0]> = {},
  ) => {
    const input = {
      name: "no-em-dashes",
      description: "No em-dashes in Russian writing for this user.",
      body: "Body text.",
      memoryPath: "/m.md",
      importedAt: "2026-05-18T10:00:00Z",
      unconfirmedUntil: "2026-06-01T10:00:00Z",
      bodySha256: "a".repeat(64),
      ...overrides,
    };
    return input;
  };

  test("every frontmatter tags value is parse-shaped for messy names and scopes", () => {
    const out = renderPreferenceFromMemory(
      baseRender({
        name: "Phase-by-phase approval: don't conflate plan/code",
        body: "First line.\nscope: testing\nrest.",
      }),
    );
    const tagsLine = out.split("\n").find((line) => line.startsWith("tags:"));
    expect(tagsLine).toBeDefined();
    const values = tagsLine!
      .slice("tags: [".length, tagsLine!.lastIndexOf("]"))
      .split(", ")
      .map((v) => v.trim());
    expect(values).toEqual([
      "brain",
      "brain/preference",
      "brain/topic/phase-by-phase-approval-don-t-conflate-plan-code",
      "brain/scope/testing",
    ]);
    for (const value of values) expect(isObsidianTagValue(value)).toBe(true);
  });

  test("a name that slugifies to a purely numeric topic refuses, naming the field", () => {
    let thrown: unknown;
    try {
      renderPreferenceFromMemory(baseRender({ name: "2024" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TagSyntaxError);
    expect((thrown as TagSyntaxError).field).toBe("topic");
  });
});
