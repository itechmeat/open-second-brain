/**
 * The one-off pledge page family (`Brain/pledges/`): a promise made in
 * prose, with a due date, a cited source page and evidence quotes verified
 * against that source at write time. Mirrors the recurring-obligation
 * family's CRUD discipline; the acceptance cases below are the ones the
 * wave plan pins for A1.
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPledge,
  fulfillPledge,
  listPledges,
  noPledgeError,
  pledgeExists,
  removePledge,
  showPledge,
  PledgeError,
} from "../../../src/core/brain/pledges.ts";
import { formatFrontmatter, parseFrontmatter } from "../../../src/core/vault.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
import { acquireLockSync, LOCK_WAIT_BUDGET_ENV } from "../../../src/core/brain/sync-lockfile.ts";

const NOW = new Date("2026-06-19T12:00:00Z");

const SOURCE_REL = "notes/team-meeting.md";
const SOURCE_TEXT = [
  "We synced on the rollout plan.",
  "",
  "- Ada asked for a written recap of the migration steps.",
  "- The storage budget review moves to next quarter.",
  "",
  "Grace will review the incident timeline before Friday.",
].join("\n");

/** Every pledge in this suite cites this source page, so containment is real. */
function cite(evidence: string[]): Parameters<typeof addPledge>[1] {
  return {
    title: "Recap pledge",
    due: "2026-06-25",
    source: SOURCE_REL,
    evidence,
    agent: "test-agent",
    now: NOW,
  };
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledges-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("addPledge creates a page under Brain/pledges and reads back round-trip", () => {
  const page = addPledge(vault, {
    title: "Send Ada the migration recap",
    due: "2026-06-25",
    source: SOURCE_REL,
    evidence: ["Ada asked for a written recap of the migration steps"],
    text: "Send the written migration recap to Ada.",
    notes: "She asked twice.",
    counterparties: ["ent-people-ada"],
    agent: "test-agent",
    now: NOW,
  });
  expect(page.slug).toBe("send-ada-the-migration-recap");
  expect(page.path.endsWith(join("Brain", "pledges", "send-ada-the-migration-recap.md"))).toBe(
    true,
  );
  const raw = readFileSync(page.path, "utf8");
  for (const key of [
    "title:",
    "created_at:",
    "due:",
    "source:",
    "evidence:",
    "promised_to:",
    "fulfilled:",
    "agent:",
  ]) {
    expect(raw).toContain(key);
  }
  expect(raw).toContain("due: 2026-06-25");
  expect(pledgeExists(vault, page.slug)).toBe(true);

  const shown = showPledge(vault, { slug: page.slug });
  expect(shown).not.toBeNull();
  expect(shown!.title).toBe("Send Ada the migration recap");
  expect(shown!.due).toBe("2026-06-25");
  expect(shown!.source).toBe(SOURCE_REL);
  expect(shown!.evidence).toEqual(["Ada asked for a written recap of the migration steps"]);
  expect(shown!.counterparties).toEqual(["ent-people-ada"]);
  expect(shown!.fulfilled).toBeNull();
  expect(shown!.text).toBe("Send the written migration recap to Ada.");
  expect(shown!.notes).toBe("She asked twice.");
  expect(shown!.agent).toBe("test-agent");
  expect(shown!.createdAt).toBe("2026-06-19T12:00:00Z");
  // The round-trip alone would echo the injected instant even from a broken
  // formatter, so pin the canonical shape independently: whole-second UTC,
  // no milliseconds and no date-only fallback.
  expect(shown!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  expect(raw).toMatch(/^created_at: "?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"?$/mu);
});

test("addPledge accepts a [[wikilink]] source reference and stores the vault path", () => {
  // A differently spelled source - backslash separators and surrounding
  // whitespace - proves normalization, where echoing the input would not.
  const page = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    source: "  notes\\team-meeting.md  ",
  });
  expect(page.source).toBe(SOURCE_REL);
  const linked = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Linked source pledge",
    source: `[[${SOURCE_REL}]]`,
  });
  expect(linked.source).toBe(SOURCE_REL);
});

