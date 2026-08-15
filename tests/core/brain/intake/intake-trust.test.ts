/**
 * Trust originated at the intake boundary (provenance-at-the-boundary, unit A).
 *
 * Before this unit nothing at intake knew where content came from. The source
 * pipeline stamped one provenance level on every source, so a scraped URL and
 * a file in the operator's own vault were indistinguishable, and the
 * `untrusted_source` frontmatter key that the retrieval trust gate reads had
 * no writer anywhere in the repository - a gate branch reachable only from a
 * field nothing produced.
 *
 * Two things are pinned here. First, that the trusted path did not move: the
 * entity page and the summary page a trusted intake writes are asserted
 * against bytes captured from the code as it stood BEFORE the change, so
 * "byte-identical" is a measurement and not a claim. Second, that the
 * untrusted path now lands the record quarantined, marks it with the key the
 * gate reads, and that driving the real gate over the real file it wrote
 * returns the untrusted-source verdict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { getEntity, listEntities } from "../../../../src/core/brain/entities/registry.ts";
import { BRAIN_ENTITY_STATUS } from "../../../../src/core/brain/entities/types.ts";
import { intakeExtraction } from "../../../../src/core/brain/intake/extract-intake.ts";
import { classifySourceOrigin } from "../../../../src/core/brain/intake/source-trust.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import {
  classifyRetrievalTrust,
  RETRIEVAL_TRUST_EXCLUSION_REASON,
} from "../../../../src/core/brain/trust/retrieval-gate.ts";
import {
  INTAKE_TRUST,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
} from "../../../../src/core/brain/trust/untrusted-provenance.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

const EXTRACTION = { entities: [{ category: "concept", name: "Restaking" }] };
const TRUSTED_SOURCE = "Articles/primer.md";
const UNTRUSTED_SOURCE = "https://example.com/a";
/** Fixture bytes for the trusted source; its digest is pinned below. */
const TRUSTED_SOURCE_BYTES = "the source bytes\n";
const TRUSTED_SOURCE_HASH = "75622f215577918221541bf29f17c2b262326c06a68bc29912f5a78c36edb934";

/**
 * Trust now requires the named file to exist (GitHub #160), so every trusted
 * case here seeds its source. That is the ONE change to the pinned bytes
 * below: a trusted intake also records the digest of what it read.
 */
function seed(rel: string, contents = TRUSTED_SOURCE_BYTES): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function provenanceCiting(source: string): {
  readonly level: "stated";
  readonly sources: readonly string[];
  readonly premises: readonly string[];
} {
  return { level: "stated", sources: [`[[${source}]]`], premises: [] };
}

/**
 * Bytes the pre-change code wrote for a trusted intake, captured from the
 * tree before this unit existed. Pinned literally so a regression in the
 * trusted path fails here rather than being absorbed by a helper that
 * changed alongside it.
 */
const GOLDEN_TRUSTED_ENTITY_PAGE =
  "---\n" +
  "kind: brain-entity\n" +
  "entity_id: ent-concept-restaking\n" +
  "category: concept\n" +
  "name: Restaking\n" +
  "status: active\n" +
  "source_agent: ingest-agent\n" +
  'created_at: "2026-06-13T12:00:00Z"\n' +
  'updated_at: "2026-06-13T12:00:00Z"\n' +
  "tags: [brain, brain/entity]\n" +
  // The one line this unit adds to the pre-change bytes: the audit digest of
  // the source the extraction was classified against (GitHub #160).
  `source_content_hash: ${TRUSTED_SOURCE_HASH}\n` +
  "---\n" +
  "\n" +
  "# Restaking\n" +
  "\n" +
  "## Sources\n" +
  "\n" +
  "- [[Articles/primer.md]]\n";

const GOLDEN_TRUSTED_SUMMARY_PAGE =
  "---\n" +
  "kind: brain-source\n" +
  "source_path: Articles/primer.md\n" +
  "source_hash: 51b0f811072b41378ce56e723de332a315cd3c2841915c355606b294f1304019\n" +
  "provenance: stated\n" +
  'created_at: "2026-06-13T12:00:00Z"\n' +
  'updated_at: "2026-06-13T12:00:00Z"\n' +
  "tags: [brain, brain/source]\n" +
  "---\n" +
  "\n" +
  "An overview.\n" +
  "\n" +
  "## Sources\n" +
  "\n" +
  "- [[Articles/primer.md]]\n" +
  "\n" +
  "## Entities\n" +
  "\n" +
  "- [[ent-concept-restaking]]\n";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-trust-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-trust-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("classifySourceOrigin", () => {
  test("a vault-relative source identity with a file behind it is trusted", () => {
    seed(TRUSTED_SOURCE);
    seed("notes/deep/nested.md");
    expect(classifySourceOrigin(vault, TRUSTED_SOURCE).trust).toBe(INTAKE_TRUST.trusted);
    expect(classifySourceOrigin(vault, "notes/deep/nested.md").trust).toBe(INTAKE_TRUST.trusted);
    expect(classifySourceOrigin(vault, "[[Articles/primer.md]]").trust).toBe(INTAKE_TRUST.trusted);
  });

  test("a source identity carrying a URI scheme is untrusted", () => {
    for (const source of [
      "https://example.com/a",
      "HTTP://Example.com/a",
      "ftp://host/x",
      "//example.com/a",
      "[[https://example.com/a]]",
    ]) {
      expect(classifySourceOrigin(vault, source).trust).toBe(INTAKE_TRUST.untrusted);
    }
  });

  test("a source identity that leaves the vault is untrusted", () => {
    expect(classifySourceOrigin(vault, "../outside/x.md").trust).toBe(INTAKE_TRUST.untrusted);
    expect(classifySourceOrigin(vault, "/etc/passwd").trust).toBe(INTAKE_TRUST.untrusted);
  });

  test("an empty source identity is untrusted - absence is not authority", () => {
    expect(classifySourceOrigin(vault, "").trust).toBe(INTAKE_TRUST.untrusted);
    expect(classifySourceOrigin(vault, "   ").trust).toBe(INTAKE_TRUST.untrusted);
  });
});

