/**
 * Smoke test for the built OpenClaw bundle (`openclaw/index.js`).
 *
 * The bundle is the actual artifact OpenClaw loads via `package.json`'s
 * `openclaw.extensions`. We can't import it directly because it imports the
 * SDK as an external — but we can verify file structure, that it bundled
 * the core logic (no leftover dynamic Python references), and that the
 * `package.json` extension entry actually points at it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(ROOT, "openclaw", "index.js");

let bundleText: string;

beforeAll(() => {
  // 128 KB bundle; read once and share across the substring-search tests
  // instead of re-reading on every assertion.
  bundleText = readFileSync(BUNDLE, "utf8");
});

describe("openclaw bundle", () => {
  test("file exists and is non-empty", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const size = statSync(BUNDLE).size;
    expect(size).toBeGreaterThan(1000);
  });

  test("declares the SDK import as external", () => {
    expect(bundleText).toContain('from "openclaw/plugin-sdk/plugin-entry"');
  });

  test("bundles every Open Second Brain tool registration", () => {
    for (const tool of [
      // core
      "second_brain_status",
      "second_brain_query",
      "vault_health",
      // Pay Memory
      "payment_memory_init",
      "payment_receipt_append",
      "asset_capture",
      "payment_report_generate",
      "payment_policy_check",
      "payment_request_approval",
      "payment_request_status",
      "payment_request_consume",
    ]) {
      expect(bundleText).toContain(tool);
    }
  });

  test("does not register the retired event_log_append tool (§32G)", () => {
    // §32G (v0.10.8) removed `event_log_append` from every runtime.
    // The OpenClaw bundle must not contain the registration block.
    expect(bundleText).not.toContain(`name: "event_log_append"`);
  });

  test("does not register the retired second_brain_capture tool (§32G)", () => {
    expect(bundleText).not.toContain(`name: "second_brain_capture"`);
  });

  test("does NOT contain Python references", () => {
    expect(bundleText).not.toContain("python3");
    expect(bundleText).not.toContain("from open_second_brain");
  });

  test("package.json points to ./openclaw/index.js", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.openclaw.extensions).toEqual(["./openclaw/index.js"]);
  });

  test("bundles before_prompt_build hook (per-turn identity reminder)", () => {
    expect(bundleText).toContain("before_prompt_build");
    expect(bundleText).toContain("prependContext");
  });
});
