import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConfigPathEnv } from "../../../src/core/config.ts";
import {
  buildPayload,
  launcherCommand,
  PayloadError,
  shouldIncludeConfigPath,
} from "../../../src/core/install/payload.ts";

describe("buildPayload", () => {
  test("compares config path against server default without config env overrides", () => {
    const source: ConfigPathEnv = {
      platform: "linux",
      home: "/host/home",
      env: {
        HOME: "/host/home",
        XDG_CONFIG_HOME: "/setup/xdg",
        OPEN_SECOND_BRAIN_CONFIG: "/setup/config.yaml",
      },
    };
    expect(
      shouldIncludeConfigPath("/host/home/.config/open-second-brain/config.yaml", source),
    ).toBe(false);
    expect(shouldIncludeConfigPath("/setup/xdg/open-second-brain/config.yaml", source)).toBe(true);
  });

  test("returns full + writer entries with vault arg", () => {
    const { full, writer } = buildPayload(
      {
        vault: "/home/u/vault",
        agent_name: "claude-vps",
        timezone: "Europe/Belgrade",
      },
      "linux",
    );
    expect(full.command).toBe("o2b");
    expect(full.args).toEqual(["mcp", "--vault", "/home/u/vault"]);
    expect(writer.command).toBe("o2b");
    expect(writer.args).toEqual(["mcp", "--writer-only", "--vault", "/home/u/vault"]);
  });

  test("includes env when agent_name + timezone present", () => {
    // POSIX: the Windows entry adds its launcher environment on top
    // (tests/core/install/payload-windows.test.ts).
    const { full, writer } = buildPayload(
      {
        vault: "/v",
        agent_name: "a",
        timezone: "UTC",
      },
      "linux",
    );
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" });
    expect(writer.env).toEqual({ VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" });
  });

  test("omits env entirely when both agent_name and timezone are null", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: null, timezone: null }, "linux");
    expect(full.env).toBeUndefined();
  });

  test("partial env: only agent_name", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: "a", timezone: null }, "linux");
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "a" });
  });

  test("partial env: only timezone", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: null, timezone: "UTC" }, "linux");
    expect(full.env).toEqual({ VAULT_TIMEZONE: "UTC" });
  });

  test("omits --vault for a store-only machine and rejects a non-string vault", () => {
    const { full, writer } = buildPayload({ vault: "", agent_name: null, timezone: null });
    const launcher = launcherCommand();
    expect(full.command).toBe(launcher.command);
    expect(full.args).toEqual([...launcher.prefix, "mcp"]);
    expect(writer.command).toBe(launcher.command);
    expect(writer.args).toEqual([...launcher.prefix, "mcp", "--writer-only"]);
    expect(() =>
      buildPayload({ vault: null as unknown as string, agent_name: null, timezone: null }),
    ).toThrow(PayloadError);
  });

  test("carries a non-default config path but leaves the default payload unchanged", () => {
    const configured = join("tmp", "alternate-config.yaml");
    const { full: alternate } = buildPayload(
      {
        vault: "",
        agent_name: null,
        timezone: null,
        configPath: configured,
      },
      "linux",
    );
    expect(alternate.env?.["OPEN_SECOND_BRAIN_CONFIG"]).toBe(resolve(configured));
    const { full: defaultPayload } = buildPayload(
      {
        vault: "",
        agent_name: null,
        timezone: null,
        configPath: join(homedir(), ".config", "open-second-brain", "config.yaml"),
      },
      "linux",
    );
    expect(defaultPayload.env).toBeUndefined();
  });

  test("allows cmd metacharacters for registry launchers on Windows", () => {
    const origin = {
      kind: "registry" as const,
      root: join("C:", "Research & Notes", "node_modules", "open-second-brain"),
      version: "1.0.0",
    };
    expect(() =>
      buildPayload(
        { vault: "C:\\Research & Notes\\vault", agent_name: null, timezone: null, origin },
        "win32",
      ),
    ).not.toThrow();
    expect(() =>
      buildPayload(
        { vault: "C:\\Research & Notes\\vault", agent_name: null, timezone: null },
        "win32",
      ),
    ).toThrow(PayloadError);
  });

  test("writer args carry --writer-only before --vault", () => {
    const { writer } = buildPayload({ vault: "/v", agent_name: null, timezone: null });
    expect(writer.args.indexOf("--writer-only")).toBeLessThan(writer.args.indexOf("--vault"));
  });
});
