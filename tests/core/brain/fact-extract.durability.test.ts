/**
 * A2 (t_375e98fd): the durability gate inside `routeExtractedFacts`.
 *
 * The gate runs AFTER dedup and BEFORE the write (the fixed chain order:
 * dedup -> durability -> staging -> write). A rejected fact is never silently
 * dropped: it increments a counted, logged skip under the `durability-skip`
 * event kind and is surfaced on the result via `durabilityRejected`. The
 * operator `brain_feedback` path (a direct `writeSignal`) is NOT gated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  factDedupHash,
  routeExtractedFacts,
  type ExtractedFact,
} from "../../../src/core/brain/fact-extract.ts";
import { compileDurabilityDenylist } from "../../../src/core/brain/gates/durability.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-durability-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-durability-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function inboxSignalNames(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter(
    (f) => f.startsWith("sig-") && f.endsWith(".md"),
  );
}

describe("routeExtractedFacts durability gate", () => {
  test("a transient fact is rejected, counted, logged, and not written", () => {
    const facts: ExtractedFact[] = [
      { family: "url", text: "https://techmeat.dev", line: 1 }, // durable
      { family: "quantity", text: "load 500ms render 200ms", line: 2 }, // transient
    ];
    const dedup = new Map<string, DedupIndexEntry>();
    const result = routeExtractedFacts(vault, {
      facts,
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-1",
      dedup,
    });

    expect(result.created).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.durabilityRejected).toBe(1);

    // Only the durable fact reached the inbox.
    expect(inboxSignalNames().length).toBe(1);

    // The rejected fact is logged under the dedicated event kind, never dropped.
    const log = readLogDay(vault, "2026-07-18");
    const skip = log.entries.find((e) => e.eventType === "durability-skip");
    expect(skip).toBeDefined();
    expect(skip!.body["family"]).toBe("quantity");
    expect(skip!.body["reason"]).toBe("measurement-dominant");
    expect(skip!.body["hash"]).toBe(
      factDedupHash({ family: "quantity", text: "load 500ms render 200ms" }),
    );
  });

  test("a deduped fact never reaches the gate (chain order dedup -> durability)", () => {
    // Seed the dedup index with a TRANSIENT fact's hash. On route it must be
    // counted as deduped, not durability-rejected, and produce no skip log.
    const transient: ExtractedFact = { family: "quantity", text: "step 3/10", line: 1 };
    const dedup = new Map<string, DedupIndexEntry>([
      [factDedupHash(transient), { id: "sig-existing", path: "Brain/inbox/sig-existing.md" }],
    ]);
    const result = routeExtractedFacts(vault, {
      facts: [transient],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-2",
      dedup,
    });

    expect(result.deduped).toBe(1);
    expect(result.durabilityRejected).toBe(0);
    const log = readLogDay(vault, "2026-07-18");
    expect(log.entries.some((e) => e.eventType === "durability-skip")).toBe(false);
  });

  test("an operator-supplied denylist regex extends the gate", () => {
    const denylist = compileDurabilityDenylist("^scratch:");
    const result = routeExtractedFacts(vault, {
      facts: [{ family: "url", text: "scratch: https://throwaway.dev", line: 1 }],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-3",
      dedup: new Map(),
      durabilityDenylist: denylist,
    });
    expect(result.created).toBe(0);
    expect(result.durabilityRejected).toBe(1);
    const skip = readLogDay(vault, "2026-07-18").entries.find(
      (e) => e.eventType === "durability-skip",
    );
    expect(skip!.body["reason"]).toBe("denylisted");
  });

  test("the operator writeSignal path is NOT gated by durability", () => {
    // brain_feedback writes go straight through writeSignal (not
    // routeExtractedFacts). A transient-looking principle must still land.
    const res = writeSignal(vault, {
      topic: "fact-check",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "load 500ms render 200ms", // would be rejected on the extracted path
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-check",
    });
    expect(res.id).toContain("sig-2026-07-18-fact-check");
    expect(inboxSignalNames().length).toBe(1);
  });

  test("all-durable facts leave durabilityRejected at zero", () => {
    const result = routeExtractedFacts(vault, {
      facts: [
        { family: "email", text: "ada@example.com", line: 1 },
        { family: "url", text: "https://techmeat.dev/blog", line: 2 },
      ],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-4",
      dedup: new Map(),
    });
    expect(result.created).toBe(2);
    expect(result.durabilityRejected).toBe(0);
  });
});
