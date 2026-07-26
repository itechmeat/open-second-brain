/**
 * `scripts/link-ratchet.ts` — the write and `--check` forms of the
 * broken-link ratchet gate (context-integrity-gates, unit G).
 *
 * The property that matters most here is the one `scripts/sync-version.ts`
 * establishes: `--check` is the SAME code path with writing disabled, so
 * what CI detects and what the write form records can never diverge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DANGLING_LINK_DEFINITION,
  LINK_RATCHET_FIX_COMMAND,
  LINK_RATCHET_SCHEMA_VERSION,
  parseCeiling,
} from "../../src/core/search/link-ratchet.ts";
import { CEILING_FILE, runLinkRatchet } from "../../scripts/link-ratchet.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;

interface Captured {
  readonly exitCode: number;
  readonly verdicts: unknown;
  readonly out: string;
  readonly err: string;
}

async function run(check: boolean): Promise<Captured> {
  let out = "";
  let err = "";
  const result = await runLinkRatchet({
    root,
    check,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { exitCode: result.exitCode, verdicts: result.verdicts, out, err };
}

function ceilingText(): string {
  return readFileSync(join(root, CEILING_FILE), "utf8");
}

function writeCeiling(subjects: ReadonlyArray<{ path: string; dangling: number }>): void {
  writeFileSync(
    join(root, CEILING_FILE),
    JSON.stringify(
      {
        schema_version: LINK_RATCHET_SCHEMA_VERSION,
        definition: DANGLING_LINK_DEFINITION,
        subjects,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/** A ceiling recorded under a definition this build no longer counts by. */
function writeLegacyCeiling(): void {
  writeFileSync(
    join(root, CEILING_FILE),
    JSON.stringify({
      schema_version: LINK_RATCHET_SCHEMA_VERSION,
      definition: "legacy-definition",
      subjects: [{ path: "subject", dangling: 99 }],
    }),
    "utf8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-ratchet-script-"));
  // Two broken links: [[gone]] and (missing.md). [[b]] resolves through
  // the read-time ladder (`b.md` exact), so the honest baseline is two.
  writeMd(
    join(root, "subject"),
    "a.md",
    ["# A", "", "[[b.md]] [[b]] [[gone]] [nope](missing.md)", ""].join("\n"),
  );
  writeMd(join(root, "subject"), "b.md", "# B\n");
  writeCeiling([{ path: "subject", dangling: 2 }]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the gate", () => {
  test("an unchanged vault at its ceiling passes both forms with no summary", async () => {
    const check = await run(true);
    expect(check.exitCode).toBe(0);
    expect(check.out).toContain("ok:");
    expect(check.err).toBe("");
  });

  test("a new broken link fails --check with exit 1 and names the fix command", async () => {
    appendFileSync(join(root, "subject", "a.md"), "\nAnd [[newly-broken]].\n");
    const check = await run(true);
    expect(check.exitCode).toBe(1);
    expect(check.out).toContain("RISE:");
    expect(check.err).toContain(LINK_RATCHET_FIX_COMMAND);
    // Refused, not recorded: the committed ceiling is untouched.
    expect(parseCeiling(ceilingText()).subjects[0]!.dangling).toBe(2);
  });

  test("fixing links and rerunning the write form lowers the ceiling", async () => {
    writeMd(join(root, "subject"), "a.md", "# A\n\n[[b.md]]\n");
    const write = await run(false);
    expect(write.exitCode).toBe(0);
    expect(parseCeiling(ceilingText()).subjects[0]!.dangling).toBe(0);
  });

  test("the detection code path is identical between the write and check forms", async () => {
    appendFileSync(join(root, "subject", "a.md"), "\nAnd [[newly-broken]].\n");
    const before = ceilingText();
    const check = await run(true);
    // The check form provably wrote nothing.
    expect(ceilingText()).toBe(before);
    const write = await run(false);
    // ... and reached exactly the same verdicts from the same inputs.
    expect(write.verdicts).toEqual(check.verdicts);
    expect(ceilingText()).not.toBe(before);
  });

  test("a subject that cannot be measured fails BOTH forms and is not silently recorded", async () => {
    writeCeiling([{ path: "no-such-directory", dangling: 0 }]);
    const before = ceilingText();
    const [checkForm, writeForm] = [await run(true), await run(false)];
    for (const r of [checkForm, writeForm]) {
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain("UNMEASURABLE:");
      expect(r.err).toContain("could not be measured");
    }
    expect(ceilingText()).toBe(before);
  });

  test("a ceiling file recorded under a foreign definition fails --check rather than comparing", async () => {
    writeLegacyCeiling();
    const r = await run(true);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("definition");
  });

  test("the write form re-measures a foreign definition instead of deadlocking on it", async () => {
    // The refusal above names `bun run link-ratchet` as the fix, so that
    // command must actually be able to record the new definition -
    // otherwise a definition change can never be adopted.
    writeLegacyCeiling();
    const write = await run(false);
    expect(write.exitCode).toBe(0);
    // The stale count (99) is replaced by a real measurement under the
    // current rule, and the recorded definition follows it.
    const recorded = parseCeiling(ceilingText());
    expect(recorded.definition).toBe(DANGLING_LINK_DEFINITION);
    expect(recorded.subjects[0]!.dangling).toBe(2);
    // An incomparable number is never dressed up as a rise or a drop.
    expect(write.out).toContain("REDEFINED:");
    expect(write.out).not.toContain("RISE:");
  });
});

describe("the committed ceiling", () => {
  test("parses under the current schema version and definition token", () => {
    const ceiling = parseCeiling(readFileSync(join(REPO_ROOT, CEILING_FILE), "utf8"));
    expect(ceiling.schema_version).toBe(LINK_RATCHET_SCHEMA_VERSION);
    expect(ceiling.definition).toBe(DANGLING_LINK_DEFINITION);
    expect(ceiling.subjects.length).toBeGreaterThan(0);
  });

  test("is byte-identical to what the writer would emit (no formatter drift)", async () => {
    const text = readFileSync(join(REPO_ROOT, CEILING_FILE), "utf8");
    const { serializeCeiling } = await import("../../src/core/search/link-ratchet.ts");
    expect(serializeCeiling(parseCeiling(text))).toBe(text);
  });
});
