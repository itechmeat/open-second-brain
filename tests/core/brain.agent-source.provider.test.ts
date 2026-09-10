/**
 * Agent-source provider tests.
 *
 * These lock the first provider contract: vault provenance is read-only,
 * derives the agent universe from existing Brain artifacts, and exposes
 * a normalized contribution stream for later query/diff layers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectAgentSourceContributions,
  listAgentSources,
} from "../../src/core/brain/agent-source/registry.ts";
import { appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-agent-source-"));
  const dirs = brainDirs(tmp);
  for (const d of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
  ]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedVault(): void {
  const sig = writeSignal(tmp, {
    topic: "agent-query",
    signal: "positive",
    agent: "claude",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "agent-query",
    scope: "brain",
    source: ["[[notes/agent-query.md]]"],
  });
  writeSignal(tmp, {
    topic: "agent-diff",
    signal: "negative",
    agent: "codex",
    principle: "Do not hardcode agent pairs.",
    created_at: "2026-05-21T10:00:00Z",
    date: "2026-05-21",
    slug: "agent-diff",
    scope: "brain",
  });
  writePreference(tmp, {
    slug: "agent-query",
    topic: "agent-query",
    principle: "Keep agent provenance queryable.",
    created_at: "2026-05-22T10:00:00Z",
    unconfirmed_until: "2026-06-05T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [`[[${sig.id}]]`],
    confirmed_at: null,
    scope: "brain",
  });
  appendLogEvent(tmp, {
    timestamp: "2026-05-23T10:00:00Z",
    eventType: "apply-evidence",
    body: {
      preference: "[[pref-agent-query]]",
      artifact: "[[docs/brainstorm/cross-agent-query-foundation/design.md]]",
      result: "applied",
      agent: "hermes",
      source: ["[[notes/agent-query.md]]"],
    },
  });
}

describe("vault agent-source provider", () => {
  test("lists agents from normalized vault contributions", () => {
    seedVault();

    const agents = listAgentSources(tmp);

    expect(agents.map((a) => a.id)).toEqual(["claude", "codex", "hermes"]);
    expect(agents.find((a) => a.id === "claude")?.contribution_count).toBe(2);
    expect(agents.find((a) => a.id === "codex")?.kinds).toEqual(["signal"]);
    expect(agents.find((a) => a.id === "hermes")?.kinds).toEqual(["log"]);
  });

  test("collects stable normalized contributions without writing to the vault", () => {
    seedVault();
    const beforeInbox = readdirSync(brainDirs(tmp).inbox).toSorted();

    const contributions = collectAgentSourceContributions(tmp);

    expect(Object.isFrozen(contributions)).toBe(true);
    expect(contributions.map((c) => `${c.kind}:${c.id}`)).toEqual([
      "signal:sig-2026-05-20-agent-query",
      "signal:sig-2026-05-21-agent-diff",
      "preference:pref-agent-query",
      "log:2026-05-23T10:00:00Z:apply-evidence",
    ]);
    expect(contributions[0]?.agents).toEqual(["claude"]);
    expect(contributions[2]?.agents).toEqual(["claude"]);
    expect(contributions[3]?.agents).toEqual(["hermes"]);
    expect(contributions[3]?.text).toContain(
      "docs/brainstorm/cross-agent-query-foundation/design.md",
    );
    expect(Object.isFrozen(contributions[0])).toBe(true);
    expect(Object.isFrozen(contributions[0]?.agents)).toBe(true);
    expect(Object.isFrozen(contributions[0]?.data)).toBe(true);
    expect(Object.isFrozen(contributions[0]?.data["source"])).toBe(true);
    const logBody = contributions[3]?.data["body"] as Record<string, unknown>;
    expect(Object.isFrozen(logBody)).toBe(true);
    expect(Object.isFrozen(logBody["source"])).toBe(true);
    expect(readdirSync(brainDirs(tmp).inbox).toSorted()).toEqual(beforeInbox);
  });
});

/**
 * The `note` contribution kind (who-wrote-what, Task A / t_662f4e82).
 *
 * A `note-write` event is not a `log` contribution that happens to name a
 * path: it IS the answer to "which notes did this agent touch", so it
 * gets its own kind, its own `path`, and a title that names the operation
 * rather than the event kind.
 */
describe("note-write events as contributions of kind note", () => {
  function seedNoteWrite(overrides: Record<string, string> = {}): void {
    appendLogEvent(
      tmp,
      {
        timestamp: "2026-05-24T10:00:00Z",
        eventType: "note-write",
        agent: "claude",
        body: {
          write_id: "nw_20260524100000_0123456789abcdef",
          op: "update",
          target: "Notes/Design.md",
          hash_before: "a".repeat(64),
          hash_after: "b".repeat(64),
          bytes_before: "10",
          bytes_after: "20",
          agent: "claude",
          ...overrides,
        },
      },
      { deviceId: "" },
    );
  }

  test("the write becomes a note contribution keyed by its write id", () => {
    seedNoteWrite();
    const note = collectAgentSourceContributions(tmp).find((c) => c.kind === "note");
    expect(note).toBeDefined();
    expect(note!.id).toBe("nw_20260524100000_0123456789abcdef");
    expect(note!.agents).toEqual(["claude"]);
    // The page IS the answer, so it rides on `path`.
    expect(note!.path).toBe("Notes/Design.md");
    // The title names the work, not the event kind.
    expect(note!.title).toBe("update Notes/Design.md");
  });

  test("the roster reports the kind, so an agent's notes are one filter away", () => {
    seedNoteWrite();
    const claude = listAgentSources(tmp).find((a) => a.id === "claude");
    expect(claude?.kinds).toContain("note");
  });

  test("a note-write line with no target stays a log contribution, never a pathless note", () => {
    // Projecting it as a `note` would put a row in the roster an operator
    // could select and never open.
    appendLogEvent(
      tmp,
      {
        timestamp: "2026-05-24T11:00:00Z",
        eventType: "note-write",
        agent: "claude",
        body: { write_id: "nw_20260524110000_ffffffffffffffff", op: "update" },
      },
      { deviceId: "" },
    );
    const kinds = collectAgentSourceContributions(tmp).map((c) => c.kind);
    expect(kinds).toContain("log");
    expect(kinds).not.toContain("note");
  });
});
