import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectRuntimeNotices,
  renderRuntimeNotices,
} from "../../../src/core/brain/runtime-notices.ts";
import { writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";

let vault: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-notices-"));
  configPath = join(vault, "config.yaml");
});

afterEach(() => {
  // Restore writability so cleanup succeeds even after a read-only test.
  try {
    chmodSync(vault, 0o700);
  } catch {
    /* ignore */
  }
  rmSync(vault, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  writeFileSync(configPath, `vault: "${vault}"\n${body}`, "utf8");
}

/** Pretend the search index already exists so index-missing does not fire. */
function seedIndex(): void {
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
  writeFileSync(join(vault, ".open-second-brain", "brain.sqlite"), "x", "utf8");
}

test("a healthy, indexed, lexical-only vault yields no notices", () => {
  writeConfig("");
  seedIndex();
  expect(collectRuntimeNotices(vault, { configPath, env: {} })).toEqual([]);
});

test("semantic enabled without a resolvable key yields a degraded notice", () => {
  writeConfig(
    [
      `search_semantic_enabled: "true"`,
      `embedding_provider: "openai-compat"`,
      `embedding_base_url: "https://example.invalid/v1"`,
      `embedding_model: "m"`,
      "",
    ].join("\n"),
  );
  seedIndex();
  const notices = collectRuntimeNotices(vault, { configPath, env: {} });
  const codes = notices.map((n) => n.code);
  expect(codes).toContain("semantic_degraded");
  const degraded = notices.find((n) => n.code === "semantic_degraded")!;
  expect(degraded.severity).toBe("warning");
  expect(degraded.message.toLowerCase()).toContain("embedding");
});

test("a missing search index yields an index notice", () => {
  writeConfig("");
  const notices = collectRuntimeNotices(vault, { configPath, env: {} });
  expect(notices.map((n) => n.code)).toContain("search_index_missing");
});

test("a read-only vault yields a read-only notice", () => {
  writeConfig("");
  seedIndex();
  chmodSync(vault, 0o500);
  const notices = collectRuntimeNotices(vault, { configPath, env: {} });
  // Skip the assertion if the platform/user still permits the write probe
  // (e.g. running as root ignores mode bits); the notice is best-effort.
  const probe = join(vault, ".probe-write-check");
  let writable = false;
  try {
    writeFileSync(probe, "x");
    rmSync(probe);
    writable = true;
  } catch {
    /* not writable, as intended */
  }
  if (!writable) {
    expect(notices.map((n) => n.code)).toContain("vault_read_only");
  }
});

test("the opt-out env suppresses all notices", () => {
  writeConfig("");
  // Index missing would normally fire; the opt-out silences everything.
  const notices = collectRuntimeNotices(vault, {
    configPath,
    env: { OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false" },
  });
  expect(notices).toEqual([]);
});

test("renderRuntimeNotices formats a compact block and is empty when clean", () => {
  expect(renderRuntimeNotices([])).toBe("");
  const block = renderRuntimeNotices([
    { code: "semantic_degraded", severity: "warning", message: "no key" },
    { code: "search_index_missing", severity: "info", message: "build it" },
  ]);
  expect(block).toContain("Runtime notices:");
  expect(block).toContain("no key");
  expect(block).toContain("build it");
});

test("an initialized vault with no identity marker yields a marker notice", () => {
  writeConfig("");
  seedIndex();
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const codes = collectRuntimeNotices(vault, { configPath, env: {} }).map((n) => n.code);
  expect(codes).toContain("vault_marker_absent");
});

test("a vault with no Brain tree yields no marker notice", () => {
  // Nothing has been written here, so there is no store to be wrong
  // about - and `o2b brain init` must not be nagged at before it runs.
  writeConfig("");
  seedIndex();
  const codes = collectRuntimeNotices(vault, { configPath, env: {} }).map((n) => n.code);
  expect(codes).not.toContain("vault_marker_absent");
});

test("a marked vault yields no marker notice", () => {
  writeConfig("");
  seedIndex();
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeVaultIdentity(vault);
  const codes = collectRuntimeNotices(vault, { configPath, env: {} }).map((n) => n.code);
  expect(codes).not.toContain("vault_marker_absent");
});

test("an unreadable _brain.yaml is named rather than silently defaulted", () => {
  writeConfig("");
  seedIndex();
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeVaultIdentity(vault);
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 9\n", "utf8");
  const codes = collectRuntimeNotices(vault, { configPath, env: {} }).map((n) => n.code);
  expect(codes).toContain("brain_config_unreadable");
});

test("a readable _brain.yaml yields no config notice", () => {
  writeConfig("");
  seedIndex();
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeVaultIdentity(vault);
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  const codes = collectRuntimeNotices(vault, { configPath, env: {} }).map((n) => n.code);
  expect(codes).not.toContain("brain_config_unreadable");
});