test("addPledge refuses a taken slug with a named error", () => {
  addPledge(vault, cite(["Grace will review the incident timeline"]));
  let duplicate: unknown;
  try {
    addPledge(vault, cite(["Grace will review the incident timeline"]));
  } catch (err) {
    duplicate = err;
  }
  expect(duplicate).toBeInstanceOf(PledgeError);
  expect((duplicate as Error).name).toBe("PledgeError");
  expect(noPledgeError("x").name).toBe("PledgeError");
  expect(() => addPledge(vault, cite(["Grace will review the incident timeline"]))).toThrow(
    /pledge already exists: recap-pledge/,
  );
  expect(() => addPledge(vault, cite(["Grace will review the incident timeline"]))).toThrow(
    PledgeError,
  );
});

test("addPledge honors the pledge-path lock and still refuses a taken slug after release", () => {
  const path = join(vault, "Brain", "pledges", "recap-pledge.md");
  const held = acquireLockSync(path);
  const originalBudget = process.env[LOCK_WAIT_BUDGET_ENV];
  let collision: unknown;
  try {
    process.env[LOCK_WAIT_BUDGET_ENV] = "0";
    try {
      addPledge(vault, cite(["Grace will review the incident timeline"]));
    } catch (err) {
      collision = err;
    }
  } finally {
    held.release();
    if (originalBudget === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
    else process.env[LOCK_WAIT_BUDGET_ENV] = originalBudget;
  }
  expect((collision as NodeJS.ErrnoException | undefined)?.code).toBe("ELOCKED");
  expect(existsSync(path)).toBe(false);
  const page = addPledge(vault, cite(["Grace will review the incident timeline"]));
  const before = readFileSync(page.path, "utf8");
  expect(() => addPledge(vault, cite(["Grace will review the incident timeline"]))).toThrow(
    PledgeError,
  );
  expect(readFileSync(page.path, "utf8")).toBe(before);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("addPledge refuses a missing, empty or non-ISO due date", () => {
  const withoutDue = {
    title: "Recap pledge",
    source: SOURCE_REL,
    evidence: ["Grace will review the incident timeline"],
    agent: "test-agent",
    now: NOW,
  } as unknown as Parameters<typeof addPledge>[1];
  expect(() => addPledge(vault, withoutDue)).toThrow(PledgeError);
  expect(() => addPledge(vault, withoutDue)).toThrow(/due is not a valid calendar date: undefined/);
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "",
    }),
  ).toThrow(PledgeError);
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "",
    }),
  ).toThrow(/due is not a valid calendar date: ""/);
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "2026-13-40",
    }),
  ).toThrow(/not a valid calendar date/);
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      due: "next Friday",
    }),
  ).toThrow(PledgeError);
  // The due check runs before the lock and the write: no page, and not even
  // the pledges directory, may exist after any of these refusals.
  expect(pledgeExists(vault, "recap-pledge")).toBe(false);
  expect(existsSync(join(vault, "Brain", "pledges"))).toBe(false);
});

test("addPledge refuses an empty evidence list", () => {
  expect(() => addPledge(vault, { ...cite([]) })).toThrow(/evidence/);
  expect(() => addPledge(vault, { ...cite(["   "]) })).toThrow(/evidence/);
});

test("addPledge refuses a quote absent from the source page", () => {
  expect(() => addPledge(vault, { ...cite(["The board approved unlimited headcount"]) })).toThrow(
    /does not occur in the source page/,
  );
  expect(() => addPledge(vault, { ...cite(["The board approved unlimited headcount"]) })).toThrow(
    PledgeError,
  );
});

