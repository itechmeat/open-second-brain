/**
 * Note-position contradiction detector (D2).
 *
 * Unlike the confirmed-preference detector, whose polarity comes from
 * each preference's `evidenced_by` signals, this one derives each note's
 * stance sign structurally from its own PROSE: a note carrying a
 * negation marker among its tokens asserts the negative side of an
 * otherwise-shared subject. Two same-subject notes (high token overlap)
 * with opposite stances are surfaced as an `ask_user` clarification -
 * quoting the relevant span from each - and never auto-resolved.
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_SIGNAL_SIGN } from "../../../../src/core/brain/types.ts";
import {
  detectNoteContradictions,
  type NoteForContradiction,
} from "../../../../src/core/brain/health/contradiction.ts";

function note(
  over: Partial<NoteForContradiction> & Pick<NoteForContradiction, "id" | "text">,
): NoteForContradiction {
  return { ...over };
}

describe("detectNoteContradictions", () => {
  test("pairs same-subject notes with opposite stances and quotes each span", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/remote-work-good.md",
          text: "Remote work boosts long-term team productivity.",
        }),
        note({
          id: "notes/remote-work-bad.md",
          text: "Remote work does not boost long-term team productivity.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.aId).toBe("notes/remote-work-bad.md");
    expect(f.bId).toBe("notes/remote-work-good.md");
    // aId sorts first; its prose carries the negation marker -> negative.
    expect(f.aSign).toBe(BRAIN_SIGNAL_SIGN.negative);
    expect(f.bSign).toBe(BRAIN_SIGNAL_SIGN.positive);
    expect(f.jaccard).toBeGreaterThanOrEqual(0.5);
    // Each finding quotes the relevant span from each note verbatim.
    expect(f.aQuote).toBe("Remote work does not boost long-term team productivity.");
    expect(f.bQuote).toBe("Remote work boosts long-term team productivity.");
    // Never auto-resolves: it is a clarification prompt.
    expect(f.action).toBe("ask_user");
  });

  test("notes that merely add complexity (same stance) are not flagged", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/a.md",
          text: "Remote work boosts long-term team productivity.",
        }),
        note({
          id: "notes/b.md",
          text: "Remote work boosts long-term team productivity, though it demands discipline.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("unrelated-subject notes are not paired (token-overlap threshold)", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/a.md",
          text: "Deploy releases on friday afternoon.",
        }),
        note({
          id: "notes/b.md",
          text: "We should not write unit tests before merging code.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("stance is derived structurally and is language-agnostic", () => {
    // German prose with a caller-supplied negation lexicon: no English
    // wordlist is consulted, proving the derivation is not hardcoded.
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/de-pro.md",
          text: "Fernarbeit steigert die langfristige Produktivitaet des Teams.",
        }),
        note({
          id: "notes/de-contra.md",
          text: "Fernarbeit steigert nicht die langfristige Produktivitaet des Teams.",
        }),
      ],
      { jaccard: 0.5, negationMarkers: new Set(["nicht"]) },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.aId).toBe("notes/de-contra.md");
    expect(findings[0]!.aSign).toBe(BRAIN_SIGNAL_SIGN.negative);
    expect(findings[0]!.bSign).toBe(BRAIN_SIGNAL_SIGN.positive);
  });

  test("an English-only stance is NOT assumed: a non-marker language yields no false pair", () => {
    // Default lexicon does not know this token; both notes read as the
    // same (positive) stance, so no spurious contradiction is emitted.
    const findings = detectNoteContradictions(
      [
        note({ id: "notes/x.md", text: "Fernarbeit steigert die Produktivitaet des Teams." }),
        note({
          id: "notes/y.md",
          text: "Fernarbeit steigert nichtxx die Produktivitaet des Teams.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("subject buckets are compared apart when provided", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/a.md",
          subject: "remote-work",
          text: "Remote work boosts long-term team productivity.",
        }),
        note({
          id: "notes/b.md",
          subject: "office-work",
          text: "Remote work does not boost long-term team productivity.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings).toEqual([]);
  });

  test("output is deterministically ordered with aId < bId", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/zebra.md",
          text: "Remote work does not boost long-term team productivity.",
        }),
        note({
          id: "notes/alpha.md",
          text: "Remote work boosts long-term team productivity.",
        }),
      ],
      { jaccard: 0.5 },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.aId).toBe("notes/alpha.md");
    expect(findings[0]!.bId).toBe("notes/zebra.md");
    // alpha carries no negation marker (positive); zebra does (negative).
    expect(findings[0]!.aSign).toBe(BRAIN_SIGNAL_SIGN.positive);
    expect(findings[0]!.bSign).toBe(BRAIN_SIGNAL_SIGN.negative);
  });

  test("relevant span is the subject-bearing sentence in a multi-sentence note", () => {
    const findings = detectNoteContradictions(
      [
        note({
          id: "notes/a.md",
          text: "I keep changing my mind. Remote work boosts long-term team productivity. That is my current view.",
        }),
        note({
          id: "notes/b.md",
          text: "Some background first. Remote work does not boost long-term team productivity.",
        }),
      ],
      // Framing sentences dilute whole-note overlap; the span extractor
      // still isolates the subject-bearing sentence for the quote.
      { jaccard: 0.2 },
    );
    expect(findings.length).toBe(1);
    // aId (notes/a.md) sorts first and holds the positive "boosts" sentence.
    expect(findings[0]!.aQuote).toBe("Remote work boosts long-term team productivity.");
    expect(findings[0]!.bQuote).toBe("Remote work does not boost long-term team productivity.");
  });
});
