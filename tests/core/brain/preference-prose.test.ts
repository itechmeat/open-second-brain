/**
 * A preference page's prose survives the move to the store (task 2.10,
 * FORMAT.md "Preferences"): a body that holds more than the fields render
 * (an imported memory's text, a writer's guidance, a person's notes) is the
 * preference's `text` field, a page rebuilt from the fold carries it as its
 * body, and a later agent write does not replace prose a human wrote.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildBacklinkIndex } from "../../../src/core/brain/backlinks.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import {
  derivedPreferenceBody,
  moveToRetired,
  preferencePageProse,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import {
  existingPreferencePageText,
  writePreferencePageText,
} from "../../../src/core/brain/preference-page-write.ts";
import { renderPreferenceBody } from "../../../src/core/brain/preference-body.ts";
import { readPreferences } from "../../../src/core/store/read/preferences.ts";
import { storeMemoryPage } from "../../../src/core/brain/memory-pages.ts";
import { formatFrontmatter, parseFrontmatterText } from "../../../src/core/vault.ts";
import type { StoreEnv } from "../store/fixtures/store-env.ts";
import { makeStoreEnv } from "../store/fixtures/store-env.ts";
import {
  FIXTURE_IDS,
  FIXTURE_NOW,
  IMPORTED_PROSE,
  mintedId,
  switchDevice,
  withMemoryFixture,
} from "./fixtures/memory-twins.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function proseAnswers(mode: "legacy" | "switched") {
  return withMemoryFixture(mode, (e) => ({
    text: readPreferences({ vault: e.vault })
      .filter((p) => p.fields["text"] !== undefined)
      .map((p) => [p.id, p.fields["text"]]),
    // The signal as this machine minted it: a switched one tags the id.
    backlinks: (buildBacklinkIndex(e.vault).get(mintedId(e.vault, FIXTURE_IDS.spaces)) ?? []).map(
      (r) => `${r.source}:${r.field}`,
    ),
  }));
}

describe("preference prose", () => {
  // Built inside the test lifecycle: a fixture that throws fails a hook
  // that names it, not the whole file at load time.
  let legacy: ReturnType<typeof proseAnswers>;
  let switched: ReturnType<typeof proseAnswers>;
  beforeAll(() => {
    legacy = proseAnswers("legacy");
    switched = proseAnswers("switched");
  });

  test("the prose a page body holds reads the same from the store as from the page", () => {
    expect(switched).toEqual(legacy);
    const byId = new Map(switched.text as Array<[string, string]>);
    expect(byId.get(FIXTURE_IDS.prefImported)).toContain(IMPORTED_PROSE);
    expect(byId.get(FIXTURE_IDS.prefNotes)).toContain("## How to apply");
    // A fields-only body carries no prose.
    expect(byId.has(FIXTURE_IDS.prefNaming)).toBe(false);
  });

  test("a link in the prose is a backlink on both machines", () => {
    expect(switched.backlinks).toContain(`${FIXTURE_IDS.prefImported}:body`);
  });

  test("the page view of a switched machine carries the prose as its body", () => {
    const body = withMemoryFixture("switched", (e) => storeMemoryPage(e.vault, "pref-imported"));
    expect(body?.body).toContain(IMPORTED_PROSE);
    expect(body?.meta["text"]).toBeUndefined();
  });

  test("a body the fields render is no prose", () => {
    const meta = { evidenced_by: ["[[sig-x]]"] };
    expect(preferencePageProse(meta, derivedPreferenceBody(meta, false), false)).toBeNull();
    expect(preferencePageProse(meta, "", false)).toBeNull();
    expect(preferencePageProse(meta, "A note.\n\n## Origin\n\n- [[sig-x]]", false)).toBe(
      "A note.\n\n## Origin\n\n- [[sig-x]]",
    );
  });
});

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-wp2b-prose-", { dualWrite: false });
  switchDevice(e);
  return e;
}

const basePref = {
  slug: "rule",
  topic: "rule",
  principle: "principle rule",
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-30T00:00:00Z",
  status: "unconfirmed" as const,
  evidenced_by: [] as string[],
};

function pageWithBody(vault: string, slug: string, body: string): string {
  const existing = existingPreferencePageText(vault, slug, (p) => readFileSync(p, "utf8"));
  if (existing === null) throw new Error("no preference");
  return formatFrontmatter(parseFrontmatterText(existing)[0], body);
}

describe("prose once switched", () => {
  test("prose a human wrote survives a later agent rewrite", () => {
    env = switchedEnv();
    writePreference(env.vault, basePref, { authority: "agent" });
    writePreferencePageText(env.vault, "rule", pageWithBody(env.vault, "rule", "Human notes."), {
      authority: "human",
    });
    writePreference(
      env.vault,
      { ...basePref, principle: "principle rule, reworded" },
      { overwrite: true, authority: "agent" },
    );
    // An agent page write with a fields-only body proposes no prose; the
    // human's prose wins by authority.
    writePreferencePageText(env.vault, "rule", pageWithBody(env.vault, "rule", ""), {
      authority: "agent",
    });
    const page = storeMemoryPage(env.vault, "pref-rule");
    expect(page?.body).toBe("Human notes.");
    expect(existingPreferencePageText(env.vault, "rule", () => null)).toContain("Human notes.");
  });

  test("a retire keeps the prose and adds the Retired section", () => {
    env = switchedEnv();
    writePreference(env.vault, basePref, { authority: "agent" });
    writePreferencePageText(env.vault, "rule", pageWithBody(env.vault, "rule", "Why it held."));
    moveToRetired(env.vault, preferencePath(env.vault, "rule"), "stale-no-evidence", {
      now: FIXTURE_NOW,
      retired_by: "[[Brain/log/2026-11-06]]",
      authority: "agent",
    });
    const page = storeMemoryPage(env.vault, "ret-rule");
    expect(page?.body.startsWith("Why it held.")).toBe(true);
    expect(page?.body).toContain("## Retired");
    expect(page?.body).toContain("Reason: `stale-no-evidence`");
  });
});

test("the writer's evidence sections are no prose", () => {
  const meta = { evidenced_by: ["[[sig-a]]"] } as never;
  const body = renderPreferenceBody({
    evidenced_by: ["[[sig-a]]"],
    recentApplied: [
      { artifact: "[[notes/x]]", timestamp: "2026-11-01T00:00:00Z", result: "applied" } as never,
    ],
    recentViolated: [
      { artifact: "[[notes/y]]", timestamp: "2026-11-02T00:00:00Z", result: "violated" } as never,
    ],
  });
  expect(preferencePageProse(meta, body, false)).toBeNull();
  expect(preferencePageProse(meta, `${body}\n\n## Notes\n\nMine.\n`, false)).toContain("Mine.");
});
