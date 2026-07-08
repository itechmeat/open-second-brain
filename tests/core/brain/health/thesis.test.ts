/**
 * Declared-thesis register + new-note monitor (D3).
 *
 * The operator records standing positions (statement, supporting /
 * counter-evidence, a falsification "what would make me wrong", a review
 * cadence). The monitor evaluates each newly-ingested note against the
 * ACTIVE theses and flags support / contradiction / falsification-match -
 * distinct from note-vs-note contradiction (D2): this is
 * incoming-note-vs-declared-position. It builds on D2's structural,
 * language-agnostic stance derivation and never auto-resolves. Two
 * lifecycle checks reuse the cadence machinery: a staleness flag for
 * theses not updated within their cadence, and a graveyard flag for
 * active theses with no supporting evidence in N days.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_SIGNAL_SIGN } from "../../../../src/core/brain/types.ts";
import {
  closeThesis,
  detectStaleTheses,
  detectThesisGraveyard,
  listTheses,
  monitorNotesAgainstTheses,
  recordThesis,
  recordThesisSupport,
  showThesis,
  ThesisError,
  updateThesis,
  type ThesisForMonitor,
} from "../../../../src/core/brain/health/thesis.ts";

const NOW = new Date("2026-07-08T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-thesis-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const REMOTE_THESIS: ThesisForMonitor = {
  slug: "remote-work-boosts-productivity",
  status: "active",
  statement: "Remote work boosts long-term team productivity.",
  falsification: "Productivity gains disappear once headcount passes fifty people.",
};

describe("thesis register (persistence)", () => {
  test("recordThesis writes a page and round-trips through showThesis", () => {
    const page = recordThesis(vault, {
      statement: "Remote work boosts long-term team productivity.",
      supportingEvidence: "Two internal cohorts shipped faster after going remote.",
      counterEvidence: "Onboarding new hires slowed in the first quarter.",
      falsification: "Productivity gains disappear once headcount passes fifty people.",
      cadence: "monthly",
      agent: "test-agent",
      now: NOW,
    });
    expect(page.slug).toBe("remote-work-boosts-long-term-team-productivity");
    expect(page.status).toBe("active");
    expect(page.cadence).toBe("monthly");
    expect(page.lastUpdated).toBe("2026-07-08");
    expect(page.lastSupportAt).toBeNull();

    const read = showThesis(vault, page.slug);
    expect(read).not.toBeNull();
    expect(read!.statement).toBe("Remote work boosts long-term team productivity.");
    expect(read!.supportingEvidence).toBe(
      "Two internal cohorts shipped faster after going remote.",
    );
    expect(read!.counterEvidence).toBe("Onboarding new hires slowed in the first quarter.");
    expect(read!.falsification).toBe(
      "Productivity gains disappear once headcount passes fifty people.",
    );
  });

  test("recordThesis rejects an empty statement and refuses to clobber", () => {
    expect(() => recordThesis(vault, { statement: "   ", agent: "a", now: NOW })).toThrow(
      ThesisError,
    );
    recordThesis(vault, { statement: "A clear position.", agent: "a", now: NOW });
    expect(() =>
      recordThesis(vault, { statement: "A clear position.", agent: "a", now: NOW }),
    ).toThrow(ThesisError);
  });

  test("updateThesis bumps last_updated; recordThesisSupport bumps last_support_at", () => {
    const created = recordThesis(vault, {
      statement: "Remote work boosts long-term team productivity.",
      agent: "a",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(created.lastUpdated).toBe("2026-01-01");

    const touched = updateThesis(vault, {
      slug: created.slug,
      counterEvidence: "A dissenting cohort report landed.",
      now: NOW,
    });
    expect(touched.lastUpdated).toBe("2026-07-08");
    expect(touched.counterEvidence).toBe("A dissenting cohort report landed.");

    const supported = recordThesisSupport(vault, created.slug, { date: "2026-07-08", now: NOW });
    expect(supported.lastSupportAt).toBe("2026-07-08");
    expect(supported.lastUpdated).toBe("2026-07-08");
  });

  test("closeThesis formally closes; listTheses can filter to active only", () => {
    recordThesis(vault, { statement: "First position.", agent: "a", now: NOW });
    const second = recordThesis(vault, { statement: "Second position.", agent: "a", now: NOW });
    closeThesis(vault, second.slug);
    expect(showThesis(vault, second.slug)!.status).toBe("closed");

    const active = listTheses(vault, { activeOnly: true });
    expect(active.map((t) => t.slug)).toEqual(["first-position"]);
    expect(listTheses(vault).length).toBe(2);
  });
});

describe("monitorNotesAgainstTheses", () => {
  test("a contradicting note raises a conflict flag quoting the thesis", () => {
    const findings = monitorNotesAgainstTheses(
      [REMOTE_THESIS],
      [
        {
          id: "notes/incoming.md",
          text: "Remote work does not boost long-term team productivity.",
        },
      ],
      {},
    );
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.kind).toBe("contradict");
    expect(f.thesisSlug).toBe(REMOTE_THESIS.slug);
    expect(f.noteId).toBe("notes/incoming.md");
    expect(f.thesisStance).toBe(BRAIN_SIGNAL_SIGN.positive);
    expect(f.noteStance).toBe(BRAIN_SIGNAL_SIGN.negative);
    // Quotes the declared position verbatim (article: quote the thesis note).
    expect(f.thesisQuote).toBe("Remote work boosts long-term team productivity.");
    expect(f.noteQuote).toBe("Remote work does not boost long-term team productivity.");
    expect(f.action).toBe("ask_user");
  });

  test("a closely-matching same-stance note raises a support flag", () => {
    const findings = monitorNotesAgainstTheses(
      [REMOTE_THESIS],
      [
        {
          id: "notes/support.md",
          text: "Remote work boosts long-term team productivity.",
        },
      ],
      {},
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.kind).toBe("support");
    expect(findings[0]!.thesisStance).toBe(BRAIN_SIGNAL_SIGN.positive);
    expect(findings[0]!.noteStance).toBe(BRAIN_SIGNAL_SIGN.positive);
  });

  test("a note that merely adds complexity is NOT flagged", () => {
    const findings = monitorNotesAgainstTheses(
      [REMOTE_THESIS],
      [
        {
          id: "notes/nuance.md",
          text: "Remote work boosts long-term team productivity, though it demands strong written communication, deliberate onboarding rituals, and careful timezone overlap planning.",
        },
      ],
      {},
    );
    expect(findings).toEqual([]);
  });

  test("an unrelated note is not paired with the thesis", () => {
    const findings = monitorNotesAgainstTheses(
      [REMOTE_THESIS],
      [{ id: "notes/x.md", text: "Deploy releases on friday afternoon." }],
      {},
    );
    expect(findings).toEqual([]);
  });

  test("incoming evidence matching the falsification scenario raises an alert", () => {
    const findings = monitorNotesAgainstTheses(
      [REMOTE_THESIS],
      [
        {
          id: "notes/failure.md",
          text: "Our metrics show the productivity gains disappear once headcount passes fifty people.",
        },
      ],
      {},
    );
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.kind).toBe("falsification");
    expect(f.thesisQuote).toBe("Productivity gains disappear once headcount passes fifty people.");
    expect(f.noteQuote).toBe(
      "Our metrics show the productivity gains disappear once headcount passes fifty people.",
    );
    expect(f.action).toBe("ask_user");
  });

  test("closed theses are not monitored", () => {
    const findings = monitorNotesAgainstTheses(
      [{ ...REMOTE_THESIS, status: "closed" }],
      [
        {
          id: "notes/incoming.md",
          text: "Remote work does not boost long-term team productivity.",
        },
      ],
      {},
    );
    expect(findings).toEqual([]);
  });

  test("stance derivation is language-agnostic with a caller-supplied lexicon", () => {
    const findings = monitorNotesAgainstTheses(
      [
        {
          slug: "fernarbeit",
          status: "active",
          statement: "Fernarbeit steigert die langfristige Produktivitaet des Teams.",
        },
      ],
      [
        {
          id: "notes/de.md",
          text: "Fernarbeit steigert nicht die langfristige Produktivitaet des Teams.",
        },
      ],
      { negationMarkers: new Set(["nicht"]) },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.kind).toBe("contradict");
    expect(findings[0]!.noteStance).toBe(BRAIN_SIGNAL_SIGN.negative);
  });

  test("findings are deterministically ordered by thesis then note then kind", () => {
    const theses: ThesisForMonitor[] = [
      {
        slug: "zebra",
        status: "active",
        statement: "Remote work boosts long-term team productivity.",
      },
      {
        slug: "alpha",
        status: "active",
        statement: "Remote work boosts long-term team productivity.",
      },
    ];
    const notes = [
      { id: "notes/b.md", text: "Remote work boosts long-term team productivity." },
      { id: "notes/a.md", text: "Remote work does not boost long-term team productivity." },
    ];
    const findings = monitorNotesAgainstTheses(theses, notes, {});
    const keys = findings.map((f) => `${f.thesisSlug}/${f.noteId}/${f.kind}`);
    const sorted = keys.toSorted();
    expect(keys).toEqual(sorted);
  });
});

describe("thesis lifecycle checks", () => {
  test("detectStaleTheses flags a thesis past its cadence via nextDueDate", () => {
    // Updated 2026-01-01 on a monthly cadence; by NOW (2026-07-08) it is
    // long past next-due. A fresh thesis updated today is not stale.
    const stale = detectStaleTheses(
      [
        {
          slug: "old",
          status: "active",
          cadence: "monthly",
          lastUpdated: "2026-01-01",
        },
        {
          slug: "fresh",
          status: "active",
          cadence: "monthly",
          lastUpdated: "2026-07-08",
        },
        {
          slug: "closed-old",
          status: "closed",
          cadence: "monthly",
          lastUpdated: "2020-01-01",
        },
      ],
      { now: NOW },
    );
    expect(stale.map((s) => s.slug)).toEqual(["old"]);
    expect(stale[0]!.nextDue).toBe("2026-02-01");
  });

  test("detectThesisGraveyard flags active theses with no support in N days", () => {
    const graveyard = detectThesisGraveyard(
      [
        {
          slug: "abandoned",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          lastSupportAt: "2026-02-01",
        },
        {
          slug: "recently-supported",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          lastSupportAt: "2026-07-01",
        },
        {
          slug: "never-supported-old",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          lastSupportAt: null,
        },
      ],
      { maxAgeDays: 30, now: NOW },
    );
    // Both the long-unsupported and the never-supported (falls back to
    // createdAt) are flagged; the recently-supported one is not.
    expect(graveyard.map((g) => g.slug).toSorted()).toEqual(["abandoned", "never-supported-old"]);
    for (const g of graveyard) expect(g.suggestion).toBe("close");
  });

  test("the register persists as an operator-readable markdown page", () => {
    const page = recordThesis(vault, {
      statement: "Remote work boosts long-term team productivity.",
      falsification: "Productivity gains disappear once headcount passes fifty people.",
      agent: "test-agent",
      now: NOW,
    });
    const raw = readFileSync(page.path, "utf8");
    expect(raw).toContain("status: active");
    expect(raw).toContain("cadence: monthly");
    expect(raw).toContain("Remote work boosts long-term team productivity.");
    expect(raw).toContain("Productivity gains disappear once headcount passes fifty people.");
  });
});
