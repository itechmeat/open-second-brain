/**
 * `brain_context` renders the scoped operator rules - one file per axis
 * under `Brain/standing-rules/{project,harness,host}/` - for the scope the
 * SERVER resolved, and only at local reach.
 *
 * Every case is an A/B probe through the real `MCPServer`: the vault with
 * a scoped file that does not match this server's scope must answer
 * byte-identically (after the generation stamp is normalised) to the same
 * vault without that file. A match renders the file after the operator
 * standing rules and before the memory body. At remote reach the layer is
 * skipped entirely: the server's working directory and device are not the
 * caller's, so the file must leave no trace on the wire.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../src/mcp/index.ts";
import type { MCPServerRuntimeOptions } from "../../src/mcp/server.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { STANDING_RULES_HEADER } from "../../src/core/brain/standing-rules.ts";
import {
  SCOPED_RULES_HEADER,
  SCOPED_RULES_HOST_UNREADABLE_NOTICE,
} from "../../src/core/brain/scoped-rules.ts";
import { resolveInstallationSecret } from "../../src/core/config.ts";
import { writeVaultPointer } from "../../src/core/brain/portability/pointer.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

let tmp: string;
let vault: string;
let projectX: string;
let projectY: string;
let configHome: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const STANDING = "Never force-push to main.";
const MARKER = "zzscopedmarkerzz keep the changelog terse";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-scoped-"));
  vault = join(tmp, "vault");
  for (const dir of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  writeFileSync(join(vault, "Brain", "standing-rules.md"), STANDING, "utf8");
  // Two linked projects whose basenames key to `proj-x` and `proj-y`.
  projectX = join(tmp, "proj-x");
  projectY = join(tmp, "proj-y");
  for (const dir of [projectX, projectY]) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeVaultPointer(dir, vault);
  }
  configHome = mkdtempSync(join(tmpdir(), "o2b-mcp-scoped-cfg-"));
  configPath = join(configHome, "config.yaml");
  for (const k of [
    "VAULT_AGENT_NAME",
    "VAULT_TIMEZONE",
    "VAULT_DIR",
    "OPEN_SECOND_BRAIN_CONFIG",
    "O2B_DEVICE_ID",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env["O2B_DEVICE_ID"] = "";
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeScoped(axis: "project" | "harness" | "host", key: string, body: string): string {
  const dir = join(vault, "Brain", "standing-rules", axis);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

async function callContext(runtime: MCPServerRuntimeOptions): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath }, runtime);
  await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "scoped-rules-test", version: "0" },
    },
  });
  await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 9,
    method: "tools/call",
    params: { name: "brain_context", arguments: {} },
  })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
  return JSON.parse(r.result.content[0]!.text);
}

/** The wire text with every generation stamp replaced, so two calls compare. */
function normalised(out: Record<string, unknown>): string {
  return JSON.stringify(out)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "<ts>")
    .replaceAll("\\\\", "/");
}

/** Call once with the file present and once with it removed; both normalised. */
async function abProbe(
  runtime: MCPServerRuntimeOptions,
  write: () => string,
): Promise<{ withFile: string; withoutFile: string }> {
  const path = write();
  const withFile = normalised(await callContext(runtime));
  rmSync(path);
  const withoutFile = normalised(await callContext(runtime));
  return { withFile, withoutFile };
}

const LOCAL = TRANSPORT_REACH.local;

interface ScopedRulesKey {
  readonly scope: {
    readonly project: string | null;
    readonly harness: string | null;
    readonly host: string | null;
  };
  readonly files: ReadonlyArray<{ path: string; axis: string; truncated: boolean }>;
}

