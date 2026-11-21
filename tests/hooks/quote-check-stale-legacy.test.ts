/**
 * The quote check on a switched machine whose legacy `Brain/` tree is
 * still on disk: the store holds the operator's standing rules and every
 * other `Brain/` page there, so a legacy file edited after the switch is
 * a stale copy. Before the fix a quote of it was checked against that
 * stale file; it now reads `unavailable` (reported `note-unavailable`,
 * never an all-clear), while a user note outside `Brain/` still reads.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evidenceFor } from "../../hooks/answer-quote-check.ts";
import { digestDeliveredText } from "../../hooks/lib/injection-ledger.ts";
import { checkAnswerQuotes } from "../../src/core/brain/answer-quotes/check.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

test("a legacy Brain/ file on a switched machine is not quote evidence", () => {
  env = makeStoreEnv("osb-quote-stale-");
  switchDevice(env.storeRoot);
  writeFileSync(join(env.vault, "Brain", "standing-rules.md"), "Stale text after the switch.\n");
  mkdirSync(join(env.vault, "notes"), { recursive: true });
  writeFileSync(join(env.vault, "notes", "otters.md"), "Feed the otters.\n");

  expect(evidenceFor(env.vault, { at: 0, path: "Brain/standing-rules.md" })).toEqual({
    kind: "unavailable",
  });
  // A name that starts with `..` is a page inside `Brain/`, not a parent step.
  writeFileSync(join(env.vault, "Brain", "..rules.md"), "Stale dotted page.\n");
  expect(evidenceFor(env.vault, { at: 0, path: "Brain/..rules.md" })).toEqual({
    kind: "unavailable",
  });
  expect(evidenceFor(env.vault, { at: 0, path: "notes/otters.md" })).toEqual({
    kind: "text",
    text: "Feed the otters.\n",
    truncated: false,
  });
});

test("a preference page is judged against the bullet the session received, never a later read", () => {
  env = makeStoreEnv("osb-quote-stored-pref-");
  switchDevice(env.storeRoot);
  writePreference(env.vault, {
    slug: "otters",
    topic: "otters",
    principle: "Feed the otters after the herons.",
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
  });
  mkdirSync(join(env.vault, "Brain", "preferences"), { recursive: true });
  writeFileSync(
    join(env.vault, "Brain", "preferences", "pref-otters.md"),
    "---\nprinciple: A stale rule.\n---\n",
  );
  const path = "Brain/preferences/pref-otters.md";
  // Without a delivered bullet the page is no evidence on a switched vault:
  // neither the stale file nor the store's page as it reads now.
  expect(evidenceFor(env.vault, { at: 0, path })).toEqual({ kind: "unavailable" });

  // The session start delivered the older rule; the store has a newer one.
  const delivered = new Map([
    [path, { text: "- `pref-otters` Feed the otters before the herons.", truncated: false }],
  ]);
  const evidence = evidenceFor(env.vault, { at: 0, path }, undefined, delivered);
  expect(evidence).toEqual({
    kind: "text",
    text: "- `pref-otters` Feed the otters before the herons.",
    truncated: false,
  });
  const quote = (span: string) =>
    checkAnswerQuotes({ spans: [span], evidence }).outcomes.map((o) => o.verdict);
  expect(quote("Feed the otters before the herons.")).toEqual(["verified"]);
  // The newer text was never delivered: it does not verify against the page.
  expect(quote("Feed the otters after the herons.")).toEqual(["not-in-note"]);
  expect(quote("A stale rule.")).toEqual(["not-in-note"]);
  // A line range of a page delivered as one bullet names nothing delivered.
  expect(
    evidenceFor(env.vault, { at: 0, path, startLine: 1, endLine: 2 }, undefined, delivered),
  ).toEqual({
    kind: "unavailable",
  });
});

test("a bullet the host ceiling cut mid-line is recorded and judged truncated", () => {
  const source = "## Confirmed\n\n- `pref-otters` Feed the otters before the herons, every day.\n";
  // The cut kept only the head of the bullet's line.
  const emitted = "## Confirmed\n\n- `pref-otters` Feed the otters before\n\n(cut)";
  const recorded = digestDeliveredText({ emittedText: emitted, sourceText: source });
  const path = "Brain/preferences/pref-otters.md";
  expect(recorded[path]).toEqual({
    text: "- `pref-otters` Feed the otters before",
    truncated: true,
  });
  // A whole line stays plain text.
  expect(digestDeliveredText({ emittedText: source, sourceText: source })[path]).toBe(
    "- `pref-otters` Feed the otters before the herons, every day.",
  );
  const evidence = evidenceFor(
    "/nonexistent-vault",
    { at: 0, path },
    undefined,
    new Map([[path, { text: "- `pref-otters` Feed the otters before", truncated: true }]]),
  );
  expect(evidence).toMatchObject({ kind: "text", truncated: true });
  // The undelivered tail is no plain miss: the source was cut.
  expect(
    checkAnswerQuotes({ spans: ["Feed the otters before the herons"], evidence }).outcomes.map(
      (o) => o.verdict,
    ),
  ).toEqual(["source-truncated"]);
});