test("addPledge refuses a source page the vault does not hold", () => {
  expect(() =>
    addPledge(vault, {
      title: "Ghost source",
      due: "2026-06-25",
      source: "notes/absent.md",
      evidence: ["anything"],
      agent: "a",
      now: NOW,
    }),
  ).toThrow(/source page not found/);
});

test("addPledge refuses a source path that names a directory with the same named error", () => {
  // A directory exists, so the existence probe alone would let the read
  // through and the failure would surface as a raw fs error past the
  // typed error boundary.
  expect(() =>
    addPledge(vault, {
      title: "Directory source",
      due: "2026-06-25",
      source: "notes",
      evidence: ["anything"],
      agent: "a",
      now: NOW,
    }),
  ).toThrow(PledgeError);
  expect(() =>
    addPledge(vault, {
      title: "Directory source",
      due: "2026-06-25",
      source: "notes",
      evidence: ["anything"],
      agent: "a",
      now: NOW,
    }),
  ).toThrow(/source page not found/);
});

test("addPledge refuses an unreadable source before reading it", () => {
  // Reading this directory as a page would throw EISDIR instead of the reach refusal.
  rmSync(join(vault, SOURCE_REL));
  mkdirSync(join(vault, SOURCE_REL));
  const checked: string[] = [];
  const input = {
    ...cite(["Grace will review the incident timeline"]),
    source: `[[${SOURCE_REL}]]`,
    readable: (rel: string) => {
      checked.push(rel);
      return false;
    },
  };
  const refuse = () => addPledge(vault, input);
  expect(refuse).toThrow(PledgeError);
  expect(refuse).toThrow(/source page is not readable or absent/);
  expect(checked).toEqual([SOURCE_REL, SOURCE_REL]);
  expect(pledgeExists(vault, "recap-pledge")).toBe(false);
});

test("addPledge inherits source visibility and omits it for public sources", () => {
  const publicPage = addPledge(vault, cite(["Grace will review the incident timeline"]));
  expect(parseFrontmatter(publicPage.path)[0]).not.toHaveProperty("visibility");
  writeFileSync(
    join(vault, SOURCE_REL),
    `---\nvisibility: ${REMOTE_DENY_VISIBILITY_TOKEN}\n---\n\n${SOURCE_TEXT}`,
  );
  const privatePage = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Private-source pledge",
  });
  expect(parseFrontmatter(privatePage.path)[0]["visibility"]).toEqual([
    REMOTE_DENY_VISIBILITY_TOKEN,
  ]);
});

test("addPledge inherits an informal privacy marker from the source", () => {
  // No `visibility:` key - the reservation is stated only under the
  // pre-convention informal key, and the evidence quotes the source, so
  // the derived page must inherit the reservation through the union.
  writeFileSync(join(vault, SOURCE_REL), `---\naccess: private\n---\n\n${SOURCE_TEXT}`, "utf8");
  const page = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Marker-source pledge",
  });
  expect(parseFrontmatter(page.path)[0]["visibility"]).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
});

test("evidence containment forgives presentation, never wording", () => {
  // The shared comparator strips Markdown emphasis and line markers, so a
  // quote over a list item or emphasis passes; wording and word boundaries
  // never bend ("view" must not verify inside "review").
  const page = addPledge(vault, cite(["budget review moves to next quarter"]));
  expect(page.evidence).toEqual(["budget review moves to next quarter"]);
  expect(() => addPledge(vault, { ...cite(["view moves to next quarter"]) })).toThrow(PledgeError);
});

test("addPledge refuses a forged notes header in text or notes without writing", () => {
  for (const field of ["text", "notes"] as const) {
    for (const header of ["## Notes", "  ## Notes  "]) {
      expect(() =>
        addPledge(vault, {
          ...cite(["Grace will review the incident timeline"]),
          [field]: `Promise line one.\n${header}\nPromise line two.`,
        }),
      ).toThrow(PledgeError);
      expect(pledgeExists(vault, "recap-pledge")).toBe(false);
    }
  }
});

