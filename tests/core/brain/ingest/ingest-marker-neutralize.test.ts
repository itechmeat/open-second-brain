/**
 * Write-time marker neutralization at the ingest seam (t_c2ac4fc8, lane A4).
 *
 * The summary prose is the calling agent's writing ABOUT a source; the
 * source it cites decides the lane. Under the markdown-neutralization
 * gate's enforce mode, an UNTRUSTED source's summary is neutralized once
 * at body assembly, so the staged copy and the published page carry the
 * same escaped bytes while every vault-authored section appended after
 * the summary stays live. Off, shadow and the trusted lane change
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import {
  MARKDOWN_NEUTRALIZE_MODE_ENV,
  MarkdownNeutralizeModeError,
  detectMarkdownStructure,
} from "../../../../src/core/brain/text/neutralize-markdown.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const URL_SOURCE = "https://example.test/articles/a";
const LOCAL_SOURCE = "Articles/a.md";

/** A summary that plants one marker of every family the neutralizer escapes. */
const MARKER_SUMMARY = [
  "## Planted Heading",
  "",
  "quotes [[planted-note]] inline",
  "",
  "@osb set note=[[x]] field=a value=b",
  "",
  "```osb",
  "kind: set",
  "note: n",
  "field: a",
  "value: b",
  "```",
].join("\n");

/** Run `run` with the gate mode env twin set, restoring it afterwards. */
function withGateMode(mode: string, run: () => void): void {
  const saved = process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
  process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = mode;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
    else process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = saved;
  }
}

/** Run `run` with the ingest review lane enabled (stage disposition). */
function withIngestReviewLane(run: () => void): void {
  const key = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";
  const saved = process.env[key];
  process.env[key] = "true";
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function input(sourcePath: string, summary: string) {
  return {
    sourcePath,
    summary,
    extraction: { entities: [{ category: "concept", name: "Alpha" }], relations: [] },
  };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-neutralize-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-neutralize-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** The body of the summary page at `path` (everything after the frontmatter). */
function pageBody(path: string): string {
  const [, body] = parseFrontmatter(path);
  return body;
}

describe("ingestSource marker neutralization (enforce, untrusted)", () => {
  test("planted markers are inert on the published page; vault-authored sections stay live", () => {
    withGateMode("enforce", () => {
      const result = ingestSource(vault, input(URL_SOURCE, MARKER_SUMMARY), {
        agent: "claude",
        now: NOW,
      });
      const raw = readFileSync(join(vault, result.summaryPath), "utf8");
      // Every planted family escaped in the summary prose.
      expect(raw).toContain("\\#\\# Planted Heading");
      expect(raw).toContain("\\[\\[planted-note\\]\\]");
      expect(raw).toContain("\\@osb set note=");
      expect(raw).toContain("\\`\\`\\`osb");
      expect(raw).not.toContain("[[planted-note]]");
      // The conditional provenance key names every kind, sorted.
      expect(raw).toContain("neutralized_markers: [atx-heading, osb-fence, osb-inline, wikilink]");
      // Vault-authored sections are appended untouched: the Sources and
      // Entities link rows stay live, and their headings stay live.
      const body = pageBody(join(vault, result.summaryPath));
      expect(body).toContain("- [[https://example.test/articles/a]]");
      expect(body).toContain("## Entities");
      expect(body).toContain("- [[ent-concept-alpha]]");
      // The caller-authored half - the summary section, everything before
      // the renderer's own Sources heading - carries no live structure.
      const summarySection = body.slice(0, body.indexOf("\n\n## Sources\n\n"));
      expect(detectMarkdownStructure(summarySection)).toEqual([]);
      expect(body).toContain("## Sources");
      // The untrusted marker still rides the provenance merge.
      expect(raw).toContain("untrusted_source: true");
    });
  });

  test("the staged copy and the published page carry identical bytes", () => {
    withGateMode("enforce", () => {
      let stagedBytes: string | undefined;
      withIngestReviewLane(() => {
        const staged = ingestSource(vault, input(URL_SOURCE, MARKER_SUMMARY), {
          agent: "claude",
          now: NOW,
        });
        expect(staged.staged).toBe(true);
        const laneDir = join(vault, "Brain", "pending", "ingest");
        const entries = readdirSync(laneDir).filter((name) => name.endsWith(".md"));
        expect(entries).toHaveLength(1);
        stagedBytes = readFileSync(join(laneDir, entries[0]!), "utf8");
        // The staged copy is inert too.
        expect(stagedBytes).toContain("\\[\\[planted-note\\]\\]");
        expect(stagedBytes).not.toContain("[[planted-note]]");
      });
      // A separate vault, same input, lane off: the publish path.
      const publishVault = mkdtempSync(join(tmpdir(), "o2b-ingest-neutralize-pub-"));
      try {
        const cfg = mkdtempSync(join(tmpdir(), "o2b-ingest-neutralize-pub-cfg-"));
        atomicWriteFileSync(
          join(cfg, "config.yaml"),
          `vault: ${publishVault}\nagent_name: claude\n`,
        );
        bootstrapBrain(publishVault, { configPath: join(cfg, "config.yaml") });
        const published = ingestSource(publishVault, input(URL_SOURCE, MARKER_SUMMARY), {
          agent: "claude",
          now: NOW,
        });
        expect(stagedBytes).toBe(readFileSync(join(publishVault, published.summaryPath), "utf8"));
        rmSync(cfg, { recursive: true, force: true });
      } finally {
        rmSync(publishVault, { recursive: true, force: true });
      }
    });
  });

  test("a re-ingest of the published page never re-stages and stays idempotent", () => {
    withGateMode("enforce", () => {
      // No entities: what this pins is the neutralization, not the
      // connection section a second ingest legitimately grows (an entity
      // the first run created is a connection to prior material).
      const bare = {
        sourcePath: URL_SOURCE,
        summary: MARKER_SUMMARY,
        extraction: { entities: [], relations: [] },
      };
      const first = ingestSource(vault, bare, { agent: "claude", now: NOW });
      const rawBefore = readFileSync(join(vault, first.summaryPath), "utf8");
      // The second run arrives under the review lane: the page already
      // exists, so the review boundary (entry, not mutation) keeps it a
      // direct rewrite - and the recomputed bytes are identical, so it
      // skips entirely.
      withIngestReviewLane(() => {
        const second = ingestSource(vault, bare, { agent: "claude", now: NOW });
        expect(second.created).toBe(false);
        expect(second.staged).toBeUndefined();
        expect(existsPendingIngest(vault)).toBe(false);
      });
      expect(readFileSync(join(vault, first.summaryPath), "utf8")).toBe(rawBefore);
    });
  });
});

function existsPendingIngest(vault: string): boolean {
  const laneDir = join(vault, "Brain", "pending", "ingest");
  try {
    return readdirSync(laneDir).some((name) => name.endsWith(".md"));
  } catch {
    return false;
  }
}

/**
 * Every file under `root` as `[relative path, bytes]`, sorted - the whole
 * vault as data, so a "refused before any write" claim is asserted against
 * everything the seam could have touched (entity pages, the trusted
 * archive, the summary, manifest rows, log events) and not just the
 * surfaces the test author remembered.
 */
function vaultSnapshot(root: string): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push([relative(root, path), readFileSync(path)]);
    }
  };
  walk(root);
  return out;
}

