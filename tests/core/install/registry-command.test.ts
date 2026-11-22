import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokMcpServers } from "../../../src/core/install/grok-asset.ts";
import { HOST_PAYLOAD_TARGETS, payloadForHost } from "../../../src/core/install/payload-host.ts";
import { buildPayload, cliArgs } from "../../../src/core/install/payload.ts";
import type { InstallOrigin } from "../../../src/core/install/origin.ts";

// Paths only: nothing here touches the file system.
const scratch = join(tmpdir(), "registry-command");
const origin: InstallOrigin = {
  kind: "registry",
  root: join(scratch, "global", "node_modules", "open-second-brain"),
  version: "2.0.0",
};

describe("registry command payload", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    test(`uses the absolute Bun and package launcher on ${platform}`, () => {
      const { full, writer } = buildPayload(
        { vault: "/scratch/vault", agent_name: null, timezone: null, origin },
        platform,
      );
      const launcher = join(origin.root, "bin", "o2b.js");
      const expected = ["run", launcher, "mcp"];
      expect(full.command).toBe(process.execPath);
      expect(full.args).toEqual([...expected, "--vault", "/scratch/vault"]);
      expect(writer.command).toBe(process.execPath);
      expect(writer.args).toEqual([
        "run",
        launcher,
        "mcp",
        "--writer-only",
        "--vault",
        "/scratch/vault",
      ]);
    });
  }

  test("Grok removes the registry launcher head from its own command shape", () => {
    const registryHead = ["run", join(origin.root, "bin", "o2b.js")];
    const payload = {
      full: {
        command: process.execPath,
        args: [...registryHead, "mcp", "--vault", "/scratch/vault"],
        env: { VAULT_AGENT_NAME: "operator", VAULT_TIMEZONE: "UTC" },
      },
      writer: {
        command: process.execPath,
        args: [...registryHead, "mcp", "--writer-only", "--vault", "/scratch/vault"],
        env: { VAULT_AGENT_NAME: "operator", VAULT_TIMEZONE: "UTC" },
      },
    };
    const grok = grokMcpServers(payload);
    expect(grok["open-second-brain"]!.command).toBe(process.execPath);
    expect(grok["open-second-brain"]!.args).toEqual([
      "run",
      join(import.meta.dir, "../../../src/cli/main.ts"),
      "mcp",
      "--vault",
      "/scratch/vault",
    ]);
    expect(grok["open-second-brain"]!.args).not.toContain(join(origin.root, "bin", "o2b.js"));
  });

  test("cliArgs strips the registry launcher head", () => {
    expect(
      cliArgs({
        command: process.execPath,
        args: ["run", join(origin.root, "bin", "o2b.js"), "mcp", "--vault", "/scratch/vault"],
      }),
    ).toEqual(["mcp", "--vault", "/scratch/vault"]);
  });

  test("plugin-cache origin keeps the checkout command bytes", () => {
    const pluginOrigin = { ...origin, kind: "plugin-cache" as const };
    const { full, writer } = buildPayload(
      { vault: "/scratch/vault", agent_name: null, timezone: null, origin: pluginOrigin },
      "linux",
    );
    expect(full).toEqual({ command: "o2b", args: ["mcp", "--vault", "/scratch/vault"] });
    expect(writer).toEqual({
      command: "o2b",
      args: ["mcp", "--writer-only", "--vault", "/scratch/vault"],
    });
  });

  test("every declared canonical-command host keeps the registry head", () => {
    const payload = buildPayload(
      { vault: "/scratch/vault", agent_name: null, timezone: null, origin },
      "linux",
    );
    const env = {
      vault: "/scratch/vault",
      home: scratch,
      cwd: scratch,
      env: {},
      now: new Date(),
      origin,
    };
    for (const target of HOST_PAYLOAD_TARGETS) {
      const written = payloadForHost(target, payload, env);
      expect(written.full.command).toBe(process.execPath);
      expect(written.full.args.slice(0, 2)).toEqual(["run", join(origin.root, "bin", "o2b.js")]);
      expect(written.writer.command).toBe(process.execPath);
      expect(written.writer.args.slice(0, 2)).toEqual(["run", join(origin.root, "bin", "o2b.js")]);
    }
  });

  test("a store-only machine omits --vault for every canonical-command host", () => {
    const payload = buildPayload({ vault: "", agent_name: null, timezone: null, origin });
    expect(payload.full.args).toEqual(["run", join(origin.root, "bin", "o2b.js"), "mcp"]);
    expect(payload.writer.args).toEqual([
      "run",
      join(origin.root, "bin", "o2b.js"),
      "mcp",
      "--writer-only",
    ]);
    const env = {
      vault: "",
      home: scratch,
      cwd: scratch,
      env: {},
      now: new Date(),
      origin,
    };
    for (const target of HOST_PAYLOAD_TARGETS) {
      const written = payloadForHost(target, payload, env);
      expect(written.full.args).not.toContain("--vault");
      expect(written.writer.args).not.toContain("--vault");
    }
    const grok = grokMcpServers(payload);
    expect(grok["open-second-brain"]!.args).toContain("mcp");
    expect(grok["open-second-brain"]!.args).not.toContain(join(origin.root, "bin", "o2b.js"));
    expect(grok["open-second-brain"]!.args).not.toContain("--vault");
  });
});