test("addPledge refuses an empty title", () => {
  expect(() =>
    addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "   " }),
  ).toThrow(/title must not be empty/);
});

test("fulfillPledge stamps the fulfillment date and refuses a second stamp", () => {
  addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const done = fulfillPledge(vault, { slug: "recap-pledge", date: "2026-06-20" });
  expect(done.fulfilled).toBe("2026-06-20");
  expect(showPledge(vault, { slug: "recap-pledge" })!.fulfilled).toBe("2026-06-20");
  expect(() => fulfillPledge(vault, { slug: "recap-pledge" })).toThrow(/already fulfilled/);
});

test("fulfill preserves visibility and unknown frontmatter keys", () => {
  const page = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    text: "Review the timeline.",
    notes: "Keep the record.",
  });
  const [meta, body] = parseFrontmatter(page.path);
  meta["visibility"] = [REMOTE_DENY_VISIBILITY_TOKEN];
  meta["review_marker"] = ["hand-added", "retain"];
  meta["owner"] = "operator";
  writeFileSync(page.path, formatFrontmatter(meta, body));
  fulfillPledge(vault, { slug: page.slug, date: "2026-06-20" });
  const [after, afterBody] = parseFrontmatter(page.path);
  expect(after).toEqual({ ...meta, fulfilled: "2026-06-20" });
  expect(afterBody).toBe(body);
});

test("fulfillPledge defaults the date to the injected now and shares the no-pledge refusal", () => {
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Timeline pass",
  });
  const done = fulfillPledge(vault, { slug: "timeline-pass", now: NOW });
  expect(done.fulfilled).toBe("2026-06-19");
  expect(() => fulfillPledge(vault, { slug: "ghost" })).toThrow(noPledgeError("ghost"));
  expect(() => removeAbsentPledge()).toThrow(/no pledge: ghost/);
});

// The no-pledge refusal is one named error shared by every slug-addressed
// operation; this helper keeps that assertion next to the error import.
function removeAbsentPledge(): unknown {
  return removePledge(vault, { slug: "ghost" });
}

test("listPledges sorts by due then slug with overdue and daysUntilDue boundaries", () => {
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Beta yesterday",
    due: "2026-06-18",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Alpha yesterday",
    due: "2026-06-18",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Today item",
    due: "2026-06-19",
  });
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Tomorrow item",
    due: "2026-06-20",
  });

  for (const title of ["Zeta undated", "Alpha undated"]) {
    const page = addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      title,
    });
    writeFileSync(
      page.path,
      readFileSync(page.path, "utf8").replace(`due: ${page.due}`, "due: invalid"),
    );
  }

  const items = listPledges(vault, { now: NOW });
  expect(items.map((i) => i.slug)).toEqual([
    "alpha-yesterday",
    "beta-yesterday",
    "today-item",
    "tomorrow-item",
    "alpha-undated",
    "zeta-undated",
  ]);
  expect(items[0]!.overdue).toBe(true);
  expect(items[0]!.daysUntilDue).toBe(-1);
  expect(items[1]!.overdue).toBe(true);
  expect(items[2]!.overdue).toBe(false);
  expect(items[2]!.daysUntilDue).toBe(0);
  expect(items[3]!.daysUntilDue).toBe(1);
  expect(items[4]!.daysUntilDue).toBeNull();
  expect(items[4]!.overdue).toBe(false);
  expect(items[5]!.daysUntilDue).toBeNull();
  expect(items[0]!.title).toBe("Alpha yesterday");
  expect(items[0]!.source).toBe(SOURCE_REL);
});

