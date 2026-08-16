/**
 * Behaviour breaks are written down where the operator looks
 * (a-label-is-not-a-boundary review, C4).
 *
 * `docs/stability.md` lists "tightening validation so previously accepted
 * input is rejected" verbatim as a breaking change, and says breaking
 * changes are listed in `docs/updating.md`. 1.49.0 shipped six such
 * changes as a MINOR release with no section there at all - so the only
 * way to discover any of them was to hit one.
 *
 * The table below is the contract: each entry names one shipped break and
 * a token that must appear in the upgrade note. It is not a prose check -
 * the tokens are the identifiers an operator would search for (the flag,
 * the config key, the error code), so a section rewritten in different
 * words still passes and a section that drops a break does not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const UPDATING = join(REPO_ROOT, "docs", "updating.md");
const CLI_REFERENCE = join(REPO_ROOT, "docs", "cli-reference.md");

/** The release whose breaks this table describes. */
const RELEASE = "1.49.0";

/**
 * One shipped behaviour break -> the tokens the upgrade note must carry
 * for it. Every token, not any: an entry that names the surface but not
 * the new value leaves the reader mid-repair.
 */
const DISCLOSED_BREAKS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  "recall-gate argument pairing": ["match_quality", "scores", "INVALID_PARAMS"],
  "export refuses an unreadable preference": [
    "o2b brain export",
    "o2b brain bank-export",
    "o2b brain explorer --export",
  ],
  "bank-import keeps importing": ["o2b brain bank-import", "topic-key check incomplete"],
  "explorer live mode refuses to start": ["live mode"],
  "export content changes under the redactor": ["redactor"],
  "feedback --json mirror vocabulary": [
    "o2b brain feedback --json",
    "mirror_reason",
    "misconfigured",
  ],
  "four thresholds read a different quantity": [
    "recall_adequacy_sufficient",
    "search_chain_stop_score",
    "GAP_LOOP_AUTO_CLOSE_FLOOR",
    "RECALL_INJECT_CONFIDENCE_FLOOR",
    "idf_weighted_coverage",
  ],
});

/**
 * Verbs whose behaviour changed and whose one-line entry in the CLI
 * reference is what an operator reads first. The upgrade note is where
 * someone who already knows something changed goes; this is where
 * everybody else is.
 */
const CLI_REFERENCE_TOKENS: ReadonlyArray<string> = Object.freeze([
  "o2b brain export ",
  "o2b brain bank-export ",
  "o2b brain bank-import ",
  "o2b brain explorer ",
]);

describe(`docs/updating.md discloses the ${RELEASE} behaviour breaks`, () => {
  const updating = readFileSync(UPDATING, "utf8");

  test("the release has a section of its own", () => {
    expect(updating).toContain(`## Upgrading to ${RELEASE}`);
  });

  for (const [name, tokens] of Object.entries(DISCLOSED_BREAKS)) {
    test(`it covers: ${name}`, () => {
      // Named, not counted: the failure has to say which token is absent.
      const absent = tokens.filter((token) => !updating.includes(token));
      expect(absent).toEqual([]);
    });
  }
});

describe("the CLI reference says it too", () => {
  const reference = readFileSync(CLI_REFERENCE, "utf8");

  test("every changed verb has an entry", () => {
    const absent = CLI_REFERENCE_TOKENS.filter((token) => !reference.includes(token));
    expect(absent).toEqual([]);
  });

  test("each of those entries names the change rather than only the verb", () => {
    // The four lines were byte-identical to their pre-release form while
    // three of the verbs had gained a new non-zero exit and the fourth a
    // new refusal, so presence alone is not the assertion.
    const lines = reference.split("\n");
    const undated = CLI_REFERENCE_TOKENS.filter(
      (token) => !lines.some((line) => line.includes(token) && line.includes(`v${RELEASE}`)),
    );
    expect(undated).toEqual([]);
  });
});
