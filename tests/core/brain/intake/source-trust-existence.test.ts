/**
 * Intake trust requires bytes behind the source (GitHub #160).
 *
 * `classifySourceTrust` decided trusted-versus-quarantined from the SHAPE of a
 * caller-supplied string and never asked whether the file was there. The
 * caller is the same agent that extracted the entities from the material being
 * classified, so a prompt injection in that material only had to tell the
 * agent what to report: a vault-shaped path that names nothing lands the
 * extraction trusted and active, beside the operator's own records.
 *
 * The rule pinned here is that a source identity buys trust only when it
 * resolves to a readable file inside the vault. `brain_intake_entities`
 * asserts that these entities were extracted from this material, and a path
 * with no bytes behind it cannot have produced an extraction.
 *
 * What this does NOT buy is stated in the classifier's own docblock and is not
 * pinned here, because it is not a behaviour: an attacker forced to name a
 * real file names `README.md`. The check removes the free bypass and makes the
 * claim auditable; it does not stop the lie.
 *
 * The third answer is kept apart from both lanes. An unreadable file is not a
 * trust verdict - it is a question the filesystem refused - so it propagates
 * instead of being folded into `untrusted`, where a permissions mistake would
 * quarantine the operator's own note and quarantine is one-way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { getEntity, listEntities } from "../../../../src/core/brain/entities/registry.ts";
import { BRAIN_ENTITY_STATUS } from "../../../../src/core/brain/entities/types.ts";
import { hashFile } from "../../../../src/core/brain/ingest/content-manifest.ts";
import {
  intakeExtraction,
  IntakeValidationError,
} from "../../../../src/core/brain/intake/extract-intake.ts";
import { classifySourceOrigin } from "../../../../src/core/brain/intake/source-trust.ts";
import {
  INTAKE_TRUST,
  SOURCE_CONTENT_HASH_FRONTMATTER_KEY,
} from "../../../../src/core/brain/trust/untrusted-provenance.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const EXTRACTION = { entities: [{ category: "concept", name: "Restaking" }] };
const SOURCE = "Articles/primer.md";
const SOURCE_BYTES = "the source bytes the extraction claims to come from\n";
/** A directory this vault denies itself, so `stat` answers with an errno. */
const LOCKED_DIR = "Locked";
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function seed(rel: string, contents = SOURCE_BYTES): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
  return abs;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-trust-bytes-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-trust-bytes-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  // Restore the locked directory first: a 0-mode directory cannot be walked,
  // so the cleanup below would fail on the vault that contains it.
  const locked = join(vault, LOCKED_DIR);
  try {
    chmodSync(locked, 0o755);
  } catch {
    // The test that locks it is the only one that creates it.
  }
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("classifySourceOrigin - a shape without bytes is not a source", () => {
  test("a vault-shaped path that names no file is untrusted and hashes nothing", () => {
    const origin = classifySourceOrigin(vault, SOURCE);
    expect(origin.trust).toBe(INTAKE_TRUST.untrusted);
    expect(origin.contentHash).toBeUndefined();
  });

  test("the same path with a real file behind it is trusted and records its hash", () => {
    const abs = seed(SOURCE);
    const origin = classifySourceOrigin(vault, SOURCE);
    expect(origin.trust).toBe(INTAKE_TRUST.trusted);
    expect(origin.contentHash).toBe(hashFile(abs));
  });

  test("an address outside the vault stays untrusted however the shape gate is fed", () => {
    seed(SOURCE);
    for (const source of ["https://example.com/a", "evil.com/article", "../outside/x.md"]) {
      expect(classifySourceOrigin(vault, source).trust).toBe(INTAKE_TRUST.untrusted);
    }
  });

  test("a directory is not a file: naming one buys no trust", () => {
    seed(SOURCE);
    expect(classifySourceOrigin(vault, "Articles").trust).toBe(INTAKE_TRUST.untrusted);
  });

  test.skipIf(RUNNING_AS_ROOT)(
    "a source that exists but cannot be read is an error, not a verdict",
    () => {
      seed(`${LOCKED_DIR}/note.md`);
      chmodSync(join(vault, LOCKED_DIR), 0o000);
      expect(() => classifySourceOrigin(vault, `${LOCKED_DIR}/note.md`)).toThrow();
    },
  );
});

describe("intakeExtraction - the verdict follows the bytes", () => {
  function intake(source: string): void {
    intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: { level: "stated", sources: [`[[${source}]]`], premises: [] },
    });
  }

  test("a source that names no file quarantines what it claims to have extracted", () => {
    intake(SOURCE);
    expect(getEntity(vault, { category: "concept", query: "Restaking" })).toBeNull();
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("a source with a real file behind it lands active and stamps the audit hash", () => {
    const abs = seed(SOURCE);
    intake(SOURCE);
    const entity = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(entity).not.toBeNull();
    const [meta] = parseFrontmatter(entity!.path);
    expect(meta[SOURCE_CONTENT_HASH_FRONTMATTER_KEY]).toBe(hashFile(abs));
  });

  test("the verdict is returned to the caller rather than recomputed by it", () => {
    seed(SOURCE);
    const res = intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: { level: "stated", sources: [`[[${SOURCE}]]`], premises: [] },
    });
    expect(res.trust).toBe(INTAKE_TRUST.trusted);
  });

  test("an intake citing no source at all is refused, and writes nothing", () => {
    expect(() =>
      intakeExtraction(vault, EXTRACTION, {
        agent: "ingest-agent",
        now: NOW,
        provenance: { level: "stated", sources: [], premises: [] },
      }),
    ).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });
});
