/**
 * The delegation boundary the host already delivers (U7 / t_0c6f31ee).
 *
 * The defects this suite exists to catch:
 *
 *   - A sub-agent transcript imported as an ordinary session of its
 *     parent. The host writes delegated turns to their own file carrying
 *     `isSidechain: true` and an `agentId`, under the PARENT's `sessionId`;
 *     the claude adapter read neither field, so the only record of the
 *     boundary was destroyed before any consumer saw it.
 *   - `--agent` on `o2b brain import-session` validated and then discarded:
 *     `agentLabelForTurn` returned the adapter's own constant, which is
 *     always non-empty, so the operator-supplied identity was unreachable.
 *   - Three of the five shipped adapters stamped `claude`, `codex` and
 *     `hermes` - strings `normalizeAgentArgument` rejects as placeholders
 *     everywhere else in the product, so an imported signal was attributed
 *     to a name no writer could ever have named itself.
 *
 * Fixtures are committed under `tests/fixtures/sessions/delegation/` and
 * mirror the on-disk layout the host produces: one parent transcript plus
 * a `subagents/` sibling. Nothing here reads a home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeAgentArgument } from "../../../../src/core/agent-identity.ts";
import { listContinuityRecords } from "../../../../src/core/brain/continuity/store.ts";
import { CONTINUITY_AGENT_ID_KEY } from "../../../../src/core/brain/continuity/types.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../../src/core/brain/config-template.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { claudeAdapter } from "../../../../src/core/brain/sessions/claude.ts";
import { importSession, importSessionPath } from "../../../../src/core/brain/sessions/import.ts";
import { SESSION_ADAPTERS } from "../../../../src/core/brain/sessions/registry.ts";
import type { SessionTurn } from "../../../../src/core/brain/sessions/types.ts";
import { parseSignal } from "../../../../src/core/brain/signal.ts";

/** Every test in this file pins HOME; nothing pins it globally. */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-delegation-home-"));

const DELEGATION_DIR = resolve("tests/fixtures/sessions/delegation");
const PARENT_FIXTURE = join(DELEGATION_DIR, "parent-session.jsonl");
const SUBAGENT_FIXTURE = join(DELEGATION_DIR, "subagents", "agent-7f3c21ab.jsonl");

/** Turn counts the committed fixtures hold, pinned so a fixture edit shows up. */
const PARENT_TURNS = 3;
const SIDECHAIN_TURNS = 2;

/** The distinct sub-agent id the committed sidechain fixture carries. */
const SUBAGENT_ID = "7f3c21ab-9d40-4c6e-8b21-0e5c7a1d33f2";
/** The session id BOTH fixtures share - the parent's. */
const SHARED_SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** An operator identity `normalizeAgentArgument` accepts. */
const OPERATOR_AGENT = "claude-vps-agent";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-delegation-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function turnsOf(path: string): Promise<SessionTurn[]> {
  const turns: SessionTurn[] = [];
  for await (const turn of claudeAdapter.iterate(path)) turns.push(turn);
  return turns;
}

/** `agent:` frontmatter of every signal the import wrote, keyed by topic. */
function agentByTopic(vault: string): Record<string, string> {
  const inbox = brainDirs(vault).inbox;
  const out: Record<string, string> = {};
  for (const name of readdirSync(inbox)) {
    if (!name.startsWith("sig-") || !name.endsWith(".md")) continue;
    const sig = parseSignal(join(inbox, name));
    out[sig.topic] = sig.agent;
  }
  return out;
}

describe("claude adapter — the sidechain discriminators", () => {
  test("the parent transcript yields only parent turns", async () => {
    const turns = await turnsOf(PARENT_FIXTURE);
    expect(turns.length).toBe(PARENT_TURNS);
    for (const turn of turns) {
      expect(turn.sidechain).toBeUndefined();
      expect(turn.agentId).toBeUndefined();
    }
  });

  test("the sidechain transcript flags every turn and names one distinct agent id", async () => {
    const turns = await turnsOf(SUBAGENT_FIXTURE);
    expect(turns.length).toBe(SIDECHAIN_TURNS);
    for (const turn of turns) {
      expect(turn.sidechain).toBe(true);
      expect(turn.agentId).toBe(SUBAGENT_ID);
    }
  });

  test("both fixtures carry the SAME session id, so the count separation is not the id", () => {
    for (const path of [PARENT_FIXTURE, SUBAGENT_FIXTURE]) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        expect((JSON.parse(line) as { sessionId?: string }).sessionId).toBe(SHARED_SESSION_ID);
      }
    }
  });
});

