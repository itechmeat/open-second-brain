#!/usr/bin/env bun
/**
 * Vault-wide broken-link ratchet gate (context-integrity-gates, unit G).
 *
 * Measures every vault root named in `link-ratchet.json` and compares
 * the broken-link count against the committed ceiling.
 *
 * A link is broken when the READ-TIME resolution ladder cannot resolve
 * it - the same ladder the readers follow, shared from `store.ts`. The
 * narrower `target_document_id IS NULL` predicate this gate first
 * shipped with counted every basename wikilink as broken (55 of 55 rows
 * on `templates/brain-starter`), so it rose on healthy edits; the
 * definition token in the ceiling file records which rule produced a
 * number, and a ceiling written under the old one is refused rather
 * than compared. The write form
 * records what it measured; the `--check` form is the SAME code path
 * with writing disabled, so what CI detects and what the write form
 * records can never diverge - the shape `scripts/sync-version.ts`
 * establishes, and the reason both forms are gated in both workflows.
 *
 * Exit codes:
 *   0  every subject is at or below its ceiling
 *   1  a subject rose above its ceiling (`--check` only), a subject
 *      could not be measured (BOTH forms - a gate that passes without a
 *      count is the failure this exists to remove), or the ceiling file
 *      cannot be compared (foreign schema version or definition token).
 *
 * The ceiling is a MEASUREMENT, not a target: it encodes whatever link
 * rot existed when it was last written. Raising it is a deliberate,
 * reviewable line in a diff - which is why the write form records a
 * rise instead of refusing it, and why only `--check` fails on one.
 *
 * Usage:
 *   bun run link-ratchet          # measure and record
 *   bun run link-ratchet:check    # exit 1 on a rise, no writes
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DANGLING_LINK_DEFINITION,
  LINK_RATCHET_FIX_COMMAND,
  judgeSubject,
  measureVault,
  parseCeiling,
  serializeCeiling,
  type LinkRatchetCeiling,
  type LinkRatchetVerdict,
} from "../src/core/search/link-ratchet.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Repository-relative location of the committed ceiling. */
export const CEILING_FILE = "link-ratchet.json";

const LABEL_WIDTH = 14;

export interface LinkRatchetRunOptions {
  /** Directory holding `link-ratchet.json`; subjects resolve against it. */
  readonly root: string;
  /** When true, nothing is written. Detection is unaffected. */
  readonly check: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface LinkRatchetRun {
  readonly exitCode: number;
  readonly verdicts: ReadonlyArray<LinkRatchetVerdict>;
}

function label(text: string): string {
  return `  ${`${text}:`.padEnd(LABEL_WIDTH)}`;
}

function describe(verdict: LinkRatchetVerdict): string {
  const m = verdict.measurement;
  if (!m.measurable) {
    return `${label("UNMEASURABLE")}${verdict.subject} (${m.reason}: ${m.detail})`;
  }
  const status = verdict.status === "level" ? "ok" : verdict.status.toUpperCase();
  return (
    `${label(status)}${verdict.subject} ` +
    `(dangling ${m.dangling} of ${m.links} link row(s), ceiling ${verdict.ceiling})`
  );
}

/**
 * Write the recorded ceiling when `write` is true. The single write
 * guard in this file: with `write` false the comparison above it has
 * already run, unchanged.
 */
function updateCeilingFile(path: string, next: LinkRatchetCeiling, write: boolean): boolean {
  const text = readFileSync(path, "utf8");
  const updated = serializeCeiling(next);
  if (updated === text) return false;
  if (write) writeFileSync(path, updated, "utf8");
  return true;
}

export async function runLinkRatchet(opts: LinkRatchetRunOptions): Promise<LinkRatchetRun> {
  const path = join(opts.root, CEILING_FILE);
  let ceiling: LinkRatchetCeiling;
  try {
    // Only the write form may read a ceiling recorded under an older
    // counting definition - it is the command the refusal names as the
    // fix, so it has to be able to re-measure and record the new one.
    ceiling = parseCeiling(readFileSync(path, "utf8"), { allowForeignDefinition: !opts.check });
  } catch (e) {
    opts.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1, verdicts: [] };
  }

  opts.stdout(`canonical definition: ${DANGLING_LINK_DEFINITION}\n`);
  const comparable = ceiling.definition === DANGLING_LINK_DEFINITION;
  if (!comparable) {
    opts.stdout(
      `${label("redefining")}recorded under '${ceiling.definition}'; ` +
        "every subject is re-measured and the committed counts are replaced\n",
    );
  }

  // Each subject is measured in its own temporary workspace, so the
  // order of resolution cannot affect any result; reporting is in
  // committed-file order regardless.
  const verdicts: ReadonlyArray<LinkRatchetVerdict> = await Promise.all(
    ceiling.subjects.map(async (subject) =>
      judgeSubject(
        subject.path,
        subject.dangling,
        await measureVault(join(opts.root, subject.path)),
        { comparable },
      ),
    ),
  );
  for (const verdict of verdicts) opts.stdout(`${describe(verdict)}\n`);

  const risen = verdicts.filter((v) => v.status === "rise");
  const unmeasured = verdicts.filter((v) => v.status === "unmeasurable");

  // A partial recording would silently invent a ceiling for a subject
  // nobody measured, so an unmeasurable subject blocks the write too.
  if (unmeasured.length === 0) {
    const next: LinkRatchetCeiling = {
      ...ceiling,
      // What is recorded is what THIS build counted, never the token the
      // file happened to carry.
      definition: DANGLING_LINK_DEFINITION,
      subjects: verdicts.map((v) => ({
        path: v.subject,
        dangling: v.measurement.measurable ? v.measurement.dangling : v.ceiling,
      })),
    };
    if (updateCeilingFile(path, next, !opts.check) && !opts.check) {
      opts.stdout(`${label("wrote")}${CEILING_FILE}\n`);
    }
  }

  if (unmeasured.length > 0) {
    opts.stderr(
      `\n${unmeasured.length} subject(s) could not be measured; the ratchet has no count to ` +
        "compare and will not pass. Fix the subject path or the index error named above.\n",
    );
    return { exitCode: 1, verdicts };
  }
  if (opts.check && risen.length > 0) {
    opts.stderr(
      `\n${risen.length} subject(s) above ceiling; fix the broken links, or record the new ` +
        `baseline (a reviewable diff) with: ${LINK_RATCHET_FIX_COMMAND}\n`,
    );
    return { exitCode: 1, verdicts };
  }
  return { exitCode: 0, verdicts };
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const check = argv.includes("--check");
  const run = await runLinkRatchet({
    root: ROOT,
    check,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  return run.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
