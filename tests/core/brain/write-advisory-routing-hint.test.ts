/**
 * Unit 4 (t_75597bb9): the unroutable-capture routing hint.
 *
 * `adviseUnroutableCapture` is the sibling of `adviseIncomingFeedback`:
 * it runs AROUND the feedback write, never gates it, and reports the ONE
 * routing signal the capture lacked (`scope`) together with the scope
 * slugs the vault actually holds, ranked by document frequency. An empty
 * candidate set is the absent case and returns `null`, so a fresh vault
 * stays silent instead of printing empty prose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { readAllLogEntries } from "../../../src/core/brain/query.ts";
import { NEXT_COMMAND_KEY, resolveNextStep } from "../../../src/core/brain/next-step.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  type BrainPreferenceStatus,
} from "../../../src/core/brain/types.ts";
import {
  adviseUnroutableCapture,
  CAPTURE_ROUTING_HINT_CODE,
  CAPTURE_ROUTING_HINT_KEY,
  captureRoutingHintField,
  ROUTING_SIGNAL_FIELD,
} from "../../../src/core/brain/write-advisory.ts";

let tmp: string;
let vault: string;

const NOW = new Date("2026-07-27T12:00:00Z");

/** The identity and clock every call in this file advises under. */
const ADVICE = { agent: "test-agent", now: NOW } as const;

function pref(
  slug: string,
  scope: string,
  status: BrainPreferenceStatus = BRAIN_PREFERENCE_STATUS.confirmed,
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: NOW.toISOString(),
    unconfirmed_until: NOW.toISOString(),
    ...(status === BRAIN_PREFERENCE_STATUS.confirmed
      ? { confirmed_at: NOW.toISOString() }
      : { confirmed_at: null }),
    status,
    evidenced_by: ["[[sig-2026-07-27-seed]]"],
    scope,
  });
}

function signal(slug: string, scope?: string): void {
  writeSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "test-agent",
    principle: `principle for ${slug}`,
    created_at: NOW.toISOString(),
    date: "2026-07-27",
    slug,
    ...(scope !== undefined ? { scope } : {}),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-routing-hint-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("adviseUnroutableCapture", () => {
  test("names scope as the missing signal and ranks observed slugs by document frequency", () => {
    pref("tabs", "coding");
    pref("naming", "coding");
    pref("tone", "writing");
    signal("sources", "research");
    signal("more-code", "coding");

    const hint = adviseUnroutableCapture(vault, ADVICE);

    expect(hint).not.toBeNull();
    expect(hint!.missing_signal).toBe(ROUTING_SIGNAL_FIELD);
    expect(hint!.code).toBe(CAPTURE_ROUTING_HINT_CODE);
    // Document frequency descending, then slug ascending on a tie.
    expect(hint!.candidates.map((c) => `${c.scope}:${c.documents}`)).toEqual([
      "coding:3",
      "research:1",
      "writing:1",
    ]);
  });

  test("counts only confirmed preferences, so an unpromoted scope is not advertised", () => {
    pref("drafts", "drafting", BRAIN_PREFERENCE_STATUS.unconfirmed);
    pref("tone", "writing");

    const hint = adviseUnroutableCapture(vault, ADVICE);

    expect(hint!.candidates.map((c) => c.scope)).toEqual(["writing"]);
  });

  test("returns null when the vault holds no scope corpus", () => {
    // A scope-less signal is corpus, but it declares no scope, so there
    // is nothing to suggest and the hint stays silent.
    signal("unscoped-thought");
    expect(adviseUnroutableCapture(vault, ADVICE)).toBeNull();
  });

  test("returns null when the capture already resolved an effective scope", () => {
    pref("tabs", "coding");
    expect(adviseUnroutableCapture(vault, { ...ADVICE, scope: "coding" })).toBeNull();
    expect(adviseUnroutableCapture(vault, { ...ADVICE, scope: "brand-new-scope" })).toBeNull();
  });

  test("degrades to a visible warning (returns null) when the preferences dir is unreadable", () => {
    signal("sources", "research");
    const prefsDir = brainDirs(vault).preferences;
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(adviseUnroutableCapture(vault, ADVICE)).toBeNull();
      expect(captured).toContain("capture routing hint computation failed");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  test("records one capture-routing-hint event carrying the structured fields", () => {
    pref("tabs", "coding");
    pref("tone", "writing");

    adviseUnroutableCapture(vault, ADVICE);

    const events = readAllLogEntries(vault).filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.captureRoutingHint,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.body["missing_signal"]).toBe(ROUTING_SIGNAL_FIELD);
    // Structured slug + frequency per candidate, never a prose sentence.
    expect(events[0]!.body["candidates"]).toEqual(["coding documents=1", "writing documents=1"]);
    expect(events[0]!.body["agent"]).toBe(ADVICE.agent);
  });

  test("records nothing when the hint stays silent", () => {
    // A vault with no corpus, then a routable capture: neither is a
    // hint, so neither may leave a countable event behind.
    adviseUnroutableCapture(vault, ADVICE);
    pref("tabs", "coding");
    adviseUnroutableCapture(vault, { ...ADVICE, scope: "coding" });
    const events = readAllLogEntries(vault).filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.captureRoutingHint,
    );
    expect(events.length).toBe(0);
  });

  test("a corrupt corpus file is skipped, not fatal", () => {
    pref("tone", "writing");
    writeFileSync(join(brainDirs(vault).inbox, "sig-2026-07-27-broken.md"), "not a signal file\n");

    const hint = adviseUnroutableCapture(vault, ADVICE);

    expect(hint!.candidates.map((c) => c.scope)).toEqual(["writing"]);
  });
});

describe("the hint's forward pointer", () => {
  test("resolves through the registry to a structural re-record command", () => {
    const step = resolveNextStep(CAPTURE_ROUTING_HINT_CODE);
    expect(step).not.toBeNull();
    expect(step!.nextCommand).toContain(`--${ROUTING_SIGNAL_FIELD} `);
    expect(step!.nextCommand.startsWith("o2b brain feedback ")).toBe(true);
  });
});

describe("the extracted-fact path is untouched", () => {
  test("routeExtractedFacts does not reach the capture routing hint", () => {
    // The invariant `write-advisory.ts` states in its header: the
    // advisory surface attaches to the operator-facing feedback path
    // only. Asserted structurally so a future import cannot break it.
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "src", "core", "brain", "fact-extract.ts"),
      "utf8",
    );
    expect(source).not.toContain("adviseUnroutableCapture");
    expect(source).not.toContain("write-advisory");
  });
});

