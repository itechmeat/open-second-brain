/**
 * The no-vault rule's helpers (design D14, task 2.10): every spelling of
 * "no vault" (null, a blank string, the lanes' stand-in root) is refused
 * by name before a legacy-tree branch can build a path under it, and a
 * vault-free reader never passes an absolute device path on as a page
 * path.
 */
import { describe, expect, test } from "bun:test";

import {
  LegacyTreeWithoutVaultError,
  legacyVaultOf,
  vaultRelativeOf,
} from "../../../src/core/brain/no-vault.ts";
import { noVaultRoot } from "../../../src/core/platform-dirs.ts";

describe("legacyVaultOf", () => {
  test("refuses null, a blank vault and the stand-in root", () => {
    for (const vault of [null, "", "   ", noVaultRoot()]) {
      expect(() => legacyVaultOf(vault, "site")).toThrow(LegacyTreeWithoutVaultError);
    }
    expect(legacyVaultOf("/v", "site")).toBe("/v");
  });
});

describe("vaultRelativeOf with no vault", () => {
  test("passes a page path on with forward slashes and refuses an absolute one", () => {
    expect(vaultRelativeOf("Brain\\inbox\\sig-a.md", null)).toBe("Brain/inbox/sig-a.md");
    expect(() => vaultRelativeOf("/home/u/state/no-vault/Brain/x.md", null)).toThrow(
      LegacyTreeWithoutVaultError,
    );
    expect(() => vaultRelativeOf("C:\\Users\\u\\x.md", null)).toThrow(LegacyTreeWithoutVaultError);
  });
});