test("listPledges hides fulfilled pledges unless includeFulfilled", () => {
  addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "Done deal" });
  addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title: "Still open" });
  fulfillPledge(vault, { slug: "done-deal", date: "2026-06-19" });
  expect(listPledges(vault, { now: NOW }).map((i) => i.slug)).toEqual(["still-open"]);
  const withDone = listPledges(vault, { now: NOW, includeFulfilled: true });
  expect(withDone.map((i) => i.slug).toSorted()).toEqual(["done-deal", "still-open"]);
  expect(withDone.find((i) => i.slug === "done-deal")!.fulfilled).toBe("2026-06-19");
});

test("fulfillPledge honors the pledge-path lock across its read and write", () => {
  // The stamp is a read-modify-write of the whole frontmatter: holding the
  // page's lock must hold the writer off, or a fulfill racing the intake's
  // re-anchor rewrite can silently drop one of the two edits.
  const page = addPledge(vault, cite(["Grace will review the incident timeline"]));
  const held = acquireLockSync(page.path);
  const originalBudget = process.env[LOCK_WAIT_BUDGET_ENV];
  let collision: unknown;
  try {
    process.env[LOCK_WAIT_BUDGET_ENV] = "0";
    try {
      fulfillPledge(vault, { slug: page.slug });
    } catch (err) {
      collision = err;
    }
  } finally {
    held.release();
    if (originalBudget === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
    else process.env[LOCK_WAIT_BUDGET_ENV] = originalBudget;
  }
  expect((collision as NodeJS.ErrnoException | undefined)?.code).toBe("ELOCKED");
  expect(showPledge(vault, { slug: page.slug })!.fulfilled).toBeNull();
  fulfillPledge(vault, { slug: page.slug, date: "2026-06-19" });
  expect(showPledge(vault, { slug: page.slug })!.fulfilled).toBe("2026-06-19");
});

test("listPledges reports a fulfilled past-due pledge as not overdue", () => {
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Late but done",
    due: "2026-06-10",
  });
  fulfillPledge(vault, { slug: "late-but-done", date: "2026-06-18" });
  const items = listPledges(vault, { now: NOW, includeFulfilled: true });
  expect(items).toHaveLength(1);
  expect(items[0]!.fulfilled).toBe("2026-06-18");
  // Overdue is a fact about an OPEN promise: a done pledge reports false
  // however long past its due date, so an overdue filter never shows it.
  expect(items[0]!.overdue).toBe(false);
  // The calendar delta itself is unchanged: nine days past due.
  expect(items[0]!.daysUntilDue).toBe(-9);
});

