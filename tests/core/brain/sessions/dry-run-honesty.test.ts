/**
 * A dry-run import result must be distinguishable from a real run that
 * wrote nothing (U7 of "nothing runs unwatched").
 *
 * `signals_created: 0` and `facts_extracted: 0` were the answer in both
 * cases by construction: a dry run returns before `writeSignal`, so its
 * counters report what WAS written, which is zero, and the caller cannot
 * tell a rehearsal from a session with nothing in it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { importSession, IMPORT_WRITE_MODE } from "../../../../src/core/brain/sessions/import.ts";

let tmp: string;

const NOW = new Date("2026-08-15T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dryrun-honesty-"));
  const dirs = brainDirs(tmp);
  for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "config.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** One Claude-format transcript file with the given user texts. */
function writeSessionFile(name: string, texts: readonly string[]): string {
  const path = join(tmp, name);
  const lines = texts.map((text, index) =>
    JSON.stringify({
      type: "user",
      parentUuid: null,
      entrypoint: "cli",
      uuid: `u${index}`,
      timestamp: "2026-08-15T09:00:00.000Z",
      sessionId: "s1",
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

const MARKER = '@osb feedback positive topic=dry-run-probe principle="Prove the rehearsal"';

function inboxCount(): number {
  return readdirSync(brainDirs(tmp).inbox).filter((n) => n.endsWith(".md")).length;
}

describe("a dry run reports what it would have written", () => {
  test("write_mode names the rehearsal and signals_withheld carries the forecast", async () => {
    const path = writeSessionFile("with-marker.jsonl", [MARKER]);
    const result = await importSession(tmp, path, {
      agent: "@t",
      dryRun: true,
      now: NOW,
    });
    expect(result.write_mode).toBe(IMPORT_WRITE_MODE.dryRun);
    expect(result.signals_created).toBe(0);
    expect(result.signals_withheld).toBe(1);
    // Inert: the rehearsal still wrote nothing.
    expect(inboxCount()).toBe(0);
  });

  test("a real run that found nothing is a different answer, not the same zero", async () => {
    const path = writeSessionFile("no-marker.jsonl", ["just some prose with no marker in it"]);
    const real = await importSession(tmp, path, { agent: "@t", now: NOW });
    expect(real.write_mode).toBe(IMPORT_WRITE_MODE.applied);
    expect(real.signals_created).toBe(0);
    expect(real.signals_withheld).toBe(0);

    const rehearsal = await importSession(tmp, writeSessionFile("m2.jsonl", [MARKER]), {
      agent: "@t",
      dryRun: true,
      now: NOW,
    });
    // The pair the defect collapsed: same created count, different runs.
    expect(rehearsal.signals_created).toBe(real.signals_created);
    expect(rehearsal.write_mode).not.toBe(real.write_mode);
    expect(rehearsal.signals_withheld).not.toBe(real.signals_withheld);
  });

  test("the forecast matches what the real run then writes", async () => {
    const path = writeSessionFile("forecast.jsonl", [MARKER]);
    const rehearsal = await importSession(tmp, path, { agent: "@t", dryRun: true, now: NOW });
    const applied = await importSession(tmp, path, { agent: "@t", now: NOW });
    expect(applied.signals_created).toBe(rehearsal.signals_withheld);
    expect(applied.signals_withheld).toBe(0);
    expect(inboxCount()).toBe(1);
  });

  test("a repeated marker in one dry run is forecast once, not twice", async () => {
    const path = writeSessionFile("repeat.jsonl", [MARKER, MARKER]);
    const rehearsal = await importSession(tmp, path, { agent: "@t", dryRun: true, now: NOW });
    expect(rehearsal.signals_withheld).toBe(1);
    expect(rehearsal.signals_deduped).toBe(1);
  });
});

describe("extracted facts are forecast the same way", () => {
  // A url is one of the language-neutral fact families the extractor knows.
  const FACT_TEXT = "The index lives at https://example.com/local-index";

  test("facts_withheld separates a rehearsal from a session with no facts", async () => {
    const withFacts = writeSessionFile("facts.jsonl", [FACT_TEXT]);
    const rehearsal = await importSession(tmp, withFacts, {
      agent: "@t",
      dryRun: true,
      now: NOW,
    });
    const empty = await importSession(tmp, writeSessionFile("nofacts.jsonl", ["ok"]), {
      agent: "@t",
      dryRun: true,
      now: NOW,
    });
    expect(rehearsal.facts_extracted).toBe(0);
    expect(empty.facts_extracted).toBe(0);
    expect(rehearsal.facts_withheld).toBeGreaterThan(0);
    expect(empty.facts_withheld).toBe(0);
    expect(inboxCount()).toBe(0);
  });
});
