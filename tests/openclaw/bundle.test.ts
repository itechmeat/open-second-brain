/**
 * Smoke test for the built OpenClaw bundle (`openclaw/index.js`).
 *
 * The bundle is the actual artifact OpenClaw loads via `package.json`'s
 * `openclaw.extensions`. We can't import it directly because it imports the
 * SDK as an external — but we can verify file structure, that it bundled
 * the core logic (no leftover dynamic Python references), and that the
 * `package.json` extension entry actually points at it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(ROOT, "openclaw", "index.js");

describe("openclaw bundle", () => {
  test("file exists and is non-empty", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const size = statSync(BUNDLE).size;
    expect(size).toBeGreaterThan(1000);
  });

  test("declares the SDK import as external", () => {
    const text = readFileSync(BUNDLE, "utf8");
    expect(text).toContain('from "openclaw/plugin-sdk/plugin-entry"');
  });

  test("bundles all five tool registrations", () => {
    const text = readFileSync(BUNDLE, "utf8");
    for (const tool of [
      "second_brain_status",
      "second_brain_query",
      "second_brain_capture",
      "event_log_append",
      "vault_health",
    ]) {
      expect(text).toContain(tool);
    }
  });

  test("does NOT contain Python references", () => {
    const text = readFileSync(BUNDLE, "utf8");
    expect(text).not.toContain("python3");
    expect(text).not.toContain("from open_second_brain");
  });

  test("package.json points to ./openclaw/index.js", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.openclaw.extensions).toEqual(["./openclaw/index.js"]);
  });

  test("bundles before_prompt_build hook (per-turn identity reminder)", () => {
    const text = readFileSync(BUNDLE, "utf8");
    expect(text).toContain("before_prompt_build");
    expect(text).toContain("prependContext");
  });
});