test("removePledge honors the pledge-path lock across the archive move", () => {
  const page = addPledge(vault, cite(["Grace will review the incident timeline"]));
  const held = acquireLockSync(page.path);
  const originalBudget = process.env[LOCK_WAIT_BUDGET_ENV];
  let collision: unknown;
  try {
    process.env[LOCK_WAIT_BUDGET_ENV] = "0";
    try {
      removePledge(vault, { slug: page.slug });
    } catch (err) {
      collision = err;
    }
  } finally {
    held.release();
    if (originalBudget === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
    else process.env[LOCK_WAIT_BUDGET_ENV] = originalBudget;
  }
  expect((collision as NodeJS.ErrnoException | undefined)?.code).toBe("ELOCKED");
  expect(pledgeExists(vault, page.slug)).toBe(true);
});

test("removePledge names the absent pledge when the page vanishes under the lock", async () => {
  // Two removers can pass an existence probe taken before the lock and then
  // race the archive move: the winner renames the page, and the loser's
  // fallback reads the vanished file. The refusal must be the shared named
  // no-pledge error, not the fallback arm's raw ENOENT.
  const page = addPledge(vault, cite(["Grace will review the incident timeline"]));
  const child = join(vault, "remove-pledge.ts");
  writeFileSync(
    child,
    [
      `import { removePledge } from ${JSON.stringify(join(import.meta.dir, "../../../src/core/brain/pledges.ts"))};`,
      "const [vault, slug] = process.argv.slice(2);",
      "try {",
      "  removePledge(vault, { slug });",
      "  console.log(JSON.stringify({ ok: true }));",
      "} catch (err) {",
      "  const e = err;",
      "  console.log(JSON.stringify({ ok: false, name: e.name, message: e.message, code: e.code ?? null }));",
      "}",
    ].join("\n"),
    "utf8",
  );

  const held = acquireLockSync(page.path);
  const baseSize = statSync(`${page.path}.lock`).size;
  const proc = Bun.spawn(["bun", child, vault, page.slug], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  let exitCode = -1;
  let stdout = "";
  let stderr = "";
  try {
    // The child's probe passes, then it queues on the pledge lock; only then
    // does the page disappear, exactly as the winning remover leaves it.
    const until = Date.now() + 20_000;
    while (statSync(`${page.path}.lock`).size <= baseSize) {
      if (Date.now() > until || proc.exitCode !== null) {
        throw new Error("the remover never reached the pledge lock");
      }
      // oxlint-disable-next-line no-await-in-loop -- polling the child's progress, one wait at a time by design
      await Bun.sleep(5);
    }
    rmSync(page.path);
    held.release();
  } finally {
    held.release();
    exitCode = await proc.exited;
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  }

  expect(stderr.trim()).toBe("");
  expect(exitCode).toBe(0);
  const outcome = JSON.parse(stdout) as {
    ok: boolean;
    name?: string;
    message?: string;
    code?: string | null;
  };
  expect(outcome.ok).toBe(false);
  expect(outcome.name).toBe("PledgeError");
  expect(outcome.message).toBe(`no pledge: ${page.slug}`);
  expect(outcome.code).toBeNull();
}, 60_000);

test("a hand-edited frontmatter date soft-parses instead of crashing the family", () => {
  const page = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const edited = readFileSync(page.path, "utf8").replace(`due: ${page.due}`, "due: not-a-date");
  writeFileSync(page.path, edited, "utf8");
  const shown = showPledge(vault, { slug: page.slug });
  expect(shown!.due).toBe("");
  const items = listPledges(vault, { now: NOW });
  expect(items).toHaveLength(1);
  expect(items[0]!.due).toBe("");
  expect(items[0]!.daysUntilDue).toBeNull();
  expect(items[0]!.overdue).toBe(false);
});

test("removePledge archives the page and a recreated slug archives with a collision suffix", () => {
  const first = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const removed = removePledge(vault, { slug: first.slug });
  expect(existsSync(first.path)).toBe(false);
  expect(existsSync(removed.archivePath)).toBe(true);
  expect(removed.slug).toBe(first.slug);
  expect(removed.archivePath.endsWith(join("Brain", "pledges", "archive", "recap-pledge.md"))).toBe(
    true,
  );
  expect(showPledge(vault, { slug: first.slug })).toBeNull();
  expect(pledgeExists(vault, first.slug)).toBe(false);

  const second = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  expect(second.slug).toBe(first.slug);
  const again = removePledge(vault, { slug: second.slug });
  expect(existsSync(again.archivePath)).toBe(true);
  expect(again.archivePath.endsWith(join("recap-pledge-2.md"))).toBe(true);
});

test("removePledge throws the shared no-pledge refusal for an unknown slug", () => {
  expect(() => removePledge(vault, { slug: "ghost" })).toThrow(noPledgeError("ghost"));
});

test("a withheld pledge page answers show as null and drops from list", () => {
  const page = addPledge(vault, cite(["Ada asked for a written recap of the migration steps"]));
  const rel = `Brain/pledges/${page.slug}.md`;
  expect(showPledge(vault, { slug: page.slug, readable: (r) => r !== rel })).toBeNull();
  expect(showPledge(vault, { slug: page.slug, readable: () => true })).not.toBeNull();
  expect(showPledge(vault, { slug: page.slug })).not.toBeNull();
  expect(listPledges(vault, { now: NOW, readable: (r) => r !== rel })).toEqual([]);
  const kept = listPledges(vault, { now: NOW, readable: () => true });
  expect(kept).toHaveLength(1);
  expect(kept[0]!.slug).toBe(page.slug);
});

test("listPledges readCap bounds readable page reads in stable name order", () => {
  for (const title of ["Echo", "Delta", "Charlie", "Bravo", "Alpha"]) {
    addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title });
  }
  expect(listPledges(vault, { now: NOW, readCap: 2 }).map((item) => item.slug)).toEqual([
    "alpha",
    "bravo",
  ]);
  expect(listPledges(vault, { now: NOW, readCap: 0 })).toEqual([]);
  fulfillPledge(vault, { slug: "bravo", date: "2026-06-20" });
  // Withheld pages spend no reads; a fulfilled page the filter drops spends
  // no read budget either, so the cap still admits the next two open pages.
  expect(
    listPledges(vault, {
      now: NOW,
      readCap: 2,
      readable: (rel) => rel !== "Brain/pledges/alpha.md",
    }).map((item) => item.slug),
  ).toEqual(["charlie", "delta"]);
  expect(listPledges(vault, { now: NOW }).map((item) => item.slug)).toEqual([
    "alpha",
    "charlie",
    "delta",
    "echo",
  ]);
});

