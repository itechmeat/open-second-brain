import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, writeFrontmatter } from "../../../../src/core/vault.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import {
  TemporalReplaceError,
  isValidAt,
  temporalReplace,
} from "../../../../src/core/brain/lifecycle/temporal-replace.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-temporal-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeFact(slug: string, meta: Record<string, string> = {}): string {
  const rel = join("Brain", "preferences", `pref-${slug}.md`);
  writeFrontmatter(
    join(vault, rel),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `fact ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-02-01T00:00:00Z",
      ...meta,
    },
    "Prose.",
  );
  return rel;
}

const AT = "2026-07-18T12:00:00Z";

test("temporalReplace closes the predecessor and opens the successor at one shared instant", () => {
  const pred = writeFact("old");
  const succ = writeFact("new");

  const res = temporalReplace({ vault, predecessor: pred, successor: succ, at: AT, agent: "t" });

  expect(res.at).toBe(AT);
  const [predMeta] = parseFrontmatter(join(vault, pred));
  const [succMeta] = parseFrontmatter(join(vault, succ));
  expect(predMeta["valid_until"]).toBe(AT);
  expect(predMeta["superseded_by"]).toBe("[[pref-new]]");
  expect(succMeta["valid_from"]).toBe(AT);
});

test("the interval is half-open: at the shared instant only the successor is valid", () => {
  const pred = writeFact("p", { valid_from: "2026-01-01T00:00:00Z" });
  const succ = writeFact("s");
  temporalReplace({ vault, predecessor: pred, successor: succ, at: AT });

  const [predMeta] = parseFrontmatter(join(vault, pred));
  const [succMeta] = parseFrontmatter(join(vault, succ));
  const tMs = Date.parse(AT);

  // Just before T: predecessor valid, successor not.
  expect(isValidAt(predMeta, tMs - 1)).toBe(true);
  expect(isValidAt(succMeta, tMs - 1)).toBe(false);
  // Exactly at T (half-open [from, until)): successor valid, predecessor not.
  expect(isValidAt(predMeta, tMs)).toBe(false);
  expect(isValidAt(succMeta, tMs)).toBe(true);
});

test("point-in-time evaluation of the pair has no gap and no overlap (property)", () => {
  const pred = writeFact("p", { valid_from: "2026-01-01T00:00:00Z" });
  const succ = writeFact("s", { valid_until: "2027-01-01T00:00:00Z" });
  temporalReplace({ vault, predecessor: pred, successor: succ, at: AT });

  const [predMeta] = parseFrontmatter(join(vault, pred));
  const [succMeta] = parseFrontmatter(join(vault, succ));

  const spanStart = Date.parse("2026-01-01T00:00:00Z");
  const spanEnd = Date.parse("2027-01-01T00:00:00Z");
  const step = Math.floor((spanEnd - spanStart) / 4000);
  for (let t = spanStart; t < spanEnd; t += step) {
    const p = isValidAt(predMeta, t);
    const s = isValidAt(succMeta, t);
    // Exactly one is valid across the whole span: no gap, no overlap.
    expect(p !== s).toBe(true);
  }
  // The shared boundary specifically.
  const tMs = Date.parse(AT);
  expect(isValidAt(predMeta, tMs - 1) && !isValidAt(succMeta, tMs - 1)).toBe(true);
  expect(!isValidAt(predMeta, tMs) && isValidAt(succMeta, tMs)).toBe(true);
});

test("date-only facts keep whole-day semantics", () => {
  const pred = writeFact("p", { valid_from: "2026-01-01" });
  const succ = writeFact("s");
  const res = temporalReplace({ vault, predecessor: pred, successor: succ, at: "2026-07-18" });

  expect(res.at).toBe("2026-07-18");
  const [predMeta] = parseFrontmatter(join(vault, pred));
  const [succMeta] = parseFrontmatter(join(vault, succ));
  expect(predMeta["valid_until"]).toBe("2026-07-18");
  expect(succMeta["valid_from"]).toBe("2026-07-18");

  // Any instant on 2026-07-17 -> predecessor; any instant on/after
  // 2026-07-18 00:00 -> successor.
  expect(isValidAt(predMeta, Date.parse("2026-07-17T23:59:59Z"))).toBe(true);
  expect(isValidAt(succMeta, Date.parse("2026-07-17T23:59:59Z"))).toBe(false);
  expect(isValidAt(predMeta, Date.parse("2026-07-18T00:00:00Z"))).toBe(false);
  expect(isValidAt(succMeta, Date.parse("2026-07-18T09:00:00Z"))).toBe(true);
});

test("temporalReplace logs a temporal-replace event", () => {
  const pred = writeFact("old");
  const succ = writeFact("new");
  const res = temporalReplace({ vault, predecessor: pred, successor: succ, at: AT });

  // The event lands under the UTC day of the wall-clock write instant
  // (result.loggedAt), NOT the belief instant `at`. Deriving the log day
  // from the result keeps this test green on any wall-clock date.
  const logDay = res.loggedAt.slice(0, 10);
  const { entries } = readLogDay(vault, logDay);
  const events = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.temporalReplace);
  expect(events.length).toBe(1);
  expect(events[0]!.body["at"]).toBe(AT);
});

test("both files are written or neither: a bad successor path leaves the predecessor untouched", () => {
  const pred = writeFact("old");
  const before = readFileSync(join(vault, pred), "utf8");

  expect(() =>
    temporalReplace({
      vault,
      predecessor: pred,
      successor: "Brain/preferences/pref-missing.md",
      at: AT,
    }),
  ).toThrow(TemporalReplaceError);

  const after = readFileSync(join(vault, pred), "utf8");
  expect(after).toBe(before);
});

test("temporalReplace rejects replacing a fact with itself", () => {
  const pred = writeFact("self");
  expect(() => temporalReplace({ vault, predecessor: pred, successor: pred, at: AT })).toThrow(
    TemporalReplaceError,
  );
});

test("isValidAt treats absent bounds as unbounded on that side", () => {
  expect(isValidAt({}, Date.now())).toBe(true);
  expect(
    isValidAt({ valid_from: "2026-01-01T00:00:00Z" }, Date.parse("2025-01-01T00:00:00Z")),
  ).toBe(false);
  expect(
    isValidAt({ valid_until: "2026-01-01T00:00:00Z" }, Date.parse("2027-01-01T00:00:00Z")),
  ).toBe(false);
});
