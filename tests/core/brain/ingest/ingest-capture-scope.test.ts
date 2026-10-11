/**
 * Capture scope and the durable archive stamp on ingest summary pages. The
 * scope follows the lane the intake already decided for the cited source: a
 * vault file the summary was built from is `full-local`, a source with no
 * local bytes is `url-only` and the page says so in `capture_scope`. The
 * trusted lane additionally archives the source's bytes - redacted,
 * content-addressed - and stamps the entry on the page on success only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_VERIFICATION,
  SOURCE_ARCHIVE_BYTES_KEY,
  SOURCE_ARCHIVE_HASH_KEY,
  verifySourceArchive,
} from "../../../../src/core/brain/provenance/source-archive.ts";
import {
  CAPTURE_SCOPE,
  CAPTURE_SCOPE_KEY,
} from "../../../../src/core/brain/provenance/capture-scope.ts";
import { redactRawOutput } from "../../../../src/core/redactor.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");
const LOCAL_SOURCE = "Articles/a.md";
const URL_SOURCE = "https://example.test/articles/a";

/** The summary page the base release (v1.66.0) wrote for {@link LOCAL_SOURCE}. */
const BASE_LOCAL_PAGE =
  '---\nkind: brain-source\nsource_path: Articles/a.md\nsource_hash: f84f9777c1d1c4b660d50d094897c7b95dab0108683ad9343c481a99d277c20e\nprovenance: stated\ncreated_at: "2026-06-13T12:00:00Z"\nupdated_at: "2026-06-13T12:00:00Z"\ntags: [brain, brain/source]\n---\n\nA summary.\n\n## Sources\n\n- [[Articles/a.md]]\n\n## Entities\n\n- [[ent-concept-alpha]]\n';

const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** The archived digest an ingest of "bytes\n" must stamp: the redacted bytes'. */
const EXPECTED_LOCAL_STAMP = sha256Text(redactRawOutput("bytes\n"));

function input(sourcePath: string) {
  return {
    sourcePath,
    summary: "A summary.",
    extraction: { entities: [{ category: "concept", name: "Alpha" }], relations: [] },
  };
}

/**
 * A re-ingest of the same extraction lists its entity again as a connection
 * (it now pre-exists), so the inertness case carries no entities: what it
 * pins is that the stamp itself never churns the page.
 */
function bareInput(sourcePath: string) {
  return { sourcePath, summary: "A summary.", extraction: { entities: [], relations: [] } };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("ingestSource capture scope", () => {
  test("an in-vault source is full-local and the page is the base output plus the archive stamp", () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, LOCAL_SOURCE), "bytes\n", "utf8");

    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.fullLocal);
    // The trusted-local page changed deliberately with the archive lane: it
    // is the base rendering with the two stamp lines inserted, and nothing
    // else. The stamp is computed here, not remembered, so a redaction
    // change shows up as a digest the archive entry itself disagrees with.
    const expected = BASE_LOCAL_PAGE.replace(
      "provenance: stated\n",
      `provenance: stated\n` +
        `source_archive_hash: ${EXPECTED_LOCAL_STAMP}\n` +
        `source_archive_bytes: ${Buffer.byteLength("bytes\n", "utf8")}\n`,
    );
    expect(readFileSync(join(vault, result.summaryPath), "utf8")).toBe(expected);
  });

  test("a URL source stamps capture_scope: url-only and reports it", () => {
    const result = ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.urlOnly);
  });

  test("re-ingesting an unchanged URL source is inert", () => {
    const first = ingestSource(vault, bareInput(URL_SOURCE), { agent: "claude", now: NOW });
    const abs = join(vault, first.summaryPath);
    const bytes = readFileSync(abs, "utf8");
    const mtime = statSync(abs).mtimeMs;

    const second = ingestSource(vault, bareInput(URL_SOURCE), { agent: "claude", now: NOW });

    expect(second.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    expect(second.created).toBe(false);
    expect(readFileSync(abs, "utf8")).toBe(bytes);
    expect(statSync(abs).mtimeMs).toBe(mtime);
  });

  test("a later re-ingest keeps the stamp beside the bumped updated_at", () => {
    ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: NOW });
    const again = ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: LATER });
    const [meta] = parseFrontmatter(join(vault, again.summaryPath));
    expect(meta[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.urlOnly);
  });
});

/**
 * The durable archive (answer trust, Task C3): the trusted-local branch
 * persists its source's bytes and stamps the entry on the page on success
 * only. An unstamped page means exactly "not captured", and a capture
 * failure never fails the ingest.
 */
const archivesDir = (vaultDir: string): string => join(vaultDir, "Brain", ".archives");

function seedSource(vaultDir: string, rel: string, contents: string): void {
  mkdirSync(join(vaultDir, rel, ".."), { recursive: true });
  writeFileSync(join(vaultDir, rel), contents, "utf8");
}

