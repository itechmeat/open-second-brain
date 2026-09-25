/**
 * `isWindowsStoreAliasStub`: the Microsoft Store's `python.exe` placeholder
 * is "no interpreter", not "a broken interpreter". Platform and lookup are
 * injected, so the rule is pinned on any host.
 */

import { describe, expect, test } from "bun:test";

import { isWindowsStoreAliasStub } from "../../src/core/doctor-hermes-parity.ts";

const STUB = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";

describe("isWindowsStoreAliasStub", () => {
  test("a name that resolves into WindowsApps is the Store placeholder", () => {
    expect(isWindowsStoreAliasStub("python", "win32", () => STUB)).toBe(true);
    expect(isWindowsStoreAliasStub("python3", "win32", () => STUB.toLowerCase())).toBe(true);
    expect(isWindowsStoreAliasStub("python", "win32", () => STUB.replaceAll("\\", "/"))).toBe(true);
  });

  test("a real interpreter anywhere else is not", () => {
    expect(isWindowsStoreAliasStub("python", "win32", () => "C:\\Python312\\python.exe")).toBe(
      false,
    );
    // A directory that merely CONTAINS the words is not the alias directory.
    expect(
      isWindowsStoreAliasStub("python", "win32", () => "C:\\MicrosoftWindowsApps\\python.exe"),
    ).toBe(false);
  });

  test("a name that does not resolve is not a stub", () => {
    expect(isWindowsStoreAliasStub("python", "win32", () => null)).toBe(false);
  });

  test("never off Windows, whatever the lookup says", () => {
    let asked = false;
    const which = () => {
      asked = true;
      return STUB;
    };
    expect(isWindowsStoreAliasStub("python", "linux", which)).toBe(false);
    expect(isWindowsStoreAliasStub("python", "darwin", which)).toBe(false);
    expect(asked).toBe(false);
  });
});
