/**
 * The third claim-write path classifies its source (wiring-what-exists, A1,
 * `t_84d0ff47`).
 *
 * `distillSource` was the only writer of claims that never asked where its
 * source came from. Five consequences, one per defect this file pins:
 *
 * 1. It canonicalised the caller's identity with the bare `canonicalNotePath`,
 *    so a wikilink-shaped `[[Articles/x.md]]` kept its wrapper: the body cited
 *    `[[[[Articles/x.md]]]]` and the identity hash keyed a SECOND page for one
 *    source, against this pipeline's documented idempotency.
 * 2. It called neither `classifySourceOrigin` nor `classifySourceTrust`, so
 *    every page landed under `provenance: stated` - the top authority tier -
 *    with no `untrusted_source` marker for `classifyRetrievalTrust` to read.
 *    Claims distilled from an address nobody in this vault owns ranked beside
 *    the operator's own notes.
 * 3. `join(vault, canonicalSource)` passed through no shape gate, so
 *    `../../etc/passwd` was stat-ed and hashed: an existence oracle over any
 *    path the process could reach, on a string the CALLER supplied.
 * 4. A source with no bytes recorded the literal `"missing"` as its hash and
 *    the page was written anyway. Absence was a value instead of a verdict.
 * 5. The inline `createHash(...).update(readFileSync(...))` had no ceiling and
 *    would read a file of any size into memory.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER. The shape gate's own decision
 * table (which spellings are vault-shaped, why a single dotted segment is not)
 * belongs to `tests/core/brain/intake/` and is not re-derived here; these cases
 * only assert that distillation reaches the same verdicts through the same
 * functions. Nor does it cover what classification cannot buy: an attacker
 * forced to name a real file names `README.md`, and the recorded digest is then
 * of the bytes CLAIMED, not of the bytes that produced the claims. That limit
 * is stated in `classifySourceOrigin`'s docblock and is not a behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { BRAIN_DISTILLATIONS_REL } from "../../../../src/core/brain/paths.ts";
import {
  distillSource,
  type DistillSourceResult,
} from "../../../../src/core/brain/distill/distill-source.ts";
import { hashFile } from "../../../../src/core/brain/ingest/content-manifest.ts";
import {
  SOURCE_HASH_MAX_BYTES,
  SourceTrustError,
} from "../../../../src/core/brain/intake/source-trust.ts";
import {
  classifyRetrievalTrust,
  RETRIEVAL_TRUST_EXCLUSION_REASON,
} from "../../../../src/core/brain/trust/retrieval-gate.ts";
import {
  hasUntrustedSourceMarker,
  INTAKE_TRUST,
  SOURCE_CONTENT_HASH_FRONTMATTER_KEY,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
} from "../../../../src/core/brain/trust/untrusted-provenance.ts";

let vault: string;
let configHome: string;
/** A directory OUTSIDE the vault, for the traversal cases. */
let outside: string;

const NOW = new Date("2026-07-10T08:00:00Z");
const SOURCE = "Articles/restaking.md";
const SOURCE_BYTES = "# Restaking\n\nBody text.\n";
/** A directory this vault denies itself, so `stat` answers with an errno. */
const LOCKED_DIR = "Locked";
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const CLAIMS = [
  { text: "Restaking reuses staked capital.", block: "abc" },
  { text: "It adds risk." },
];

function seed(rel: string, contents = SOURCE_BYTES): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents, "utf8");
  return abs;
}

function distill(sourcePath: string): DistillSourceResult {
  return distillSource(vault, { sourcePath, claims: CLAIMS }, { agent: "claude", now: NOW });
}

function pageMeta(res: DistillSourceResult): Record<string, unknown> {
  return parseFrontmatter(join(vault, res.distillationPath))[0];
}

