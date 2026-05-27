import { describe, expect, test } from "bun:test";
import { buildPayload, PayloadError } from "../../../src/core/install/payload.ts";

describe("buildPayload", () => {
  test("returns full + writer entries with vault arg", () => {
    const { full, writer } = buildPayload({
      vault: "/home/u/vault",
      agent_name: "claude-vps",
      timezone: "Europe/Belgrade",
    });
    expect(full.command).toBe("o2b");
    expect(full.args).toEqual(["mcp", "--vault", "/home/u/vault"]);
    expect(writer.command).toBe("o2b");
    expect(writer.args).toEqual(["mcp", "--writer-only", "--vault", "/home/u/vault"]);
  });

  test("includes env when agent_name + timezone present", () => {
    const { full, writer } = buildPayload({
      vault: "/v",
      agent_name: "a",
      timezone: "UTC",
    });
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" });
    expect(writer.env).toEqual({ VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" });
  });

  test("omits env entirely when both agent_name and timezone are null", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: null, timezone: null });
    expect(full.env).toBeUndefined();
  });

  test("partial env: only agent_name", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: "a", timezone: null });
    expect(full.env).toEqual({ VAULT_AGENT_NAME: "a" });
  });

  test("partial env: only timezone", () => {
    const { full } = buildPayload({ vault: "/v", agent_name: null, timezone: "UTC" });
    expect(full.env).toEqual({ VAULT_TIMEZONE: "UTC" });
  });

  test("throws PayloadError on missing vault", () => {
    expect(() => buildPayload({ vault: "", agent_name: null, timezone: null })).toThrow(
      PayloadError,
    );
    expect(() =>
      buildPayload({ vault: null as unknown as string, agent_name: null, timezone: null }),
    ).toThrow(PayloadError);
  });

  test("writer args carry --writer-only before --vault", () => {
    const { writer } = buildPayload({ vault: "/v", agent_name: null, timezone: null });
    expect(writer.args.indexOf("--writer-only")).toBeLessThan(writer.args.indexOf("--vault"));
  });
});
