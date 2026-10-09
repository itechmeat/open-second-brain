/**
 * The extraction-contract fingerprint (t_586d5d8b). The manifest gates
 * re-ingest on bytes alone, so changed extraction settings left `unchanged`
 * sources answering with extraction shaped by the old contract. The
 * fingerprint names the contract so the manifest can record it and the
 * planner can refuse to skip under a changed one. These tests pin the
 * fingerprint's PURITY: no clock, no absolute paths, no per-call options -
 * the vault's config text and the version constant are the whole input, so a
 * recorded fingerprint means the same contract on every machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXTRACT_CONTRACT_VERSION,
  computeExtractionContractFingerprint,
  extractionContractFingerprint,
} from "../../../../src/core/brain/ingest/contract.ts";
import { tempDirs } from "../../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

function vaultWithSchema(schemaBlock: string | null): string {
  const vault = mkTemp("o2b-contract-vault-");
  if (schemaBlock !== null) {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(join(vault, "Brain", "_brain.yaml"), schemaBlock, "utf8");
  }
  return vault;
}

describe("computeExtractionContractFingerprint", () => {
  test("is 16 lowercase hex characters", () => {
    const fp = computeExtractionContractFingerprint(vaultWithSchema(null));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable across calls - no clock in the input", () => {
    const vault = vaultWithSchema(null);
    expect(computeExtractionContractFingerprint(vault)).toBe(
      computeExtractionContractFingerprint(vault),
    );
  });

  test("is free of absolute paths: two vaults with identical config fingerprint identically", () => {
    // Different temp dirs, byte-identical config text: the only way the two
    // fingerprints can match is if no absolute path leaks into the digest.
    const schema = "schema_version: 1\nschema:\n  extractable:\n    - paper\n";
    const a = vaultWithSchema(schema);
    const b = vaultWithSchema(schema);
    expect(computeExtractionContractFingerprint(a)).toBe(computeExtractionContractFingerprint(b));
  });

  test("takes no per-call options: the vault is the only argument", () => {
    // Purity pinned at the signature: options like `pre_extract`,
    // `extensions`, `exclude` and the batch caps shape one planning call, not
    // the contract a stored page was extracted under, so none is accepted.
    expect(computeExtractionContractFingerprint.length).toBe(1);
  });

  test("changes when the extractable allowlist changes", () => {
    const bare = computeExtractionContractFingerprint(vaultWithSchema(null));
    const withAllowlist = computeExtractionContractFingerprint(
      vaultWithSchema("schema_version: 1\nschema:\n  extractable:\n    - paper\n"),
    );
    const wider = computeExtractionContractFingerprint(
      vaultWithSchema("schema_version: 1\nschema:\n  extractable:\n    - paper\n    - memo\n"),
    );
    expect(withAllowlist).not.toBe(bare);
    expect(wider).not.toBe(withAllowlist);
  });

  test("is insensitive to the allowlist's spelling order (sorted before hashing)", () => {
    const one = computeExtractionContractFingerprint(
      vaultWithSchema("schema_version: 1\nschema:\n  extractable:\n    - memo\n    - paper\n"),
    );
    const two = computeExtractionContractFingerprint(
      vaultWithSchema("schema_version: 1\nschema:\n  extractable:\n    - paper\n    - memo\n"),
    );
    expect(one).toBe(two);
  });
});

describe("extractionContractFingerprint (the pure combiner)", () => {
  const ALLOWLIST = ["memo", "paper"];

  test("changes when the contract version bumps", () => {
    const current = extractionContractFingerprint(EXTRACT_CONTRACT_VERSION, ALLOWLIST);
    const bumped = extractionContractFingerprint(EXTRACT_CONTRACT_VERSION + 1, ALLOWLIST);
    expect(bumped).not.toBe(current);
  });

  test("sorts the allowlist before hashing", () => {
    expect(extractionContractFingerprint(1, ALLOWLIST)).toBe(
      extractionContractFingerprint(1, [...ALLOWLIST].reverse()),
    );
  });
});
