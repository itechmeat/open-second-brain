/**
 * Post-creation expiration mutation (unit 3c / t_5e338af1).
 *
 * The defect, both halves of it. `expiration_date` had a validator, a
 * writer parameter on both artifact kinds, and a fully-wired read side -
 * and no surface anywhere that set it. A memory's lifetime could
 * therefore be declared only by a caller writing straight to the core
 * API, and could never be changed at all: nothing in the tree rewrites
 * that field after the write. `brain_update_note` cannot reach a
 * preference (its path envelope refuses the `Brain/` root, and that
 * refusal is load-bearing), so the mutation needs a surface of its own.
 *
 * Claims pinned here:
 *
 *  1. Setting an expiration on a signal or a preference stamps the
 *     NORMALISED value and leaves every other frontmatter field intact.
 *  2. Changing an existing expiration replaces it; clearing removes the
 *     key entirely rather than writing an empty string.
 *  3. Every value goes through `normalizeExpirationDate`, so an
 *     unparseable date is refused by name and the file is untouched.
 *  4. An id that names no artifact is refused by name - never a silent
 *     no-op that reads as success.
 *  5. An artifact mutated to expire drops out of the DEFAULT query after
 *     its date and comes back under `showExpired`, which is the whole
 *     point of setting one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  EXPIRATION_CLEAR,
  ExpirationTargetNotFoundError,
  ExpirationValueError,
  setExpiration,
} from "../../../src/core/brain/expiration-set.ts";
import { queryByTopic } from "../../../src/core/brain/query.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

const CREATED = "2026-06-01T00:00:00Z";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-expiration-set-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-expiration-set-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Frontmatter lines of a page, minus the one field under test. */
function frontmatterLines(text: string): string[] {
  return text
    .split("\n---")[0]!
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("expiration_date:"));
}

function seedSignal(): string {
  return writeSignal(vault, {
    topic: "staging-endpoint",
    signal: "positive",
    agent: "tester",
    principle: "Use the staging endpoint.",
    created_at: CREATED,
    date: "2026-06-01",
    slug: "staging-endpoint",
    scope: "coding",
  }).id;
}

function seedPreference(): string {
  return writePreference(
    vault,
    {
      slug: "staging-endpoint",
      topic: "staging-endpoint",
      principle: "Use the staging endpoint.",
      created_at: CREATED,
      unconfirmed_until: CREATED,
      confirmed_at: CREATED,
      status: "confirmed",
      evidenced_by: [],
      scope: "coding",
    },
    { configPath },
  ).id;
}

describe("setting an expiration", () => {
  test("stamps a signal and leaves its other frontmatter alone", () => {
    const id = seedSignal();
    const before = readFileSync(join(vault, "Brain/inbox", `${id}.md`), "utf8");
    const res = setExpiration(vault, id, "2026-07-15");
    expect(res.id).toBe(id);
    expect(res.expiration).toBe("2026-07-15");
    expect(res.previous).toBeNull();

    const after = readFileSync(join(vault, res.path), "utf8");
    expect(after).toContain("expiration_date: 2026-07-15");
    // Every other field survives: compare the frontmatter line sets minus
    // the one this call is allowed to add.
    expect(frontmatterLines(after)).toEqual(frontmatterLines(before));
  });

  test("stamps a preference the same way", () => {
    const id = seedPreference();
    const res = setExpiration(vault, id, "2026-07-15");
    expect(res.path).toBe(`Brain/preferences/${id}.md`);
    expect(readFileSync(join(vault, res.path), "utf8")).toContain("expiration_date: 2026-07-15");
  });

  test("normalises the value rather than storing it verbatim", () => {
    const id = seedSignal();
    const res = setExpiration(vault, id, "  2026-07-15  ");
    expect(res.expiration).toBe("2026-07-15");
  });
});

describe("changing and clearing", () => {
  test("a second set replaces the date and reports the previous one", () => {
    const id = seedSignal();
    setExpiration(vault, id, "2026-07-15");
    const res = setExpiration(vault, id, "2026-09-01");
    expect(res.previous).toBe("2026-07-15");
    expect(res.expiration).toBe("2026-09-01");
    expect(readFileSync(join(vault, res.path), "utf8")).not.toContain("2026-07-15");
  });

  test("clearing removes the key rather than writing an empty value", () => {
    const id = seedSignal();
    setExpiration(vault, id, "2026-07-15");
    const res = setExpiration(vault, id, EXPIRATION_CLEAR);
    expect(res.expiration).toBeNull();
    expect(res.previous).toBe("2026-07-15");
    const after = readFileSync(join(vault, res.path), "utf8");
    expect(after).not.toContain("expiration_date");
  });

  test("clearing an artifact that has none is reported, not invented", () => {
    const id = seedSignal();
    const res = setExpiration(vault, id, EXPIRATION_CLEAR);
    expect(res.expiration).toBeNull();
    expect(res.previous).toBeNull();
    expect(res.changed).toBe(false);
  });
});

describe("refusals", () => {
  test("an unparseable date is refused by name and writes nothing", () => {
    const id = seedSignal();
    const before = readFileSync(join(vault, "Brain/inbox", `${id}.md`), "utf8");
    expect(() => setExpiration(vault, id, "next tuesday")).toThrow(ExpirationValueError);
    expect(readFileSync(join(vault, "Brain/inbox", `${id}.md`), "utf8")).toBe(before);
  });

  test("an impossible calendar date is refused too", () => {
    const id = seedSignal();
    expect(() => setExpiration(vault, id, "2026-13-40")).toThrow(ExpirationValueError);
  });

  test("an id naming no artifact is refused rather than silently succeeding", () => {
    expect(() => setExpiration(vault, "pref-nobody-home", "2026-07-15")).toThrow(
      ExpirationTargetNotFoundError,
    );
  });
});

describe("what an expiration is FOR", () => {
  test("a mutated artifact drops out of the default query after its date", () => {
    const signalId = seedSignal();
    seedPreference();
    setExpiration(vault, signalId, "2026-07-15");

    const live = queryByTopic(vault, "staging-endpoint", { now: new Date("2026-07-15T12:00:00Z") });
    expect(live.signals.map((s) => s.id)).toContain(signalId);

    const lapsed = queryByTopic(vault, "staging-endpoint", {
      now: new Date("2026-07-16T00:00:01Z"),
    });
    expect(lapsed.signals.map((s) => s.id)).not.toContain(signalId);

    const audited = queryByTopic(vault, "staging-endpoint", {
      now: new Date("2026-07-16T00:00:01Z"),
      showExpired: true,
    });
    expect(audited.signals.map((s) => s.id)).toContain(signalId);
  });

  test("clearing puts it back in the default query", () => {
    const signalId = seedSignal();
    setExpiration(vault, signalId, "2026-07-15");
    setExpiration(vault, signalId, EXPIRATION_CLEAR);
    const after = queryByTopic(vault, "staging-endpoint", {
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(after.signals.map((s) => s.id)).toContain(signalId);
  });
});