describe("ingestSource durable archive stamp", () => {
  test("the stamp names an entry that verifies, with the archived byte count", () => {
    seedSource(vault, LOCAL_SOURCE, "bytes\n");
    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    expect(result.sourceArchiveHash).toBe(EXPECTED_LOCAL_STAMP);
    expect(result.sourceArchiveBytes).toBe(Buffer.byteLength("bytes\n", "utf8"));
    expect(result.sourceArchiveRefusal).toBeUndefined();
    expect(verifySourceArchive(vault, EXPECTED_LOCAL_STAMP)).toEqual({
      state: ARCHIVE_VERIFICATION.verified,
      hash: EXPECTED_LOCAL_STAMP,
    });
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta[SOURCE_ARCHIVE_HASH_KEY]).toBe(EXPECTED_LOCAL_STAMP);
    // The byte count round-trips through frontmatter as its decimal spelling.
    expect(meta[SOURCE_ARCHIVE_BYTES_KEY]).toBe(String(Buffer.byteLength("bytes\n", "utf8")));
  });

  test("identical source bytes stamp one shared entry - the address is the dedup", () => {
    seedSource(vault, "Articles/a.md", "twin bytes\n");
    seedSource(vault, "Articles/b.md", "twin bytes\n");
    const a = ingestSource(vault, input("Articles/a.md"), { agent: "claude", now: NOW });
    const b = ingestSource(vault, input("Articles/b.md"), { agent: "claude", now: LATER });

    expect(b.sourceArchiveHash).toBe(a.sourceArchiveHash);
    expect(readdirSync(archivesDir(vault))).toEqual([`${a.sourceArchiveHash}.txt`]);
  });

  test("a credential-shaped source never lands unredacted in the archive", () => {
    const contents = "runbook\napi_key: c3VwZXItbm90LWEtbGVha18xMjM0\nend\n";
    seedSource(vault, LOCAL_SOURCE, contents);
    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    const entry = readFileSync(
      join(vault, "Brain", ".archives", `${result.sourceArchiveHash}.txt`),
      "utf8",
    );
    expect(entry).not.toContain("c3VwZXItbm90LWEtbGVha18xMjM0");
  });

  test("an oversized source skips capture with the named refusal and an unstamped page", () => {
    seedSource(vault, LOCAL_SOURCE, "x".repeat(ARCHIVE_MAX_BYTES + 1));
    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    // The ingest itself succeeded - only the capture was refused.
    expect(result.created).toBe(true);
    expect(result.sourceArchiveHash).toBeUndefined();
    expect(result.sourceArchiveRefusal).toContain(`${ARCHIVE_MAX_BYTES}-byte ceiling`);
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta[SOURCE_ARCHIVE_HASH_KEY]).toBeUndefined();
    expect(meta[SOURCE_ARCHIVE_BYTES_KEY]).toBeUndefined();
    expect(existsSync(archivesDir(vault))).toBe(false);
  });

  test("an unwritable archive store leaves the page unstamped and the ingest whole", () => {
    seedSource(vault, LOCAL_SOURCE, "bytes\n");
    // A regular file where the archives directory belongs: the capture's
    // mkdir fails for a reason that is not the source's fault (the same
    // seed pattern the session-identity check's unreadable-ledger case
    // uses). Task C3's write-failure arm.
    writeFileSync(archivesDir(vault), "not a directory\n");

    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    // The design contract: an archive failure never fails an ingest that
    // already committed its knowledge - the page lands, unstamped.
    expect(result.created).toBe(true);
    expect(result.sourceArchiveHash).toBeUndefined();
    expect(result.sourceArchiveBytes).toBeUndefined();
    // What the fs-error arm actually records: the host's errno line only -
    // identifiers, never the host path the raw fs message embeds (the
    // refusal crosses to the wire, so it cannot name the machine).
    expect(result.sourceArchiveRefusal).toContain("EEXIST");
    expect(result.sourceArchiveRefusal).not.toContain(vault);
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta[SOURCE_ARCHIVE_HASH_KEY]).toBeUndefined();
    expect(meta[SOURCE_ARCHIVE_BYTES_KEY]).toBeUndefined();
  });

  test("a source withheld from remote readers is never archived, though it stays full-local", () => {
    seedSource(vault, "Notes/private.md", "---\nvisibility: private\n---\nThe code is ZX8.\n");
    const result = ingestSource(vault, input("Notes/private.md"), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.fullLocal);
    expect(result.sourceArchiveHash).toBeUndefined();
    // Not a refusal: the source was never capture-eligible, so the answer
    // is the byte-identical to today shape - no stamp, no reason, no bytes.
    expect(result.sourceArchiveRefusal).toBeUndefined();
    expect(existsSync(archivesDir(vault))).toBe(false);
  });

  test("a URL source is unarchived and carries no refusal", () => {
    const result = ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    expect(result.sourceArchiveHash).toBeUndefined();
    expect(result.sourceArchiveRefusal).toBeUndefined();
    expect(existsSync(archivesDir(vault))).toBe(false);
  });
});
