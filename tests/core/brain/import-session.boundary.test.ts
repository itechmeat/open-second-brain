/**
 * Capture-boundary and fact-extraction wiring at the BATCH seam
 * (Memory Integrity Suite, t_0532ed5a + t_d0782ab2).
 *
 * importSession honors session ignore globs (matched against the
 * file path), suppresses messages before any extraction, and
 * extracts facts from user turns only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";

let vault: string;
let sessionsDir: string;

const NOW = new Date("2026-06-02T10:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-import-boundary-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "o2b-import-boundary-sessions-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

function setSessionsPolicy(lines: string[]): void {
  const path = brainConfigPath(vault);
  atomicWriteFileSync(path, readFileSync(path, "utf8") + "\n" + lines.join("\n") + "\n");
}

function inboxSignals(): string[] {
  const dir = brainDirs(vault).inbox;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("sig-") && n.endsWith(".md"));
}

/** Minimal Claude Code session fixture: meta line + user turns. */
function writeClaudeSession(name: string, userTexts: string[]): string {
  const lines = [
    JSON.stringify({ type: "summary", summary: "fixture", leafUuid: "0" }),
    ...userTexts.map((text, i) =>
      JSON.stringify({
        type: "user",
        uuid: `u-${i}`,
        timestamp: "2026-06-02T09:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ),
  ];
  const path = join(sessionsDir, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("session-level boundary at import", () => {
  test("a file matching an ignore glob imports nothing", async () => {
    setSessionsPolicy(["sessions:", "  ignore_patterns:", '    - "*cron-export*"']);
    const path = writeClaudeSession("cron-export-1.jsonl", ["my name is Ada"]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("ignore");
    expect(result.turns_scanned).toBe(0);
    expect(result.signals_created).toBe(0);
    expect(result.facts_extracted).toBe(0);
    expect(inboxSignals()).toEqual([]);
  });

  test("a stateless file scans but writes nothing", async () => {
    setSessionsPolicy(["sessions:", "  stateless_patterns:", '    - "*probe*"']);
    const path = writeClaudeSession("probe-2.jsonl", ["my name is Ada"]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("stateless");
    expect(result.signals_created).toBe(0);
    expect(result.facts_extracted).toBe(0);
    expect(inboxSignals()).toEqual([]);
  });
});

describe("message-level boundary at import", () => {
  test("suppressed turns never reach marker or fact extraction", async () => {
    setSessionsPolicy(["sessions:", "  ignore_message_patterns:", '    - "^\\[heartbeat\\]"']);
    const path = writeClaudeSession("normal.jsonl", [
      "[heartbeat] my name is Ada",
      "I prefer dark themes",
    ]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("capture");
    expect(result.suppressed_turns).toBe(1);
    expect(result.facts_extracted).toBe(1); // only the preference fact
    const names = inboxSignals();
    expect(names.some((n) => n.includes("fact-identity"))).toBe(false);
    expect(names.some((n) => n.includes("fact-preference"))).toBe(true);
  });
});

describe("fact extraction at import", () => {
  test("user-turn facts import with dedup across re-imports", async () => {
    const path = writeClaudeSession("facts.jsonl", ["my email is s@example.dev"]);
    const first = await importSession(vault, path, { agent: "tester", now: NOW, format: "claude" });
    expect(first.facts_extracted).toBe(1);
    const second = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(second.facts_extracted).toBe(0);
    expect(second.facts_deduped).toBe(1);
  });

  test("unconfigured vault imports exactly as before plus facts", async () => {
    const path = writeClaudeSession("plain.jsonl", ["just a question about the codebase"]);
    const result = await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      format: "claude",
    });
    expect(result.boundary_decision).toBe("capture");
    expect(result.suppressed_turns).toBe(0);
    expect(result.facts_extracted).toBe(0);
    expect(result.signals_created).toBe(0);
  });
});
