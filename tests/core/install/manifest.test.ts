import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readManifest,
  recordEntry,
  removeEntry,
  manifestPath,
} from "../../../src/core/install/manifest.ts";
import type { ManifestEntry } from "../../../src/core/install/types.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-manifest-"));
});
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
});

describe("install manifest sidecar", () => {
  test("manifestPath lives under <vault>/.open-second-brain/install.lock.json", () => {
    expect(manifestPath(vault)).toBe(join(vault, ".open-second-brain", "install.lock.json"));
  });

  test("readManifest returns empty shell when file is missing", () => {
    const m = readManifest(vault);
    expect(m.schema_version).toBe(1);
    expect(m.installs).toEqual({});
  });

  test("recordEntry creates sidecar dir + file with trailing newline", () => {
    const entry: ManifestEntry = {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/home/u/.cursor/mcp.json",
      owned_keys: ["mcpServers.open-second-brain"],
    };
    recordEntry(vault, entry);
    const m = readManifest(vault);
    expect(m.installs.cursor).toEqual(entry);
    const raw = readFileSync(manifestPath(vault), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("recordEntry overwrites existing entry for the same target", () => {
    recordEntry(vault, {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(vault, {
      target: "cursor",
      applied_at: "2026-05-20T12:05:00.000Z",
      operation: "json-merge",
      config_path: "/b",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    const m = readManifest(vault);
    expect(m.installs.cursor!.applied_at).toBe("2026-05-20T12:05:00.000Z");
    expect(m.installs.cursor!.config_path).toBe("/b");
  });

  test("removeEntry deletes the named target only", () => {
    recordEntry(vault, {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(vault, {
      target: "pi",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "symlink",
      config_path: null,
      owned_paths: ["/p"],
    });
    removeEntry(vault, "cursor");
    const m = readManifest(vault);
    expect(m.installs.cursor).toBeUndefined();
    expect(m.installs.pi).toBeDefined();
  });

  test("removeEntry on missing target is a no-op", () => {
    expect(() => removeEntry(vault, "cursor")).not.toThrow();
    expect(readManifest(vault).installs).toEqual({});
  });

  test("readManifest tolerates forward-compat unknown top-level keys", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(
      manifestPath(vault),
      JSON.stringify({ schema_version: 1, installs: {}, future_thing: 42 }),
    );
    const m = readManifest(vault);
    expect(m.schema_version).toBe(1);
  });

  test("readManifest rejects unknown schema_version", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(manifestPath(vault), JSON.stringify({ schema_version: 999, installs: {} }));
    expect(() => readManifest(vault)).toThrow(/schema_version/);
  });

  test("readManifest rejects malformed JSON", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(manifestPath(vault), "{ not json");
    expect(() => readManifest(vault)).toThrow();
  });
});