test("listPledges readCap counts only the pages the open-only filter keeps", () => {
  // The active directory keeps every fulfilled pledge in place, so a run of
  // fulfilled pages that sort before an open one must not consume the whole
  // window: the counterparty brief's pledge arm reads through listPledges
  // under a 24-page cap, and fulfilled pages filling it would hide every
  // open promise behind them.
  for (let index = 0; index < 24; index++) {
    const page = addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      title: `A${String(index).padStart(2, "0")} done`,
      due: "2026-06-01",
    });
    fulfillPledge(vault, { slug: page.slug, date: "2026-06-02" });
  }
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Z ship the parser",
    due: "2026-07-01",
  });
  expect(listPledges(vault, { now: NOW, readCap: 24 }).map((item) => item.slug)).toEqual([
    "z-ship-the-parser",
  ]);
});

/**
 * How many of the recorded fs reads named a page under `Brain/pledges/`:
 * the page parses the walk spends on that page, counted on any platform's
 * separators.
 */
const pledgePageReads = (calls: ReadonlyArray<ReadonlyArray<unknown>>): number =>
  calls.filter((args) => String(args[0]).replaceAll("\\", "/").includes("/Brain/pledges/")).length;

test("listPledges scanCap bounds the pages one call parses", () => {
  // The scan ceiling bounds the FILESYSTEM work, not only the kept window:
  // the walk parses at most scanCap pages, so the reads cannot grow with
  // the number of pledge pages on disk.
  for (const title of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
    addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title });
  }
  const read = spyOn(fs, "readFileSync");
  try {
    const kept = listPledges(vault, { now: NOW, readCap: 10, scanCap: 2 });
    // Two pages parsed, two pages kept: the kept window (10) never bound
    // here, the scan ceiling did.
    expect(pledgePageReads(read.mock.calls)).toBe(2);
    expect(kept.map((item) => item.slug)).toEqual(["alpha", "bravo"]);
  } finally {
    read.mockRestore();
  }
});

test("listPledges scanCap charges a dropped page and leaves the kept window alone", () => {
  // A fulfilled page the walk parses and then drops still spends the scan
  // budget, so the open promise behind it is never parsed. The kept
  // window on its own is unchanged: the same open promise is still the
  // one the call returns.
  for (let index = 0; index < 3; index++) {
    const page = addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      title: `A${index} done`,
      due: "2026-06-01",
    });
    fulfillPledge(vault, { slug: page.slug, date: "2026-06-02" });
  }
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Z ship the parser",
    due: "2026-07-01",
  });
  const read = spyOn(fs, "readFileSync");
  try {
    const kept = listPledges(vault, { now: NOW, readCap: 24, scanCap: 3 });
    expect(pledgePageReads(read.mock.calls)).toBe(3);
    expect(kept).toEqual([]);
  } finally {
    read.mockRestore();
  }
  expect(listPledges(vault, { now: NOW, readCap: 24 }).map((item) => item.slug)).toEqual([
    "z-ship-the-parser",
  ]);
});

