/**
 * Weekly top-source (t_a8d49eae): the weekly synthesis nominates the
 * single most-developable note of the 7-day window - recency,
 * inbound links, and link centrality combined into one ranked
 * finding with a per-signal breakdown and a one-line why. Absent
 * when no candidate note was touched inside the window, so historic
 * envelopes stay byte-identical.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRAIN_TEMPORAL_DEFAULTS } from "../../../../src/core/brain/policy.ts";
import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { buildWeeklySynthesis } from "../../../../src/core/brain/temporal/weekly-brief.ts";

const WEEK_END = "2026-06-04";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-top-source-"));
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
});

function note(rel: string, content: string, mtime: string): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  const when = new Date(mtime);
  utimesSync(abs, when, when);
  return abs;
}

function synthesize() {
  return buildWeeklySynthesis(buildTimelineIndex(vault, {}), vault, WEEK_END, {
    ...BRAIN_TEMPORAL_DEFAULTS,
  });
}

describe("weekly topSource", () => {
  test("the linked, fresh note wins; breakdown and why are explainable", () => {
    note(
      "Brain/notes/hub.md",
      "# Hub\n\nThe restaking writeup everything points at.\n",
      "2026-06-02T10:00:00Z",
    );
    note(
      "Brain/notes/linker-a.md",
      "# A\n\nSee [[Brain/notes/hub.md|hub]] for the model.\n",
      "2026-06-01T10:00:00Z",
    );
    note(
      "Brain/notes/linker-b.md",
      "# B\n\nBuilds on [[Brain/notes/hub.md|hub]].\n",
      "2026-06-01T11:00:00Z",
    );
    const envelope = synthesize();
    expect(envelope.topSource).toBeDefined();
    const top = envelope.topSource!;
    expect(top.path).toBe("Brain/notes/hub.md");
    expect(top.signals.inboundLinks).toBe(2);
    expect(top.signals.recencyDays).toBeLessThanOrEqual(2);
    expect(top.score).toBeGreaterThan(0);
    expect(top.why).toContain("inbound");
  });

  test("absent when nothing was modified inside the window", () => {
    note("Brain/notes/old.md", "# Old\n\nAncient note.\n", "2026-01-01T10:00:00Z");
    const envelope = synthesize();
    expect(envelope.topSource).toBeUndefined();
  });

  test("machine-owned directories never nominate", () => {
    note("Brain/log/2026-06-02.md", "# Log\n\nMachine file.\n", "2026-06-02T10:00:00Z");
    note("Brain/inbox/sig-2026-06-02-x.md", "# Sig\n\nSignal.\n", "2026-06-02T10:00:00Z");
    const envelope = synthesize();
    expect(envelope.topSource).toBeUndefined();
  });

  test("deterministic across repeated builds", () => {
    note("Brain/notes/n1.md", "# N1\n\nFresh note one.\n", "2026-06-02T10:00:00Z");
    note("Brain/notes/n2.md", "# N2\n\nFresh note two.\n", "2026-06-03T10:00:00Z");
    const a = synthesize();
    const b = synthesize();
    expect(a.topSource).toEqual(b.topSource);
  });
});