/** Distillation pages on disk. An absent directory is zero pages, not a throw. */
function distillationPages(): string[] {
  const dir = join(vault, BRAIN_DISTILLATIONS_REL);
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-distill-trust-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-distill-trust-cfg-"));
  outside = mkdtempSync(join(tmpdir(), "o2b-distill-trust-outside-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  // Restore the locked directory first: a 0-mode directory cannot be walked,
  // so the recursive removal below would fail on the vault that contains it.
  try {
    chmodSync(join(vault, LOCKED_DIR), 0o755);
  } catch {
    // Only the test that locks it ever creates it.
  }
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("distillSource - one source, one identity", () => {
  test("the wikilink and bare spellings of one source write one page", () => {
    seed(SOURCE);
    const wrapped = distill(`[[${SOURCE}]]`);
    const bare = distill(SOURCE);

    expect(bare.distillationPath).toBe(wrapped.distillationPath);
    // The second call finding the page already there is the idempotency this
    // pipeline documents; two files would be the defect.
    expect(bare.created).toBe(false);
    expect(distillationPages()).toHaveLength(1);

    const md = readFileSync(join(vault, wrapped.distillationPath), "utf8");
    expect(md).toContain(`source_path: ${SOURCE}`);
    expect(md).toContain(`[[${SOURCE}]]`);
    expect(md).not.toContain("[[[[");
  });

  test("an alias and an anchor are decoration on the same target", () => {
    seed(SOURCE);
    const plain = distill(SOURCE);
    expect(distill(`[[${SOURCE}|Primer]]`).distillationPath).toBe(plain.distillationPath);
    expect(distill(`[[${SOURCE}#Intro]]`).distillationPath).toBe(plain.distillationPath);
    expect(distillationPages()).toHaveLength(1);
  });
});

describe("distillSource - absence is a verdict, not a hash", () => {
  test("a vault-shaped path naming no file lands untrusted and records no digest", () => {
    const res = distill(SOURCE);
    expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    expect(res.sourceHash).toBeUndefined();

    // Asserted through the reader rather than against a literal: the marker
    // survives a YAML round-trip as the string `"true"`, and the pair of
    // functions is what must agree, not one spelling of the value.
    const meta = pageMeta(res);
    expect(hasUntrustedSourceMarker(meta)).toBe(true);
    // A page that claims a digest it never computed is worse than one that
    // says nothing: only the second can be read as "not recorded".
    expect(meta["source_hash"]).toBeUndefined();
    expect(meta[SOURCE_CONTENT_HASH_FRONTMATTER_KEY]).toBeUndefined();
    expect(readFileSync(join(vault, res.distillationPath), "utf8")).not.toContain("missing");
  });

  test("the marker the page carries is the one the retrieval gate reads", () => {
    const verdict = classifyRetrievalTrust(pageMeta(distill(SOURCE)));
    expect(verdict.quarantined).toBe(true);
    expect(verdict.reasons).toContain(RETRIEVAL_TRUST_EXCLUSION_REASON.untrustedSourceProvenance);
  });

  test("a URL identity is untrusted rather than a page with a sentinel hash", () => {
    const res = distill("https://example.com/restaking");
    expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    expect(res.sourceHash).toBeUndefined();
    expect(hasUntrustedSourceMarker(pageMeta(res))).toBe(true);
  });

  test("a real file behind the identity is trusted, unmarked, and digested", () => {
    const abs = seed(SOURCE);
    const res = distill(SOURCE);
    expect(res.trust).toBe(INTAKE_TRUST.trusted);
    expect(res.sourceHash).toBe(hashFile(abs));

    const meta = pageMeta(res);
    expect(meta[UNTRUSTED_SOURCE_FRONTMATTER_KEY]).toBeUndefined();
    expect(meta[SOURCE_CONTENT_HASH_FRONTMATTER_KEY]).toBe(hashFile(abs));
    expect(classifyRetrievalTrust(meta).quarantined).toBe(false);
  });
});

describe("distillSource - the source read is bounded to the vault", () => {
  /**
   * The oracle test. Two identities that climb out of the vault, one naming a
   * file that really is there and one naming nothing: if the caller can tell
   * them apart from the response or the page, the tool answers "does this path
   * exist?" for any path the process can reach.
   */
  test("an out-of-vault identity reads the same whether or not its file exists", () => {
    const present = join(outside, "secret.md");
    writeFileSync(present, "secret bytes\n", "utf8");
    const presentRel = relative(vault, present);
    const absentRel = relative(vault, join(outside, "no-such-file.md"));

    for (const rel of [presentRel, absentRel]) {
      const res = distill(rel);
      expect(res.trust).toBe(INTAKE_TRUST.untrusted);
      expect(res.sourceHash).toBeUndefined();
      expect(pageMeta(res)["source_hash"]).toBeUndefined();
    }
  });

  test("an absolute path buys no trust and no digest", () => {
    const res = distill("/etc/passwd");
    expect(res.trust).toBe(INTAKE_TRUST.untrusted);
    expect(res.sourceHash).toBeUndefined();
  });
});

describe("distillSource - a refusal the filesystem owns is not a trust verdict", () => {
  test.skipIf(RUNNING_AS_ROOT)(
    "an unreadable in-vault source refuses by identity and errno, writing nothing",
    () => {
      const rel = `${LOCKED_DIR}/note.md`;
      seed(rel);
      chmodSync(join(vault, LOCKED_DIR), 0o000);

      let thrown: unknown;
      try {
        distill(rel);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SourceTrustError);
      const message = (thrown as Error).message;
      expect(message).toContain(rel);
      expect(message).toContain("EACCES");
      // The caller chose this path; the kernel's sentence would hand them the
      // operator's absolute filesystem layout in return.
      expect(message).not.toContain(vault);
      expect(distillationPages()).toEqual([]);
    },
  );

  test("a source past the read ceiling refuses instead of being read whole", () => {
    seed(SOURCE, "x".repeat(SOURCE_HASH_MAX_BYTES + 1));
    let thrown: unknown;
    try {
      distill(SOURCE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SourceTrustError);
    expect((thrown as Error).message).toContain(String(SOURCE_HASH_MAX_BYTES));
    expect(distillationPages()).toEqual([]);
  });
});

/**
 * The added keys are additive. A trusted in-vault source must produce the page
 * this module produced before it knew about trust, plus `source_content_hash`
 * and nothing else - so an existing vault's distillation pages do not churn on
 * upgrade and the idempotent no-op stays a no-op.
 */
describe("distillSource - a trusted page is what it was, plus what was added", () => {
  const BEFORE_THIS_UNIT =
    "---\n" +
    "kind: brain-distillation\n" +
    "source_path: Articles/restaking.md\n" +
    "source_hash: HASH\n" +
    "provenance: stated\n" +
    "agent: claude\n" +
    "claim_count: 2\n" +
    'created_at: "2026-07-10T08:00:00Z"\n' +
    'updated_at: "2026-07-10T08:00:00Z"\n' +
    "tags: [brain, brain/distillation]\n" +
    "---\n" +
    "\n" +
    "## Claims\n" +
    "\n" +
    "- Restaking reuses staked capital. ([[Articles/restaking.md#^abc]])\n" +
    "- It adds risk.\n" +
    "\n" +
    "## Sources\n" +
    "\n" +
    "- [[Articles/restaking.md]]\n";

  test("only the source_content_hash line is new", () => {
    const abs = seed(SOURCE);
    const res = distill(SOURCE);
    const md = readFileSync(join(vault, res.distillationPath), "utf8");

    const added = `${SOURCE_CONTENT_HASH_FRONTMATTER_KEY}: ${hashFile(abs)}\n`;
    expect(md).toContain(added);
    expect(md.replace(added, "")).toBe(BEFORE_THIS_UNIT.replace("HASH", hashFile(abs)));
  });
});
