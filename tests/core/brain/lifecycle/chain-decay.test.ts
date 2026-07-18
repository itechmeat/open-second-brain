import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFrontmatter } from "../../../../src/core/vault.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-chain-decay-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-chain-decay-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeConfirmedPref(slug: string, extra: Record<string, string> = {}): void {
  writeFrontmatter(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `principle ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      // Confirmed 30 days before the dream run: inside the normal 90-day
      // stale window, past the accelerated 7-day chain-decay window. The
      // dream refresh finds no apply-evidence in the log, so staleness is
      // measured from confirmation.
      _confirmed_at: "2026-05-02T00:00:00Z",
      unconfirmed_until: "2026-01-08T00:00:00Z",
      _applied_count: "0",
      _confidence: "high",
      ...extra,
    },
    `Body ${slug}.`,
  );
}

test("dream retires a low-recall superseded ancestor faster than a live memory", () => {
  // Both are 30 days stale - inside the normal 90-day window, but past the
  // accelerated 7-day chain-decay window.
  writeConfirmedPref("ancestor", { superseded_by: "[[pref-tip]]" });
  writeConfirmedPref("live");

  dream(vault, { now: new Date("2026-06-01T12:00:00Z") });

  // The superseded ancestor retired on the accelerated window.
  expect(existsSync(join(vault, "Brain", "preferences", "pref-ancestor.md"))).toBe(false);
  // The non-superseded memory is still live (normal window not reached).
  expect(existsSync(join(vault, "Brain", "preferences", "pref-live.md"))).toBe(true);

  // The accelerated retirement emitted a chain-decay event.
  const { entries } = readLogDay(vault, "2026-06-01");
  const decay = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.chainDecay);
  expect(decay.length).toBe(1);
  expect(decay[0]!.body["preference"]).toBe("[[ret-ancestor]]");
});
