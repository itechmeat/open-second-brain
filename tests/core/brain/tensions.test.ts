import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoteContradictionFinding } from "../../../src/core/brain/health/contradiction.ts";
import { parseLogDay } from "../../../src/core/brain/log.ts";
import { tensionsDir } from "../../../src/core/brain/paths.ts";
import {
  confirmTension,
  detectTensions,
  dismissTension,
  listTensions,
  listUnresolvedTensions,
  persistTension,
  resolveTension,
  showTension,
  TENSION_STATUS,
  TENSION_TYPE,
  TensionError,
  tensionDedupKey,
  tensionWarningsForContextItems,
} from "../../../src/core/brain/tensions.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-tensions-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Two notes with high token overlap and opposite stance (a negation particle). */
const TABS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "pref-tabs", text: "Always use tabs for indentation in source files." },
  { id: "pref-spaces", text: "Never use tabs for indentation in source files." },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function finding(): NoteContradictionFinding {
  return {
    aId: "pref-tabs",
    bId: "pref-spaces",
    subject: "for indentation source tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "Always use tabs for indentation in source files.",
    bQuote: "Never use tabs for indentation in source files.",
    action: "ask_user",
  };
}

describe("tensionDedupKey", () => {
  test("is stable and pair-order independent", () => {
    const f = finding();
    const swapped: NoteContradictionFinding = {
      ...f,
      aId: f.bId,
      bId: f.aId,
      aSign: f.bSign,
      bSign: f.aSign,
      aQuote: f.bQuote,
      bQuote: f.aQuote,
    };
    expect(tensionDedupKey(f)).toBe(tensionDedupKey(swapped));
  });

  test("changes when the stance signature changes", () => {
    const f = finding();
    const flipped: NoteContradictionFinding = { ...f, aSign: "negative", bSign: "positive" };
    expect(tensionDedupKey(f)).not.toBe(tensionDedupKey(flipped));
  });
});

describe("persistTension", () => {
  test("creates a tension note in open state with subjects and stances", () => {
    const res = persistTension(vault, finding(), { agent: "tester" });
    expect(res.created).toBe(true);
    expect(res.record.type).toBe(TENSION_TYPE);
    expect(res.record.status).toBe(TENSION_STATUS.open);
    expect(res.record.subjectA).toBe("pref-spaces");
    expect(res.record.subjectB).toBe("pref-tabs");
    expect(existsSync(res.record.path)).toBe(true);

    const raw = readFileSync(res.record.path, "utf8");
    expect(raw).toContain("_status: open");
    expect(raw).toContain(`type: ${TENSION_TYPE}`);
  });

  test("logs a tension event on creation", () => {
    persistTension(vault, finding(), { agent: "tester" });
    const events = parseLogDay(vault, today()).entries.filter((e) => e.eventType === "tension");
    expect(events.length).toBe(1);
  });

  test("re-detection of the same pair updates the existing note instead of duplicating", () => {
    const first = persistTension(vault, finding(), { agent: "tester" });
    const second = persistTension(vault, finding(), { agent: "tester" });
    expect(second.created).toBe(false);
    expect(second.record.slug).toBe(first.record.slug);
    expect(second.record.detectedCount).toBe(2);

    const files = readdirSync(tensionsDir(vault)).filter((n) => n.endsWith(".md"));
    expect(files.length).toBe(1);
  });

  test("re-detection preserves a manual status transition", () => {
    const first = persistTension(vault, finding(), { agent: "tester" });
    confirmTension(vault, first.record.slug, { agent: "tester" });
    const again = persistTension(vault, finding(), { agent: "tester" });
    expect(again.record.status).toBe(TENSION_STATUS.confirmed);
  });
});

describe("detectTensions", () => {
  test("consumes the contradiction detector and persists one tension", () => {
    const res = detectTensions(vault, TABS, { jaccard: 0.3, agent: "tester" });
    expect(res.created).toBe(1);
    expect(res.records.length).toBe(1);
    expect(listTensions(vault).length).toBe(1);
  });

  test("re-running detection does not duplicate", () => {
    detectTensions(vault, TABS, { jaccard: 0.3, agent: "tester" });
    const second = detectTensions(vault, TABS, { jaccard: 0.3, agent: "tester" });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(listTensions(vault).length).toBe(1);
  });
});

describe("state machine transitions", () => {
  test("open -> confirmed logs an event and stays unresolved", () => {
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    const confirmed = confirmTension(vault, record.slug, { agent: "tester" });
    expect(confirmed.status).toBe(TENSION_STATUS.confirmed);
    const events = parseLogDay(vault, today()).entries.filter((e) => e.eventType === "tension");
    // one on create + one on confirm
    expect(events.length).toBe(2);
    expect(listUnresolvedTensions(vault).length).toBe(1);
  });

  test("open -> dismissed drops it from the unresolved set", () => {
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    dismissTension(vault, record.slug, { agent: "tester", reason: "not a real conflict" });
    expect(showTension(vault, record.slug)!.status).toBe(TENSION_STATUS.dismissed);
    expect(listUnresolvedTensions(vault).length).toBe(0);
  });

  test("open -> resolved drops it from the unresolved set", () => {
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    resolveTension(vault, record.slug, { agent: "tester", reason: "merged the two rules" });
    expect(showTension(vault, record.slug)!.status).toBe(TENSION_STATUS.resolved);
    expect(listUnresolvedTensions(vault).length).toBe(0);
  });

  test("an invalid transition raises a typed error", () => {
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    resolveTension(vault, record.slug, { agent: "tester" });
    expect(() => confirmTension(vault, record.slug, { agent: "tester" })).toThrow(TensionError);
    expect(() => resolveTension(vault, record.slug, { agent: "tester" })).toThrow(TensionError);
  });

  test("a transition on an unknown slug raises a typed error", () => {
    expect(() => confirmTension(vault, "does-not-exist", { agent: "tester" })).toThrow(
      TensionError,
    );
  });
});

describe("tensionWarningsForContextItems", () => {
  test("warns for an included subject of an unresolved tension", () => {
    persistTension(vault, finding(), { agent: "tester" });
    const warnings = tensionWarningsForContextItems(vault, ["pref-tabs", "pref-unrelated"]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("pref-tabs");
  });

  test("emits nothing when no included item is a tension subject", () => {
    persistTension(vault, finding(), { agent: "tester" });
    expect(tensionWarningsForContextItems(vault, ["pref-unrelated"]).length).toBe(0);
  });

  test("emits nothing for a dismissed or resolved tension", () => {
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    dismissTension(vault, record.slug, { agent: "tester" });
    expect(tensionWarningsForContextItems(vault, ["pref-tabs", "pref-spaces"]).length).toBe(0);
  });
});