describe("a signal the ranking could not read is reported, not dropped", () => {
  test("a corrupt inbox signal warns on stderr and the ranking still returns", () => {
    pref("tabs", "coding");
    signal("scoped-thought", "research");
    const corrupt = join(brainDirs(vault).inbox, "sig-2026-07-27-corrupt.md");
    writeFileSync(corrupt, "this file has no frontmatter at all\n");

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    let hint;
    try {
      hint = adviseUnroutableCapture(vault, ADVICE);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // The skip is named, with the file that caused it.
    expect(captured).toContain("capture routing hint skipped unreadable signal");
    expect(captured).toContain(corrupt);
    // The remaining corpus still ranks: a corrupt document is one missing
    // count, never a refusal of the whole hint.
    expect(hint).not.toBeNull();
    expect(hint!.candidates.map((c) => c.scope).toSorted()).toEqual(["coding", "research"]);
  });
});

describe("both machine surfaces spell the hint the same way", () => {
  test("the composer names the key and resolves the exit once", () => {
    pref("tabs", "coding");
    const hint = adviseUnroutableCapture(vault, ADVICE);
    expect(hint).not.toBeNull();

    const field = captureRoutingHintField(hint) as Record<string, Record<string, unknown>>;
    expect(Object.keys(field)).toEqual([CAPTURE_ROUTING_HINT_KEY]);
    expect(field[CAPTURE_ROUTING_HINT_KEY]![NEXT_COMMAND_KEY]).toBe(
      resolveNextStep(CAPTURE_ROUTING_HINT_CODE)!.nextCommand,
    );
    expect(field[CAPTURE_ROUTING_HINT_KEY]!["missing_signal"]).toBe(ROUTING_SIGNAL_FIELD);
  });

  test("no hint contributes no key at all", () => {
    expect(captureRoutingHintField(null)).toEqual({});
  });
});
