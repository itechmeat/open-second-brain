/**
 * Canonical vault-relative note identity (Unit 2 / identity core of the
 * Vault Integrity & Trust suite). A note's identity must be one value
 * regardless of the device that produced the path: macOS (APFS/HFS+)
 * stores filenames as Unicode NFD, Linux/Android as NFC, so the same
 * note has byte-different vault-relative paths across a Syncthing peer
 * set. `canonicalNotePath` collapses those to one POSIX + NFC identity
 * so cross-device change detection and provenance stamping never split
 * one note into two.
 */

import { describe, expect, test } from "bun:test";

import { canonicalNotePath } from "../../src/core/path-safety.ts";

// "e-acute" two ways, derived with String#normalize so the two byte
// sequences are unambiguous regardless of how this source file is itself
// normalized on disk: NFC is a single precomposed U+00E9, NFD is "e" +
// U+0301 combining acute. macOS stores the NFD form on disk; Linux NFC.
const E_NFC = "é".normalize("NFC");
const E_NFD = "é".normalize("NFD");
const NFC_NAME = `caf${E_NFC}.md`;
const NFD_NAME = `caf${E_NFD}.md`;

describe("canonicalNotePath", () => {
  test("NFD and NFC inputs differ on the wire (test fixture sanity)", () => {
    expect(NFD_NAME).not.toBe(NFC_NAME);
  });

  test("collapses NFD and NFC forms of the same name to one identity", () => {
    expect(canonicalNotePath(NFD_NAME)).toBe(canonicalNotePath(NFC_NAME));
  });

  test("canonical form is NFC", () => {
    expect(canonicalNotePath(NFD_NAME)).toBe(NFC_NAME);
  });

  test("is idempotent on an already-NFC POSIX path (byte-identical)", () => {
    const p = `Notes/projects/caf${E_NFC}.md`;
    expect(canonicalNotePath(p)).toBe(p);
  });

  test("leaves a plain ASCII path byte-identical", () => {
    const p = "Brain/preferences/pref-x.md";
    expect(canonicalNotePath(p)).toBe(p);
  });

  test("normalizes a decomposed path component inside a nested directory", () => {
    expect(canonicalNotePath(`Notes/${NFD_NAME}`)).toBe(`Notes/${NFC_NAME}`);
  });
});
