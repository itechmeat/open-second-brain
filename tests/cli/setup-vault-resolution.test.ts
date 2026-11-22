import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";

import { setupVaultForPayload } from "../../src/cli/setup.ts";
import { buildPayload } from "../../src/core/install/payload.ts";

describe("setup payload vault resolution", () => {
  test("uses configured Windows vault spelling when explicit path resolves to it", () => {
    const configuredVault = "C:/scratch/bootstrap-vault";
    const explicitVault = win32.join("C:/scratch", "bootstrap-vault");

    expect(win32.resolve(explicitVault)).toBe(win32.resolve(configuredVault));
    expect(setupVaultForPayload(explicitVault, configuredVault, "win32")).toBe(configuredVault);
    expect(
      buildPayload(
        {
          vault: setupVaultForPayload(explicitVault, configuredVault, "win32"),
          agent_name: "Registry Bootstrap",
          timezone: "UTC",
        },
        "win32",
      ),
    ).toEqual(
      buildPayload(
        { vault: configuredVault, agent_name: "Registry Bootstrap", timezone: "UTC" },
        "win32",
      ),
    );
  });

  test("keeps explicit vault when no configured vault exists", () => {
    const explicitVault = win32.join("C:/scratch", "bootstrap-vault");

    expect(setupVaultForPayload(explicitVault, null, "win32")).toBe(win32.resolve(explicitVault));
  });

  test("resolves a relative explicit vault before payload construction", () => {
    const result = setupVaultForPayload("./notes", null, "win32");

    expect(result).toBe(win32.resolve("./notes"));
    expect(win32.isAbsolute(result)).toBe(true);
  });
});
