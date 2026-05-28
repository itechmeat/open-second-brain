import { describe, expect, test } from "bun:test";

import { applyPreviewBudget } from "../../src/mcp/preview-budget.ts";
import type { StoredArtifact } from "../../src/mcp/artifact-store.ts";

/** Minimal stand-in for ArtifactStore.put used by applyPreviewBudget. */
function fakeStore(redact: (s: string) => string = (s) => s) {
  const writes: string[] = [];
  return {
    writes,
    put(fullText: string): StoredArtifact {
      const text = redact(fullText);
      writes.push(text);
      return {
        artifactId: "abc123",
        runId: "run-test",
        path: "/dev/null",
        fullChars: text.length,
        text,
      };
    },
  };
}

describe("applyPreviewBudget", () => {
  test("passes text through unchanged when under budget", () => {
    const store = fakeStore();
    const out = applyPreviewBudget("small", 100, store);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe("small");
    expect(out.artifactId).toBeNull();
    expect(store.writes).toHaveLength(0);
  });

  test("passes text through unchanged when budget is undefined (opt-in only)", () => {
    const store = fakeStore();
    const big = "x".repeat(10_000);
    const out = applyPreviewBudget(big, undefined, store);
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(big);
    expect(store.writes).toHaveLength(0);
  });

  test("over budget: stores full text and returns a valid-JSON preview envelope", () => {
    const store = fakeStore();
    const big = "y".repeat(5000);
    const out = applyPreviewBudget(big, 200, store);

    expect(out.truncated).toBe(true);
    expect(out.artifactId).toBe("abc123");
    expect(store.writes).toEqual([big]);

    // content text must itself be parseable JSON even though the slice
    // would have cut mid-record.
    const env = JSON.parse(out.text);
    expect(env.preview_truncated).toBe(true);
    expect(env.artifact_id).toBe("abc123");
    expect(env.full_chars).toBe(5000);
    expect(env.bytes_preview.length).toBeLessThanOrEqual(200);
    expect(typeof env.note).toBe("string");
    expect(env.note).toContain("brain_artifact_get");
  });

  test("preview is sliced from the redacted text, not the raw input", () => {
    const store = fakeStore((s) => s.replace("SECRET-TOKEN-XYZ", "***REDACTED***"));
    const raw = "SECRET-TOKEN-XYZ " + "z".repeat(5000);
    const out = applyPreviewBudget(raw, 100, store);
    const env = JSON.parse(out.text);
    expect(env.bytes_preview).not.toContain("SECRET-TOKEN-XYZ");
    expect(env.bytes_preview).toContain("***REDACTED***");
  });

  test("the preview envelope is far smaller than the original payload", () => {
    const store = fakeStore();
    const big = "w".repeat(50_000);
    const out = applyPreviewBudget(big, 2000, store);
    expect(out.text.length).toBeLessThan(big.length / 10);
  });
});
