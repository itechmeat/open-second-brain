/**
 * The human view folder: a folder inside the vault is a valid target, its
 * `Brain/` tree and the store are not, and a source of another platform
 * is resolved with that platform's path rules.
 */
import { describe, expect, test } from "bun:test";

import { resolveViewTargetFrom, ViewTargetError } from "../../../src/core/view/target.ts";

const posixSource = (target: string) => ({
  platform: "linux",
  home: "/home/u",
  env: {},
  config: { view_target: target },
  configPath: "/home/u/.config/o2b/config.yaml",
});

describe("resolveViewTargetFrom", () => {
  test("a folder of the vault is a target; its Brain/ tree is refused", () => {
    expect(resolveViewTargetFrom(posixSource("/v/Views"), "/s", "/v")?.dir).toBe("/v/Views");
    for (const target of ["/v/Brain", "/v/Brain/view"]) {
      expect(() => resolveViewTargetFrom(posixSource(target), "/s", "/v")).toThrow(ViewTargetError);
    }
  });

  test("a Windows source is resolved with Windows path rules on any host", () => {
    const source = {
      platform: "win32",
      home: "C:\\Users\\u",
      env: {},
      config: { view_target: "C:\\Views\\brain" },
      configPath: "C:\\Users\\u\\AppData\\o2b\\config.yaml",
    };
    expect(resolveViewTargetFrom(source, "D:\\Store", null)?.dir).toBe("C:\\Views\\brain");
    const home = { ...source, config: { view_target: "~\\brain-view" } };
    expect(resolveViewTargetFrom(home, "D:\\Store", null)?.dir).toBe("C:\\Users\\u\\brain-view");
  });
});
