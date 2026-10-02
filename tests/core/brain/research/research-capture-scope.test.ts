/**
 * Per-source capture scopes on research reports. A report cites several
 * sources, so it records one scope per consulted source, parallel to the
 * report's `sources` order, and only when at least one of them is not
 * `full-local` (an all-local report stays byte-identical to the pre-scope
 * output). The result always carries the list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeResearchReport } from "../../../../src/core/brain/research/research.ts";
import {
  CAPTURE_SCOPE,
  CAPTURE_SCOPES_KEY,
} from "../../../../src/core/brain/provenance/capture-scope.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LOCAL_SOURCE = "Articles/a.md";
const URL_SOURCE = "https://example.test/articles/a";

/** The report page the base release (v1.66.0) wrote for one local source. */
const BASE_LOCAL_REPORT =
  '---\nkind: brain-report\ntitle: T\nreport_date: 2026-06-13\nprovenance: stated\nsource_count: 1\ncreated_at: "2026-06-13T12:00:00Z"\nupdated_at: "2026-06-13T12:00:00Z"\ntags: [brain, brain/report]\n---\n\n# T\n\n## Findings\n\n- S (cites: [[Articles/a.md]])\n\n## Sources\n\n- [[Articles/a.md]]\n';

function seed(rel: string): void {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), "bytes\n", "utf8");
}

function report(sources: ReadonlyArray<string>) {
  return writeResearchReport(
    vault,
    { title: "T", sources, findings: [{ statement: "S", sources: [sources[0]!] }] },
    { agent: "claude", now: NOW },
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-research-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-research-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("writeResearchReport capture scopes", () => {
  test("every source an in-vault file: no key, all full-local, byte-identical page", () => {
    seed(LOCAL_SOURCE);

    const result = report([LOCAL_SOURCE]);

    expect(result.captureScopes).toEqual([CAPTURE_SCOPE.fullLocal]);
    expect(readFileSync(join(vault, result.reportPath), "utf8")).toBe(BASE_LOCAL_REPORT);
  });

  test("one URL and one vault file: capture_scopes follows the sources order", () => {
    seed(LOCAL_SOURCE);

    const result = report([URL_SOURCE, LOCAL_SOURCE]);

    const expected = [CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.fullLocal];
    expect(result.captureScopes).toEqual(expected);
    const [meta] = parseFrontmatter(join(vault, result.reportPath));
    expect(meta[CAPTURE_SCOPES_KEY]).toEqual(expected);
  });

  test("a wikilinked source is classified by its target", () => {
    seed(LOCAL_SOURCE);

    const present = report([`[[${LOCAL_SOURCE}]]`, "[[Articles/missing.md|alias]]"]);

    expect(present.captureScopes).toEqual([CAPTURE_SCOPE.fullLocal, CAPTURE_SCOPE.urlOnly]);
  });

  test("a source the caller cannot read is url-only in the result and on the page", () => {
    seed(LOCAL_SOURCE);
    seed("Notes/open.md");
    const asked: string[] = [];
    const readable = (rel: string): boolean => {
      asked.push(rel);
      return rel !== LOCAL_SOURCE;
    };

    const result = writeResearchReport(
      vault,
      {
        title: "T",
        sources: [`[[${LOCAL_SOURCE}]]`, "Notes/open.md", URL_SOURCE],
        findings: [{ statement: "S", sources: [URL_SOURCE] }],
      },
      { agent: "claude", now: NOW, readable },
    );

    // The hidden file answers exactly as an absent one would.
    const expected = [CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.fullLocal, CAPTURE_SCOPE.urlOnly];
    expect(result.captureScopes).toEqual(expected);
    const [meta] = parseFrontmatter(join(vault, result.reportPath));
    expect(meta[CAPTURE_SCOPES_KEY]).toEqual(expected);
    // The predicate is asked about the normalised vault path, never the URL.
    expect(asked).toEqual([LOCAL_SOURCE, "Notes/open.md"]);
  });

  test("a source cited without its extension is the note beside it", () => {
    seed("notes/meeting.md");

    const result = report(["notes/meeting", "[[notes/meeting]]", "notes/absent"]);

    expect(result.captureScopes).toEqual([
      CAPTURE_SCOPE.fullLocal,
      CAPTURE_SCOPE.fullLocal,
      CAPTURE_SCOPE.urlOnly,
    ]);
  });

  test("the reach check reads the note an extensionless source resolves to", () => {
    seed("notes/meeting.md");
    const asked: string[] = [];

    const result = writeResearchReport(
      vault,
      {
        title: "T",
        sources: ["notes/meeting"],
        findings: [{ statement: "S", sources: ["notes/meeting"] }],
      },
      {
        agent: "claude",
        now: NOW,
        readable: (rel) => {
          asked.push(rel);
          return false;
        },
      },
    );

    expect(asked).toEqual(["notes/meeting.md"]);
    expect(result.captureScopes).toEqual([CAPTURE_SCOPE.urlOnly]);
  });

  test("a directory beside an extensionless source does not stand in for its note", () => {
    seed("notes/meeting.md");
    seed("notes/meeting/agenda.md");
    const asked: string[] = [];

    const result = writeResearchReport(
      vault,
      {
        title: "T",
        sources: ["notes/meeting"],
        findings: [{ statement: "S", sources: ["notes/meeting"] }],
      },
      {
        agent: "claude",
        now: NOW,
        readable: (rel) => {
          asked.push(rel);
          return rel !== "notes/meeting.md";
        },
      },
    );

    expect(asked).toEqual(["notes/meeting.md"]);
    expect(result.captureScopes).toEqual([CAPTURE_SCOPE.urlOnly]);
  });
});

describe("writeResearchReport when the filesystem refuses a source", () => {
  test.skipIf(CHMOD_CANNOT_DENY)(
    "an unreadable cited source is url-only at every reach and never aborts the report",
    () => {
      const locked = join(vault, "locked");
      seed("locked/inner/a.md");
      const sources = ["locked/inner/a.md", URL_SOURCE];
      const input = { title: "T", sources, findings: [{ statement: "S", sources: [URL_SOURCE] }] };
      chmodSync(locked, 0o000);
      try {
        const local = writeResearchReport(vault, input, { agent: "claude", now: NOW });
        expect(local.captureScopes).toEqual([CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.urlOnly]);

        const remote = writeResearchReport(
          vault,
          { ...input, title: "R" },
          { agent: "claude", now: NOW, readable: () => true },
        );
        expect(remote.captureScopes).toEqual([CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.urlOnly]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});