describe("brain_context scoped rules - project axis", () => {
  test("a file for another project leaves the answer byte-identical", async () => {
    const { withFile, withoutFile } = await abProbe(
      { reach: LOCAL, workspaceDir: join(projectY, "src") },
      () => writeScoped("project", "proj-x", MARKER),
    );
    expect(withFile).not.toContain("zzscopedmarkerzz");
    expect(withFile).toBe(withoutFile);
  });

  test("the matching project renders after the standing rules and before the memory body", async () => {
    writeScoped("project", "proj-x", MARKER);
    const out = await callContext({ reach: LOCAL, workspaceDir: join(projectX, "src") });
    const content = out["content"] as string;
    const standingAt = content.indexOf(STANDING_RULES_HEADER);
    const scopedAt = content.indexOf(SCOPED_RULES_HEADER);
    const markerAt = content.indexOf("zzscopedmarkerzz");
    const bodyAt = content.indexOf("# Active Brain Preferences");
    expect(standingAt).toBe(0);
    expect(scopedAt).toBeGreaterThan(standingAt);
    expect(markerAt).toBeGreaterThan(scopedAt);
    expect(content).toContain("### Project: proj-x");
    expect(bodyAt).toBeGreaterThan(markerAt);
    const field = out["scoped_rules"] as ScopedRulesKey;
    expect(field.scope).toEqual({ project: "proj-x", harness: null, host: null });
    expect(field.files).toEqual([
      { path: "Brain/standing-rules/project/proj-x.md", axis: "project", truncated: false },
    ]);
  });

  test("no matching file omits the key and adds no block", async () => {
    const out = await callContext({ reach: LOCAL, workspaceDir: join(projectX, "src") });
    expect("scoped_rules" in out).toBe(false);
    expect(out["content"] as string).not.toContain(SCOPED_RULES_HEADER);
  });

  test("the absolute vault path never appears in the scoped block", async () => {
    writeScoped("project", "proj-x", MARKER);
    const out = await callContext({ reach: LOCAL, workspaceDir: projectX });
    const content = out["content"] as string;
    const block = content.slice(content.indexOf(SCOPED_RULES_HEADER));
    expect(block).not.toContain(vault);
    // JSON escapes a Windows backslash: compare against the escaped form too.
    const field = JSON.stringify(out["scoped_rules"]);
    expect(field).not.toContain(vault);
    expect(field).not.toContain(JSON.stringify(vault).slice(1, -1));
  });
});

describe("brain_context scoped rules - harness axis", () => {
  test("a file for another harness leaves the answer byte-identical", async () => {
    const { withFile, withoutFile } = await abProbe({ reach: LOCAL, harness: "codex" }, () =>
      writeScoped("harness", "cursor", MARKER),
    );
    expect(withFile).not.toContain("zzscopedmarkerzz");
    expect(withFile).toBe(withoutFile);
  });

  test("the launch harness renders its file", async () => {
    writeScoped("harness", "cursor", MARKER);
    const out = await callContext({ reach: LOCAL, harness: "cursor" });
    expect(out["content"] as string).toContain("### Harness: cursor");
    expect(out["content"] as string).toContain("zzscopedmarkerzz");
    expect((out["scoped_rules"] as ScopedRulesKey).scope.harness).toBe("cursor");
  });

  test("the host target is the harness when no --harness was given", async () => {
    writeScoped("harness", "cursor", MARKER);
    const out = await callContext({ reach: LOCAL, hostTarget: "cursor" });
    expect(out["content"] as string).toContain("zzscopedmarkerzz");
  });
});