test("listPledges scanCap does not charge a page the readable predicate refuses", () => {
  // A withheld page is never parsed, so it spends no scan budget: the open
  // promises behind it are still parsed, and still kept.
  addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "A withheld",
  });
  for (const title of ["B open", "C open"]) {
    addPledge(vault, { ...cite(["Grace will review the incident timeline"]), title });
  }
  const read = spyOn(fs, "readFileSync");
  try {
    const kept = listPledges(vault, {
      now: NOW,
      readCap: 10,
      scanCap: 2,
      readable: (rel) => rel !== "Brain/pledges/a-withheld.md",
    });
    expect(pledgePageReads(read.mock.calls)).toBe(2);
    expect(kept.map((item) => item.slug)).toEqual(["b-open", "c-open"]);
  } finally {
    read.mockRestore();
  }
});

test("two titles differing only in diacritics land as distinct pages", () => {
  // `slugify` folds every non-ASCII letter into a separator, so Müller and
  // Möller share one title slug. Promises to different people are the
  // family's core use case: the second add files under an identity suffix
  // instead of refusing or overwriting the first page.
  const muller = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Ship the parser to Müller",
  });
  const moeller = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Ship the parser to Möller",
  });
  expect(muller.slug).toBe("ship-the-parser-to-m-ller");
  expect(moeller.slug).toMatch(/^ship-the-parser-to-m-ller-[0-9a-f]{6}$/u);
  expect(showPledge(vault, { slug: muller.slug })!.title).toBe("Ship the parser to Müller");
  expect(showPledge(vault, { slug: moeller.slug })!.title).toBe("Ship the parser to Möller");
  // A true duplicate keeps the family's taken-slug refusal: identity, not
  // title-suffix chance, decides what is a repeat.
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      title: "Ship the parser to Müller",
    }),
  ).toThrow(/pledge already exists: ship-the-parser-to-m-ller/);
  expect(listPledges(vault, { now: NOW })).toHaveLength(2);
});

test("a re-post of a suffix-filed pledge refuses once the title slug's holder is gone", () => {
  // The unblocked re-post is the trap: the freed base slug invites a second
  // page for an identity that already lives at the suffix, so the
  // true-duplicate check has to run across ALL candidates before any create.
  const muller = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Ship the parser to Müller",
  });
  const moeller = addPledge(vault, {
    ...cite(["Grace will review the incident timeline"]),
    title: "Ship the parser to Möller",
  });
  removePledge(vault, { slug: muller.slug });
  expect(() =>
    addPledge(vault, {
      ...cite(["Grace will review the incident timeline"]),
      title: "Ship the parser to Möller",
    }),
  ).toThrow(/pledge already exists: /);
  expect(showPledge(vault, { slug: muller.slug })).toBeNull();
  expect(showPledge(vault, { slug: moeller.slug })).not.toBeNull();
  expect(listPledges(vault, { now: NOW })).toHaveLength(1);
});

test("listPledges answers an empty list for a vault without the pledges directory", () => {
  // The fixture never creates Brain/pledges/, so the empty answer is only
  // attributable to the missing directory if the same call finds a page once
  // that directory exists.
  expect(existsSync(join(vault, "Brain", "pledges"))).toBe(false);
  expect(listPledges(vault, { now: NOW })).toEqual([]);

  addPledge(vault, cite(["Grace will review the incident timeline"]));
  expect(existsSync(join(vault, "Brain", "pledges"))).toBe(true);
  expect(listPledges(vault, { now: NOW }).map((item) => item.slug)).toEqual(["recap-pledge"]);
});
