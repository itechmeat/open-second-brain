/**
 * Resilience contract for the `scripts/o2b-hook` wrapper.
 *
 * These guard the two guarantees that keep plugin updates from bricking the
 * agent (see docs/updating.md):
 *   1. fail-soft: a missing/unresolvable hook exits 0, never 2.
 *   2. version-current resolution: $CLAUDE_PLUGIN_ROOT wins over the wrapper's
 *      own (possibly stale-symlinked) location, so a stale ~/.local/bin link
 *      cannot strand the hook on an old plugin version.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRAPPER = join(REPO, "scripts", "o2b-hook");

const tmps: string[] = [];
function freshRoot(withHook: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "o2bhook-"));
  tmps.push(root);
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(WRAPPER, join(root, "scripts", "o2b-hook"));
  if (withHook !== null) {
    writeFileSync(join(root, "hooks", `${withHook}.ts`), `console.log("PROBE_OK:${withHook}");\n`);
  }
  return root;
}

// Run the wrapper with a controlled env. CLAUDE_PLUGIN_ROOT is cleared unless given.
function runHook(wrapperPath: string, args: string[], env: Record<string, string | undefined>) {
  const baseEnv = { ...process.env };
  delete baseEnv["CLAUDE_PLUGIN_ROOT"];
  delete baseEnv["OSB_PLUGIN_ROOT"];
  return spawnSync("bash", [wrapperPath, ...args], {
    env: { ...baseEnv, ...env },
    encoding: "utf8",
  });
}

afterEach(() => {
  while (tmps.length) {
    try {
      rmSync(tmps.pop()!, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("o2b-hook resilience", () => {
  test("resolves the hook via CLAUDE_PLUGIN_ROOT and runs it", () => {
    const root = freshRoot("probe");
    const r = runHook(WRAPPER, ["probe"], { CLAUDE_PLUGIN_ROOT: root });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PROBE_OK:probe");
  });

  test("missing hook fails soft: exit 0, never 2, with a warning", () => {
    // No CLAUDE_PLUGIN_ROOT, and the repo checkout has no such hook file.
    const r = runHook(WRAPPER, ["definitely-not-a-real-hook"], {});
    expect(r.status).toBe(0);
    expect(r.status).not.toBe(2);
    expect(r.stderr).toContain("could not locate");
  });

  test("CLAUDE_PLUGIN_ROOT wins over a stale wrapper location (heals broken install)", () => {
    // Simulate the broken Mac: a ~/.local/bin symlink that points into an OLD
    // checkout which lacks the hook, while Claude Code passes the current root.
    const oldRoot = freshRoot(null); // old version: wrapper present, hook absent
    const newRoot = freshRoot("probe"); // active version: has the hook
    const linkDir = mkdtempSync(join(tmpdir(), "o2bbin-"));
    tmps.push(linkDir);
    const link = join(linkDir, "o2b-hook");
    symlinkSync(join(oldRoot, "scripts", "o2b-hook"), link);

    const r = runHook(link, ["probe"], { CLAUDE_PLUGIN_ROOT: newRoot });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PROBE_OK:probe");
  });
});
