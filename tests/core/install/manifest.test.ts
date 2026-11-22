import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readManifest,
  recordEntry,
  removeEntry,
  manifestPath,
} from "../../../src/core/install/manifest.ts";
import type { ManifestEntry } from "../../../src/core/install/types.ts";
import type { InstallOrigin } from "../../../src/core/install/origin.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

let vault: string;
const mkTemp = tempDirs();
beforeEach(() => {
  vault = mkTemp("osb-manifest-");
  // A legacy vault: it keeps its machine state. A vault with no `Brain/`
  // is store-only and keeps that state device-local instead.
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
});

function installEnv(
  origin: InstallOrigin = { kind: "checkout", root: "unknown", version: "unknown" },
) {
  return { vault, home: vault, cwd: vault, env: {}, now: new Date(), origin };
}

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
    recordEntry(installEnv(), entry);
    const m = readManifest(vault);
    expect(m.installs.cursor).toEqual({ ...entry, origin: installEnv().origin });
    const raw = readFileSync(manifestPath(vault), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("recordEntry stamps the origin supplied by the install environment", () => {
    const origin = {
      kind: "registry" as const,
      root: join(vault, "prefix/node_modules/open-second-brain"),
      version: "2.0.0",
    };
    recordEntry(installEnv(origin), {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/home/u/.cursor/mcp.json",
    });
    expect(readManifest(vault).installs.cursor?.origin).toEqual(origin);
  });

  test("a manifest entry without origin reads as a legacy checkout", () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(
      manifestPath(vault),
      JSON.stringify({
        schema_version: 1,
        installs: {
          cursor: {
            target: "cursor",
            applied_at: "2026-05-20T12:00:00.000Z",
            operation: "json-merge",
            config_path: "/home/u/.cursor/mcp.json",
          },
        },
      }),
    );
    expect(readManifest(vault).installs.cursor?.origin).toEqual({
      kind: "checkout",
      root: "unknown",
      version: "unknown",
    });
  });

  test("recordEntry overwrites existing entry for the same target", () => {
    recordEntry(installEnv(), {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(installEnv(), {
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
    recordEntry(installEnv(), {
      target: "cursor",
      applied_at: "2026-05-20T12:00:00.000Z",
      operation: "json-merge",
      config_path: "/a",
      owned_keys: ["mcpServers.open-second-brain"],
    });
    recordEntry(installEnv(), {
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
