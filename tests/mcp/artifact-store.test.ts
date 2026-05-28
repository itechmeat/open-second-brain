import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "../../src/mcp/artifact-store.ts";
import { brainArtifactsDir } from "../../src/core/brain/paths.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-artifact-store-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  test("put round-trips the full text through get", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    const text = "x".repeat(5000);
    const stored = store.put(text);
    expect(stored.fullChars).toBe(5000);
    expect(store.get(stored.artifactId)).toBe(text);
  });

  test("put stores the artifact under Brain/.artifacts/<runId>/ inside the vault", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    const stored = store.put("hello");
    expect(stored.path.startsWith(join(brainArtifactsDir(vault), "run-1"))).toBe(true);
    expect(existsSync(stored.path)).toBe(true);
  });

  test("identical input yields a stable artifact id; different input differs", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    const a = store.put("same payload");
    const b = store.put("same payload");
    const c = store.put("other payload");
    expect(a.artifactId).toBe(b.artifactId);
    expect(a.artifactId).not.toBe(c.artifactId);
  });

  test("get returns null for a well-formed but unknown id", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    expect(store.get("deadbeefdeadbeef")).toBeNull();
  });

  test("get rejects a path-traversal id", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    expect(() => store.get("../../etc/passwd")).toThrow();
  });

  test("put redacts secret-shaped tokens before persisting", () => {
    const store = new ArtifactStore({ vault, runId: "run-1" });
    const stored = store.put('{"api_key": "SECRET-TOKEN-123456"}');
    const back = store.get(stored.artifactId)!;
    expect(back).not.toContain("SECRET-TOKEN-123456");
    expect(back).toContain("***REDACTED***");
    // fullChars reflects the persisted (redacted) length, not the raw input.
    expect(stored.fullChars).toBe(back.length);
  });

  test("prune removes run directories older than the TTL and keeps fresh ones", () => {
    const oldStore = new ArtifactStore({ vault, runId: "run-old" });
    oldStore.put("old payload");
    const freshStore = new ArtifactStore({ vault, runId: "run-fresh" });
    freshStore.put("fresh payload");

    const oldDir = join(brainArtifactsDir(vault), "run-old");
    const past = new Date(Date.now() - 72 * 3600 * 1000);
    utimesSync(oldDir, past, past);

    const removed = freshStore.prune(24 * 3600 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(brainArtifactsDir(vault), "run-fresh"))).toBe(true);
  });
});