describe("brain_context scoped rules - host axis", () => {
  test("a file for another device leaves the answer byte-identical", async () => {
    process.env["O2B_DEVICE_ID"] = "aaaa0001";
    const { withFile, withoutFile } = await abProbe({ reach: LOCAL }, () =>
      writeScoped("host", "bbbb0002", MARKER),
    );
    expect(withFile).not.toContain("zzscopedmarkerzz");
    expect(withFile).toBe(withoutFile);
  });

  test("this device's file renders", async () => {
    process.env["O2B_DEVICE_ID"] = "aaaa0001";
    writeScoped("host", "aaaa0001", MARKER);
    const out = await callContext({ reach: LOCAL });
    expect(out["content"] as string).toContain("### Host: aaaa0001");
    const field = out["scoped_rules"] as ScopedRulesKey;
    expect(field.scope.host).toBe("aaaa0001");
    expect(field.files.map((f) => f.path)).toEqual(["Brain/standing-rules/host/aaaa0001.md"]);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a device id that cannot be stored renders the host notice and the key",
    async () => {
      // The config is readable and holds no device id, and its directory
      // cannot be written, so the first-use id cannot be persisted: the
      // call still succeeds and says host-scoped rules were not applied.
      delete process.env["O2B_DEVICE_ID"];
      resolveInstallationSecret(configPath);
      writeScoped("host", "aaaa0001", MARKER);
      chmodSync(configHome, 0o555);
      try {
        const out = await callContext({ reach: LOCAL });
        expect(out["content"] as string).toContain(SCOPED_RULES_HOST_UNREADABLE_NOTICE);
        expect(out["content"] as string).not.toContain(MARKER);
        const field = out["scoped_rules"] as ScopedRulesKey;
        expect(field.scope.host).toBeNull();
        expect(field.files).toEqual([]);
      } finally {
        chmodSync(configHome, 0o755);
      }
    },
  );

  test("the empty device id opts out silently", async () => {
    process.env["O2B_DEVICE_ID"] = "";
    const { withFile, withoutFile } = await abProbe({ reach: LOCAL }, () =>
      writeScoped("host", "aaaa0001", MARKER),
    );
    expect(withFile).toBe(withoutFile);
  });
});

describe("brain_context scoped rules - remote reach", () => {
  test("a matching project file leaves no trace at remote reach", async () => {
    const { withFile, withoutFile } = await abProbe(
      { workspaceDir: projectX, harness: "cursor" },
      () => writeScoped("project", "proj-x", MARKER),
    );
    expect(withFile).not.toContain("zzscopedmarkerzz");
    expect(withFile).not.toContain("scoped_rules");
    expect(withFile).toBe(withoutFile);
  });

  test("a matching harness and host file leave no trace at remote reach", async () => {
    process.env["O2B_DEVICE_ID"] = "aaaa0001";
    const { withFile, withoutFile } = await abProbe({ harness: "cursor" }, () => {
      writeScoped("host", "aaaa0001", MARKER);
      return writeScoped("harness", "cursor", MARKER);
    });
    // The host file is still on disk in the B arm: remove it too so the
    // probe compares the vault with neither file against both.
    expect(withFile).not.toContain("zzscopedmarkerzz");
    rmSync(join(vault, "Brain", "standing-rules"), { recursive: true, force: true });
    const bare = normalised(await callContext({ harness: "cursor" }));
    expect(withFile).toBe(bare);
    expect(withoutFile).toBe(bare);
  });
});

describe("brain_context scoped rules - gaps closed by the test audit", () => {
  test("the configured cap trims the block and marks the file truncated", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  scoped_rules_max_chars: 200\n",
    );
    writeScoped("project", "proj-x", `${MARKER} ${"x".repeat(5000)}`);
    const out = await callContext({ reach: LOCAL, workspaceDir: projectX });
    expect(out["content"] as string).toContain("_Scoped rules truncated to the configured cap:");
    expect((out["scoped_rules"] as ScopedRulesKey).files).toEqual([
      { path: "Brain/standing-rules/project/proj-x.md", axis: "project", truncated: true },
    ]);
  });

  test("remote reach with every axis matching leaves no trace", async () => {
    process.env["O2B_DEVICE_ID"] = "aaaa0001";
    writeScoped("project", "proj-x", MARKER);
    writeScoped("host", "aaaa0001", MARKER);
    writeScoped("harness", "cursor", MARKER);
    const runtime = { workspaceDir: projectX, harness: "cursor" as const };
    const withFiles = normalised(await callContext(runtime));
    rmSync(join(vault, "Brain", "standing-rules"), { recursive: true, force: true });
    expect(withFiles).not.toContain("zzscopedmarkerzz");
    expect(withFiles).toBe(normalised(await callContext(runtime)));
  });
});

describe("brain_context scoped rules - a symlink leaving the vault", () => {
  test.skipIf(!canSymlink())(
    "a symlinked axis folder renders the UNAVAILABLE line and keeps the constitution",
    async () => {
      const outside = mkdtempSync(join(tmp, "outside-"));
      writeFileSync(join(outside, "proj-x.md"), "zzoutsidezz");
      mkdirSync(join(vault, "Brain", "standing-rules"), { recursive: true });
      symlinkSync(outside, join(vault, "Brain", "standing-rules", "project"), "dir");
      const out = await callContext({ reach: LOCAL, workspaceDir: projectX });
      const content = out["content"] as string;
      expect(content).toContain(STANDING);
      expect(content).toContain(
        "UNAVAILABLE: Brain/standing-rules/project/proj-x.md could not be read (ESCAPE).",
      );
      expect(content).not.toContain("zzoutsidezz");
      expect(content).not.toContain(vault);
      expect(JSON.stringify(content)).not.toContain(JSON.stringify(vault).slice(1, -1));
    },
  );
});

/** Symlinks need a privilege Windows CI does not grant; probe once per call. */
function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "o2b-symlink-probe-"));
  try {
    symlinkSync(join(dir, "missing"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