describe("importSession — attribution across the delegation boundary", () => {
  test("--agent is honoured on a parent transcript, not overruled by the adapter", async () => {
    await importSession(tmp, PARENT_FIXTURE, { agent: OPERATOR_AGENT });
    expect(agentByTopic(tmp)["delegation-parent"]).toBe(OPERATOR_AGENT);
  });

  test("a delegated turn is attributed to a derived sub-agent identity", async () => {
    await importSession(tmp, SUBAGENT_FIXTURE, { agent: OPERATOR_AGENT });
    const worker = agentByTopic(tmp)["delegation-worker"];
    expect(worker).toBe(`${OPERATOR_AGENT}-sub-7f3c21ab`);
    expect(worker).not.toBe(OPERATOR_AGENT);
    expect(normalizeAgentArgument(worker)).toBe(worker!);
  });

  test("a directory walk keeps the parent and its worker apart", async () => {
    const result = await importSessionPath(tmp, DELEGATION_DIR, { agent: OPERATOR_AGENT });
    const scanned = Object.fromEntries(
      result.files.map((f) => [f.file.endsWith("parent-session.jsonl") ? "parent" : "sub", f]),
    );
    expect(result.files.length).toBe(2);
    expect(scanned["parent"]!.turns_scanned).toBe(PARENT_TURNS);
    expect(scanned["sub"]!.turns_scanned).toBe(SIDECHAIN_TURNS);
    const byTopic = agentByTopic(tmp);
    expect(byTopic["delegation-parent"]).toBe(OPERATOR_AGENT);
    expect(byTopic["delegation-worker"]).toBe(`${OPERATOR_AGENT}-sub-7f3c21ab`);
  });

  test("no shipped adapter stamps a label the identity normaliser rejects", async () => {
    for (const adapter of SESSION_ADAPTERS) {
      expect(Object.hasOwn(adapter, "defaultAgent")).toBe(false);
    }
    const fixtures = [
      "claude-minimal.jsonl",
      "codex-minimal.jsonl",
      "hermes-minimal.jsonl",
      "opencode-minimal.jsonl",
      "grok-minimal.jsonl",
    ];
    for (const name of fixtures) {
      const vault = mkdtempSync(join(tmpdir(), "o2b-delegation-agree-"));
      try {
        const dirs = brainDirs(vault);
        for (const d of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
          mkdirSync(d, { recursive: true });
        }
        atomicWriteFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
        await importSession(vault, resolve("tests/fixtures/sessions", name), {
          agent: OPERATOR_AGENT,
        });
        for (const stamped of Object.values(agentByTopic(vault))) {
          expect(`${name}:${normalizeAgentArgument(stamped)}`).toBe(`${name}:${stamped}`);
        }
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    }
  });
});

describe("session recall — the continuity payload names both ids", () => {
  test("a delegated turn's session_turn record carries the agent id and the flag", async () => {
    await importSession(tmp, SUBAGENT_FIXTURE, {
      agent: OPERATOR_AGENT,
      recall: true,
      recallSessionId: SHARED_SESSION_ID,
    });
    const records = listContinuityRecords(tmp).filter((r) => r.kind === "session_turn");
    expect(records.length).toBe(SIDECHAIN_TURNS);
    for (const record of records) {
      const payload = record.payload as Record<string, unknown>;
      expect(payload["session_id"]).toBe(SHARED_SESSION_ID);
      expect(payload[CONTINUITY_AGENT_ID_KEY]).toBe(SUBAGENT_ID);
      expect(payload["sidechain"]).toBe(true);
    }
  });

  test("a parent turn's session_turn record carries neither", async () => {
    await importSession(tmp, PARENT_FIXTURE, {
      agent: OPERATOR_AGENT,
      recall: true,
      recallSessionId: SHARED_SESSION_ID,
    });
    const records = listContinuityRecords(tmp).filter((r) => r.kind === "session_turn");
    expect(records.length).toBe(PARENT_TURNS);
    for (const record of records) {
      const payload = record.payload as Record<string, unknown>;
      expect(CONTINUITY_AGENT_ID_KEY in payload).toBe(false);
      expect("sidechain" in payload).toBe(false);
    }
  });
});
