/**
 * Shared derived-artifact IO helper (recall-quality wave, S2).
 *
 * The co-occurrence and search-tuning artifacts shipped one convention
 * twice: a schema-versioned, dataset-hashed JSON file under `Brain/`,
 * re-validated on read, failing soft to null. This suite pins the
 * extracted helper both halves now share - round-trip, torn JSON,
 * schema mismatch, dataset-hash expiry, atomic write, and the
 * vault-identity write guard - mirroring the tuning-store test family.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveDatasetHash,
  readDerivedArtifact,
  writeDerivedArtifact,
} from "../../../src/core/brain/derived-artifact.ts";
import {
  resetVaultIdentityPins,
  VaultIdentityMismatchError,
} from "../../../src/core/brain/vault-identity.ts";

interface TestArtifact {
  schema: string;
  generated_at: string;
  dataset_hash: string;
  items: string[];
}

const REL = join("Brain", "derived", "test-artifact.json");
const SCHEMA = "o2b.test.v1";
const HASH = "a".repeat(64);

function artifact(overrides: Partial<TestArtifact> = {}): TestArtifact {
  return {
    schema: SCHEMA,
    generated_at: "2026-10-11T00:00:00.000Z",
    dataset_hash: HASH,
    items: ["alpha", "beta"],
    ...overrides,
  };
}

let vault: string;

beforeEach(() => {
  // Vault-identity pins are keyed by resolved root; tests run many vaults
  // in one process, so every test starts unpinned.
  resetVaultIdentityPins();
  vault = mkdtempSync(join(tmpdir(), "o2b-derived-artifact-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("deriveDatasetHash", () => {
  test("is a sha256 hex digest, independent of input order", () => {
    const hash = deriveDatasetHash(["beta", "alpha"]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(deriveDatasetHash(["alpha", "beta"]));
  });

  test("hashes the input SET: duplicates collapse", () => {
    expect(deriveDatasetHash(["alpha", "alpha", "beta"])).toBe(
      deriveDatasetHash(["alpha", "beta"]),
    );
  });

  test("different input sets hash differently", () => {
    expect(deriveDatasetHash(["alpha", "beta"])).not.toBe(deriveDatasetHash(["alpha", "gamma"]));
  });

  test("the empty set hashes stably", () => {
    expect(deriveDatasetHash([])).toBe(deriveDatasetHash([]));
    expect(deriveDatasetHash([])).not.toBe(deriveDatasetHash(["alpha"]));
  });
});

describe("writeDerivedArtifact", () => {
  test("writes pretty-printed JSON with a trailing newline, creating parent dirs", () => {
    writeDerivedArtifact(vault, REL, artifact());
    const path = join(vault, REL);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as TestArtifact;
    expect(parsed.schema).toBe(SCHEMA);
    expect(parsed.generated_at).toBe("2026-10-11T00:00:00.000Z");
    expect(parsed.dataset_hash).toBe(HASH);
    expect(parsed.items).toEqual(["alpha", "beta"]);
  });

  test("an overwrite leaves a complete document and no temp residue", () => {
    writeDerivedArtifact(vault, REL, artifact({ items: ["first"] }));
    writeDerivedArtifact(vault, REL, artifact({ items: ["second"] }));
    const dir = join(vault, "Brain", "derived");
    // The atomic writer renames a sibling temp file over the target: the
    // directory holds the artifact and nothing else, and the bytes under
    // the name are always one complete JSON document, never a hybrid.
    expect(readdirSync(dir).toSorted()).toEqual([REL.split(/[\\/]/).pop()!]);
    expect(JSON.parse(readFileSync(join(vault, REL), "utf8"))).toEqual(
      artifact({ items: ["second"] }),
    );
  });

  test("refuses a relPath that escapes the vault", () => {
    expect(() => writeDerivedArtifact(vault, join("..", "evil.json"), artifact())).toThrow();
  });

  test("throws VaultIdentityMismatchError when the marker changes under the process", () => {
    // First write: no marker exists, absence warns but proceeds.
    writeDerivedArtifact(vault, REL, artifact({ items: ["one"] }));
    // A marker appears and the second write pins its id.
    const markerPath = join(vault, "Brain", "vault-id.json");
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        schema_version: 1,
        vault_id: "id-a",
        created_at: "2026-10-11T00:00:00.000Z",
      }),
      "utf8",
    );
    writeDerivedArtifact(vault, REL, artifact({ items: ["two"] }));
    // The store changes underneath the live process: refuse.
    writeFileSync(
      markerPath,
      JSON.stringify({
        schema_version: 1,
        vault_id: "id-b",
        created_at: "2026-10-11T00:00:00.000Z",
      }),
      "utf8",
    );
    expect(() => writeDerivedArtifact(vault, REL, artifact({ items: ["three"] }))).toThrow(
      VaultIdentityMismatchError,
    );
  });
});

describe("readDerivedArtifact", () => {
  test("round-trips the written artifact, payload fields included", () => {
    writeDerivedArtifact(vault, REL, artifact());
    const reloaded = readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.schema).toBe(SCHEMA);
    expect(reloaded!.generated_at).toBe("2026-10-11T00:00:00.000Z");
    expect(reloaded!.dataset_hash).toBe(HASH);
    expect(reloaded!.items).toEqual(["alpha", "beta"]);
  });

  test("a missing file reads as null (fail-open)", () => {
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("torn JSON reads as null (fail-open)", () => {
    mkdirSync(join(vault, "Brain", "derived"), { recursive: true });
    writeFileSync(join(vault, REL), "{not json", "utf8");
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("a non-object document reads as null (fail-open)", () => {
    mkdirSync(join(vault, "Brain", "derived"), { recursive: true });
    writeFileSync(join(vault, REL), "[1,2]", "utf8");
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("a schema mismatch reads as null (fail-open)", () => {
    writeDerivedArtifact(vault, REL, artifact({ schema: "o2b.test.v999" }));
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("dataset-hash expiry reads as null (fail-open)", () => {
    writeDerivedArtifact(vault, REL, artifact({ dataset_hash: "stale" }));
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("a missing generated_at reads as null (fail-open)", () => {
    mkdirSync(join(vault, "Brain", "derived"), { recursive: true });
    writeFileSync(join(vault, REL), JSON.stringify({ schema: SCHEMA, dataset_hash: HASH }), "utf8");
    expect(readDerivedArtifact<TestArtifact>(vault, REL, SCHEMA, HASH)).toBeNull();
  });

  test("a relPath escaping the vault reads as null, not a throw", () => {
    expect(
      readDerivedArtifact<TestArtifact>(vault, join("..", "evil.json"), SCHEMA, HASH),
    ).toBeNull();
  });
});