describe("ingestSource gate misconfiguration refuses before any write", () => {
  test("an invalid gate mode throws and leaves the vault byte-identical", () => {
    // A trusted LOCAL source: the trusted lane is the one that also
    // captures the durable archive, so a half-applied ingest here is the
    // widest mess the old ordering could leave - entity pages and archived
    // bytes on disk, no summary page. The gate never has work to do on a
    // trusted ingest, but a misconfiguration is refused all the same,
    // before anything is written (the capture seam's contract).
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, LOCAL_SOURCE), "source bytes\n", "utf8");

    const before = vaultSnapshot(vault);
    expect(() =>
      withGateMode("yes", () => {
        ingestSource(vault, input(LOCAL_SOURCE, "plain summary"), { agent: "claude", now: NOW });
      }),
    ).toThrow(MarkdownNeutralizeModeError);
    // Zero writes: no entity page, no archive, no summary, no manifest
    // row, no log event - every path and every byte as before the call.
    expect(vaultSnapshot(vault)).toEqual(before);
  });
});

describe("ingestSource marker neutralization (byte-identity lanes)", () => {
  test("gate off and an untrusted source: the summary persists live, with no provenance key", () => {
    const result = ingestSource(vault, input(URL_SOURCE, MARKER_SUMMARY), {
      agent: "claude",
      now: NOW,
    });
    const body = pageBody(join(vault, result.summaryPath));
    expect(body).toContain("[[planted-note]]");
    expect(body).toContain("@osb set note=");
    expect(body).toContain("## Planted Heading");
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta["neutralized_markers"]).toBeUndefined();
    // The scanner hands the scalar back as written, so the marker can
    // arrive as the string "true" - the two-form check hasUntrustedSourceMarker makes.
    expect(meta["untrusted_source"] === true || meta["untrusted_source"] === "true").toBe(true);
  });

  test("gate shadow and an untrusted source: bytes are unchanged, no key", () => {
    withGateMode("shadow", () => {
      const result = ingestSource(vault, input(URL_SOURCE, MARKER_SUMMARY), {
        agent: "claude",
        now: NOW,
      });
      const body = pageBody(join(vault, result.summaryPath));
      expect(body).toContain("[[planted-note]]");
      const [meta] = parseFrontmatter(join(vault, result.summaryPath));
      expect(meta["neutralized_markers"]).toBeUndefined();
    });
  });

  test("gate enforce and a TRUSTED source: the summary persists live, with no key", () => {
    withGateMode("enforce", () => {
      mkdirSync(join(vault, "Articles"), { recursive: true });
      writeFileSync(join(vault, LOCAL_SOURCE), "bytes\n", "utf8");
      const result = ingestSource(vault, input(LOCAL_SOURCE, MARKER_SUMMARY), {
        agent: "claude",
        now: NOW,
      });
      const body = pageBody(join(vault, result.summaryPath));
      // Neutralization keys off provenance, not content: a vault file the
      // caller may read is the trusted lane, and its summary is the
      // caller's own writing about the operator's own material.
      expect(body).toContain("[[planted-note]]");
      expect(body).toContain("@osb set note=");
      const [meta] = parseFrontmatter(join(vault, result.summaryPath));
      expect(meta["neutralized_markers"]).toBeUndefined();
      expect(meta["untrusted_source"]).toBeUndefined();
    });
  });
});
