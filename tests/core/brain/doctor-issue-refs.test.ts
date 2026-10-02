/**
 * Every spelling a doctor finding names a record by.
 *
 * A finding is kept for a caller only when every artifact it names is
 * readable, and a preference retired after the finding's reference was
 * written lives on disk as `ret-<slug>`. Each place a finding can name the
 * record - its target, a source, a message wikilink - must therefore
 * answer to the retired spelling on its own, not only jointly.
 */

import { describe, expect, test } from "bun:test";

import { doctorIssueRefs } from "../../../src/core/brain/diagnostics.ts";

const VAULT = "vault-root";
const LIVE_ID = "pref-bygone";
const RETIRED_ID = "ret-bygone";
const PLAIN_MESSAGE = "a finding";

describe("doctorIssueRefs", () => {
  test("a target spelled pref- also names its retired spelling", () => {
    expect(doctorIssueRefs(VAULT, { target: LIVE_ID, message: PLAIN_MESSAGE })).toContain(
      RETIRED_ID,
    );
  });

  test("a message wikilink spelled pref- also names its retired spelling", () => {
    expect(doctorIssueRefs(VAULT, { message: `broken link to [[${LIVE_ID}]]` })).toContain(
      RETIRED_ID,
    );
  });

  test("a source spelled pref- also names its retired spelling", () => {
    expect(doctorIssueRefs(VAULT, { sources: [LIVE_ID], message: PLAIN_MESSAGE })).toContain(
      RETIRED_ID,
    );
  });
});
