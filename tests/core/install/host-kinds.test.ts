import { describe, expect, test } from "bun:test";
import { BOOTSTRAP_TARGETS } from "../../../src/cli/bootstrap/targets.ts";
import { HOST_KINDS } from "../../../src/core/install/host-kinds.ts";
import { INSTALL_TARGET_IDS } from "../../../src/core/runtime/host-facts.ts";

const PLUGIN_HOSTS = ["claude-code", "hermes", "openclaw", "zcode"] as const;

describe("host kinds", () => {
  test("covers each install vocabulary target and the four plugin hosts", () => {
    expect(Object.keys(HOST_KINDS).sort()).toEqual([...INSTALL_TARGET_IDS, ...PLUGIN_HOSTS].sort());
  });

  test("plugin hosts carry their install step and guide", () => {
    for (const target of PLUGIN_HOSTS) {
      const host = HOST_KINDS[target];
      expect(host?.kind).toBe("plugin");
      if (host?.kind === "plugin") {
        expect(host.step.length).toBeGreaterThan(0);
        expect(host.guide).toMatch(/^install\/.+\.md$/);
      }
    }
  });

  test("agrees with bootstrap mode for every target both tables name", () => {
    for (const target of BOOTSTRAP_TARGETS) {
      const host = HOST_KINDS[target.target as keyof typeof HOST_KINDS];
      expect(host).toBeDefined();
      expect(host?.kind).toBe(
        target.mode === "adapter" ? "adapter" : target.mode === "print" ? "print" : "plugin",
      );
    }
  });
});
