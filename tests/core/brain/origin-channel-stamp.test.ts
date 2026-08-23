/**
 * Unit C — the four record families that carry the origin channel.
 *
 * Claims pinned here:
 *  1. Log events carry `origin_channel` beside `agent` in BOTH surfaces
 *     the appender writes — the markdown block and the JSONL sidecar —
 *     and `parseLogDay` reads it back with no parser change.
 *  2. A caller-shaped log body cannot name the channel: a body key
 *     spelling `origin_channel` is overwritten by the server value.
 *  3. Signals carry `origin_channel` as a SIBLING of `source_type`; the
 *     two vocabularies are not folded and `source_type` keeps its
 *     historical emit rule (absent means `live`).
 *  4. `parseSignal` reads `origin_channel` back, so the field is not
 *     write-only.
 *  5. Continuity records carry `originChannel` and the dedup id does NOT
 *     move: adding provenance must not re-identify existing records.
 *  6. The caller-named note envelope resolves the channel, and
 *     `createNote` stamps it into the written frontmatter LAST, so a
 *     caller-supplied `origin_channel` key cannot win.
 *  7. Every family stamps the explicit `unset` literal when no entry
 *     point claimed the process — never a guessed channel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_CHANNEL,
  ORIGIN_CHANNEL_FIELD,
  ORIGIN_CHANNEL_UNSET,
  clearOriginChannel,
  setOriginChannel,
} from "../../../src/core/origin-channel.ts";
import { appendLogEvent, parseLogDay } from "../../../src/core/brain/log.ts";
import { parseSignal, writeSignal, type WriteSignalInput } from "../../../src/core/brain/signal.ts";
import {
  appendContinuityRecord,
  buildContinuityRecord,
} from "../../../src/core/brain/continuity/store.ts";
import { createNote, resolveNoteTarget } from "../../../src/core/brain/notes/create-note.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-origin-channel-"));
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  clearOriginChannel();
});
afterEach(() => {
  clearOriginChannel();
  rmSync(vault, { recursive: true, force: true });
});

function baseSignal(slug: string, overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: "deploy",
    signal: "positive",
    agent: "tester",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
    ...overrides,
  };
}

describe("family 1 — log events", () => {
  test("stamp the claimed channel into the markdown block and the JSONL row", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    const { logPath } = appendLogEvent(vault, {
      timestamp: "2026-05-01T10:00:00Z",
      eventType: "note",
      agent: "tester",
      body: { text: "a milestone" },
    });
    const markdown = readFileSync(logPath, "utf8");
    expect(markdown).toContain(`- ${ORIGIN_CHANNEL_FIELD}: cli`);
    const jsonl = readFileSync(logPath.replace(/\.md$/, ".jsonl"), "utf8").trim();
    expect(JSON.parse(jsonl).payload[ORIGIN_CHANNEL_FIELD]).toBe("cli");
  });

  test("round-trip through parseLogDay with no parser change", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    appendLogEvent(vault, {
      timestamp: "2026-05-01T10:00:00Z",
      eventType: "note",
      body: { text: "a milestone" },
    });
    const { entries } = parseLogDay(vault, "2026-05-01");
    expect(entries[0]?.body[ORIGIN_CHANNEL_FIELD]).toBe("mcp-tool");
  });

  test("a caller-shaped body cannot name the channel", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    const { logPath } = appendLogEvent(vault, {
      timestamp: "2026-05-01T10:00:00Z",
      eventType: "note",
      body: { text: "a milestone", [ORIGIN_CHANNEL_FIELD]: "mcp-tool" },
    });
    const markdown = readFileSync(logPath, "utf8");
    expect(markdown).toContain(`- ${ORIGIN_CHANNEL_FIELD}: cli`);
    expect(markdown).not.toContain(`- ${ORIGIN_CHANNEL_FIELD}: mcp-tool`);
  });

  test("stamp `unset` when no entry point claimed the process", () => {
    const { logPath } = appendLogEvent(vault, {
      timestamp: "2026-05-01T10:00:00Z",
      eventType: "note",
      body: { text: "a milestone" },
    });
    expect(readFileSync(logPath, "utf8")).toContain(
      `- ${ORIGIN_CHANNEL_FIELD}: ${ORIGIN_CHANNEL_UNSET}`,
    );
  });
});

describe("family 2 — signals", () => {
  test("stamp the channel as a sibling of source_type, not a replacement", () => {
    setOriginChannel(ORIGIN_CHANNEL.import);
    const res = writeSignal(vault, baseSignal("sibling", { source_type: "session" }));
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain(`${ORIGIN_CHANNEL_FIELD}: import`);
    expect(text).toContain("source_type: session");
  });

  test("leave the historical source_type emit rule alone", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    const res = writeSignal(vault, baseSignal("live-default"));
    const text = readFileSync(res.path, "utf8");
    // `live` is still the implicit default and is still not emitted.
    expect(text).not.toContain("source_type:");
    expect(text).toContain(`${ORIGIN_CHANNEL_FIELD}: cli`);
  });

  test("parseSignal reads the channel back, so the field is not write-only", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const res = writeSignal(vault, baseSignal("readback"));
    expect(parseSignal(res.path).origin_channel).toBe("mcp-tool");
  });

  test("stamp `unset` when no entry point claimed the process", () => {
    const res = writeSignal(vault, baseSignal("unclaimed"));
    expect(readFileSync(res.path, "utf8")).toContain(
      `${ORIGIN_CHANNEL_FIELD}: ${ORIGIN_CHANNEL_UNSET}`,
    );
  });
});

describe("family 3 — continuity records", () => {
  test("carry the claimed channel", () => {
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const record = appendContinuityRecord(vault, {
      kind: "context_receipt",
      createdAt: "2026-05-01T10:00:00Z",
      payload: { note: "checkpoint" },
    });
    expect(record.originChannel).toBe("mcp-tool");
    const shard = readFileSync(
      join(vault, "Brain", "log", "continuity", "2026-05.jsonl"),
      "utf8",
    ).trim();
    expect(JSON.parse(shard).originChannel).toBe("mcp-tool");
  });

  test("keep the dedup id stable across channels — provenance must not re-identify", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    const viaCli = buildContinuityRecord({
      kind: "context_receipt",
      createdAt: "2026-05-01T10:00:00Z",
      payload: { note: "checkpoint" },
    });
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    const viaMcp = buildContinuityRecord({
      kind: "context_receipt",
      createdAt: "2026-05-01T10:00:00Z",
      payload: { note: "checkpoint" },
    });
    expect(viaMcp.id).toBe(viaCli.id);
    expect(viaMcp.originChannel).not.toBe(viaCli.originChannel);
  });

  test("stamp `unset` when no entry point claimed the process", () => {
    const record = buildContinuityRecord({
      kind: "context_receipt",
      createdAt: "2026-05-01T10:00:00Z",
    });
    expect(record.originChannel).toBe(ORIGIN_CHANNEL_UNSET);
  });
});

describe("family 4 — caller-named notes", () => {
  test("the shared envelope resolves the channel for all four caller-named tools", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    expect(resolveNoteTarget(vault, "Notes/Target.md").originChannel).toBe("cli");
  });

  test("createNote stamps it into the written frontmatter", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    createNote(vault, { path: "Notes/Stamped.md", frontmatter: { title: "T" }, content: "body" });
    const text = readFileSync(join(vault, "Notes", "Stamped.md"), "utf8");
    expect(text).toContain(`${ORIGIN_CHANNEL_FIELD}: cli`);
    expect(text).toContain("title: T");
  });

  test("a caller-supplied origin_channel key loses to the server value", () => {
    setOriginChannel(ORIGIN_CHANNEL.cli);
    createNote(vault, {
      path: "Notes/Liar.md",
      frontmatter: { [ORIGIN_CHANNEL_FIELD]: "mcp-tool" },
      content: "body",
    });
    const text = readFileSync(join(vault, "Notes", "Liar.md"), "utf8");
    expect(text).toContain(`${ORIGIN_CHANNEL_FIELD}: cli`);
    expect(text).not.toContain(`${ORIGIN_CHANNEL_FIELD}: mcp-tool`);
  });

  test("stamp `unset` when no entry point claimed the process", () => {
    createNote(vault, { path: "Notes/Unclaimed.md", content: "body" });
    expect(readFileSync(join(vault, "Notes", "Unclaimed.md"), "utf8")).toContain(
      `${ORIGIN_CHANNEL_FIELD}: ${ORIGIN_CHANNEL_UNSET}`,
    );
  });
});