describe("intakeExtraction - the trusted path did not move", () => {
  test("an intake citing a real vault source writes the pre-change bytes", () => {
    seed(TRUSTED_SOURCE);
    intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: provenanceCiting(TRUSTED_SOURCE),
    });
    const entity = getEntity(vault, { category: "concept", query: "Restaking" })!;
    expect(readFileSync(entity.path, "utf8")).toBe(GOLDEN_TRUSTED_ENTITY_PAGE);
  });

  // The declared-trust option that used to be asserted here is gone: it let
  // the caller name the lane, which is the switch GitHub #160 is about.
  test("the intake reports the lane it committed in", () => {
    seed(TRUSTED_SOURCE);
    const res = intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: provenanceCiting(TRUSTED_SOURCE),
    });
    expect(res.trust).toBe(INTAKE_TRUST.trusted);
  });
});

describe("intakeExtraction - the untrusted path", () => {
  function untrustedIntake(): void {
    intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: provenanceCiting(UNTRUSTED_SOURCE),
    });
  }

  test("the entity lands quarantined and reaches no ordinary read surface", () => {
    untrustedIntake();
    expect(getEntity(vault, { category: "concept", query: "Restaking" })).toBeNull();
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    const quarantined = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.name).toBe("Restaking");
  });

  test("the entity page carries the untrusted_source key the gate reads", () => {
    untrustedIntake();
    const [meta] = parseFrontmatter(
      listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })[0]!.path,
    );
    expect(meta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeDefined();
  });

  test("the retrieval gate excludes the page this intake actually wrote", () => {
    untrustedIntake();
    // Driven from the real file the intake produced, not a hand-built
    // fixture: this is the join that did not exist before, because the key
    // the gate reads had no writer.
    const path = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })[0]!.path;
    const [meta] = parseFrontmatter(path);
    const verdict = classifyRetrievalTrust(meta);
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toContain(RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance);
  });

  test("a trusted intake leaves the gate's verdict clean", () => {
    seed(TRUSTED_SOURCE);
    intakeExtraction(vault, EXTRACTION, {
      agent: "ingest-agent",
      now: NOW,
      provenance: provenanceCiting(TRUSTED_SOURCE),
    });
    const entity = getEntity(vault, { category: "concept", query: "Restaking" })!;
    const [meta] = parseFrontmatter(entity.path);
    expect(classifyRetrievalTrust(meta).quarantined).toBe(false);
  });

  test("an entity that already exists is not downgraded by a later untrusted mention", () => {
    seed(TRUSTED_SOURCE);
    intakeExtraction(vault, EXTRACTION, {
      agent: "operator",
      now: NOW,
      provenance: provenanceCiting(TRUSTED_SOURCE),
    });
    untrustedIntake();
    const entity = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(entity).not.toBeNull();
    expect(entity!.status).toBe(BRAIN_ENTITY_STATUS.active);
    const [meta] = parseFrontmatter(entity!.path);
    expect(meta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeUndefined();
  });
});

describe("ingestSource derives trust from the source identity", () => {
  const INPUT = { summary: "An overview.", extraction: EXTRACTION };

  test("a vault-relative source writes the pre-change summary bytes", () => {
    seed(TRUSTED_SOURCE);
    const res = ingestSource(
      vault,
      { ...INPUT, sourcePath: TRUSTED_SOURCE },
      { agent: "claude", now: NOW },
    );
    expect(readFileSync(join(vault, res.summaryPath), "utf8")).toBe(GOLDEN_TRUSTED_SUMMARY_PAGE);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(1);
  });

  test("a URL source quarantines its entities and marks its summary page", () => {
    const res = ingestSource(
      vault,
      { ...INPUT, sourcePath: UNTRUSTED_SOURCE },
      { agent: "claude", now: NOW },
    );
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);

    const [meta] = parseFrontmatter(join(vault, res.summaryPath));
    expect(meta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeDefined();
    expect(classifyRetrievalTrust(meta).reasons).toContain(
      RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance,
    );
  });

  test("a scraped URL and a local file are no longer indistinguishable", () => {
    seed(TRUSTED_SOURCE);
    const local = ingestSource(
      vault,
      { ...INPUT, sourcePath: TRUSTED_SOURCE },
      { agent: "claude", now: NOW },
    );
    const scraped = ingestSource(
      vault,
      {
        ...INPUT,
        sourcePath: UNTRUSTED_SOURCE,
        extraction: { entities: [{ category: "concept", name: "Scraped" }] },
      },
      { agent: "claude", now: NOW },
    );
    const [localMeta] = parseFrontmatter(join(vault, local.summaryPath));
    const [scrapedMeta] = parseFrontmatter(join(vault, scraped.summaryPath));
    expect(localMeta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeUndefined();
    expect(scrapedMeta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeDefined();
  });
});
