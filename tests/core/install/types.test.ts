import { describe, expect, test } from "bun:test";
import {
  ADAPTER_STATUSES,
  INSTALL_STEP_KINDS,
  VERIFY_STATUSES,
  InstallError,
} from "../../../src/core/install/types.ts";

describe("install types", () => {
  test("ADAPTER_STATUSES covers the four documented states", () => {
    expect(new Set(ADAPTER_STATUSES)).toEqual(
      new Set(["not-installed", "installed", "drift", "unsupported-on-this-platform"]),
    );
  });

  test("INSTALL_STEP_KINDS covers the six operation kinds", () => {
    expect(new Set(INSTALL_STEP_KINDS)).toEqual(
      new Set(["json-merge", "managed-block", "subprocess", "file-copy", "symlink", "print"]),
    );
  });

  test("VERIFY_STATUSES covers the four documented states", () => {
    expect(new Set(VERIFY_STATUSES)).toEqual(
      new Set(["ok", "drift", "not-installed", "mcp-unreachable"]),
    );
  });

  test("InstallError carries target + kind + hint", () => {
    const err = new InstallError("nope", "cursor", "user-modified-block", "run with --force");
    expect(err.target).toBe("cursor");
    expect(err.kind).toBe("user-modified-block");
    expect(err.hint).toBe("run with --force");
    expect(err.message).toBe("nope");
  });
});
