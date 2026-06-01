/**
 * Orchestrator tests for `o2b brain import-session`.
 *
 * Validates the cross-cutting behaviours: marker + tool_use replay
 * extraction, dedup by hash, dedup on re-run, directory walk,
 * autodetect failure, and the dry-run mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brainDirs } from "../../src/core/brain/paths.ts";
import { DEFAULT_BRAIN_CONFIG_YAML } from "../../src/core/brain/policy.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import {
  importSession,
  importSessionPath,
} from "../../src/core/brain/sessions/import.ts";
import { SessionImportError } from "../../src/core/brain/sessions/types.ts";
import { describeSessionRecall } from "../../src/core/brain/session-recall.ts";

const CLAUDE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");
const CODEX = resolve("tests/fixtures/sessions/codex-minimal.jsonl");
const HERMES = resolve("tests/fixtures/sessions/hermes-minimal.jsonl");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-import-"));
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
  atomicWriteFileSync(
    join(dirs.brain, "_brain.yaml"),
    DEFAULT_BRAIN_CONFIG_YAML,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("importSession", () => {
  test("creates signals from @osb markers in claude user messages", async () => {
    const res = await importSession(tmp, CLAUDE, { agent: "test" });
    expect(res.format).toBe("claude");
    expect(res.signals_created).toBeGreaterThan(0);
  });

  test("creates signals from tool_use brain_feedback replays", async () => {
    const res = await importSession(tmp, CLAUDE, { agent: "test" });
    // The fixture has 1 marker AND 1 tool_use with the same NORMALISED
    // payload-but-different `principle` text. They are distinct
    // dedup_hashes, so we expect 2 signals.
    expect(res.signals_created).toBe(2);
    expect(res.tool_replays).toBe(1);
  });

  test("dedups when marker and tool_use have identical payloads", async () => {
    // Build a fixture where both have the same principle string.
    const fixturePath = join(tmp, "matched.jsonl");
    writeFileSync(
      fixturePath,
      [
        '{"type":"queue-operation","timestamp":"2026-05-16T10:00:00.000Z","sessionId":"x"}',
        '{"parentUuid":null,"sessionId":"x","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":"@osb feedback negative topic=match principle=\\"same-principle\\""},"uuid":"u1","timestamp":"2026-05-16T10:00:01.000Z"}',
        '{"parentUuid":"u1","sessionId":"x","entrypoint":"sdk-cli","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu-1","name":"brain_feedback","input":{"topic":"match","signal":"negative","principle":"same-principle"}}]},"uuid":"a1","timestamp":"2026-05-16T10:00:02.000Z"}',
        "",
      ].join("\n"),
    );
    const res = await importSession(tmp, fixturePath, { agent: "test" });
    expect(res.signals_created).toBe(1);
    expect(res.signals_deduped).toBe(1);
  });

  test("is idempotent on re-run (zero new signals)", async () => {
    const first = await importSession(tmp, CLAUDE, { agent: "test" });
    expect(first.signals_created).toBeGreaterThan(0);
    const second = await importSession(tmp, CLAUDE, { agent: "test" });
    expect(second.signals_created).toBe(0);
    expect(second.signals_deduped).toBe(first.signals_created);
  });

  test("dry-run does not write signals", async () => {
    const res = await importSession(tmp, CLAUDE, {
      agent: "test",
      dryRun: true,
    });
    expect(res.signals_created).toBe(0);
    const inbox = readdirSync(brainDirs(tmp).inbox).filter((n) =>
      n.startsWith("sig-"),
    );
    expect(inbox.length).toBe(0);
  });

  test("can also store imported turns in the session recall DAG", async () => {
    const res = await importSession(tmp, CLAUDE, {
      agent: "test",
      recall: true,
      recallSessionId: "session-import-test",
      recallSummaryGroupSize: 2,
    });

    expect(res.recall_turns_imported).toBeGreaterThan(0);
    expect(res.recall_summary_nodes).toBeGreaterThan(0);
    expect(
      describeSessionRecall(tmp, { sessionId: "session-import-test" })
        .raw_turns,
    ).toBe(res.recall_turns_imported);
  });

  test("supports filtered write mode by role", async () => {
    const res = await importSession(tmp, CLAUDE, {
      agent: "test",
      filterRoles: ["user"],
    });

    expect(res.signals_created).toBe(1);
    expect(res.tool_replays).toBe(0);
    expect(res.filtered_turns).toBeGreaterThan(0);
  });

  test("supports filtered write mode by text substring", async () => {
    const res = await importSession(tmp, CLAUDE, {
      agent: "test",
      filterTextIncludes: "no-match-substring",
    });

    expect(res.signals_created).toBe(0);
    expect(res.filtered_turns).toBe(res.turns_scanned);
  });

  test("handles the codex fixture", async () => {
    const res = await importSession(tmp, CODEX, { agent: "test" });
    expect(res.format).toBe("codex");
    expect(res.signals_created).toBeGreaterThan(0);
  });

  test("handles the hermes fixture and stamps agent from session profile", async () => {
    const res = await importSession(tmp, HERMES, { agent: "test" });
    expect(res.format).toBe("hermes");
    expect(res.signals_created).toBeGreaterThan(0);
  });

  test("throws SessionImportError(DETECT_FAIL) on unknown format", async () => {
    const junk = join(tmp, "junk.jsonl");
    writeFileSync(junk, '{"foo":"bar"}\n');
    let caught: unknown;
    try {
      await importSession(tmp, junk, { agent: "test" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionImportError);
    expect((caught as SessionImportError).code).toBe("DETECT_FAIL");
  });

  test("counts malformed @osb marker attempts in session text", async () => {
    const fixturePath = join(tmp, "malformed-marker.jsonl");
    writeFileSync(
      fixturePath,
      [
        '{"parentUuid":null,"sessionId":"x","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":"@osb feedback negative topic=missing-principle"},"uuid":"u1","timestamp":"2026-05-16T10:00:01.000Z"}',
        "",
      ].join("\n"),
    );
    const res = await importSession(tmp, fixturePath, { agent: "test" });
    expect(res.signals_created).toBe(0);
    expect(res.malformed).toBe(1);
  });

  test("--format override bypasses autodetect", async () => {
    const junk = join(tmp, "junk.jsonl");
    writeFileSync(junk, '{"foo":"bar"}\n');
    // Should not throw — adapter chosen explicitly, iteration just
    // yields nothing.
    const res = await importSession(tmp, junk, {
      agent: "test",
      format: "claude",
    });
    expect(res.format).toBe("claude");
    expect(res.signals_created).toBe(0);
  });
});

describe("importSessionPath (directory walk)", () => {
  test("processes every jsonl in a directory", async () => {
    const dir = join(tmp, "sessions");
    mkdirSync(dir, { recursive: true });
    // Hand-link the fixtures so each file matches a different adapter.
    writeFileSync(
      join(dir, "a.jsonl"),
      [
        '{"parentUuid":null,"sessionId":"x","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":"@osb feedback negative topic=dir-a principle=p"},"uuid":"u","timestamp":"2026-05-16T10:00:00Z"}',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "b.jsonl"),
      [
        '{"role":"session_meta","tools":[]}',
        '{"role":"user","content":"@osb feedback negative topic=dir-b principle=p","timestamp":"2026-05-16T10:00:00"}',
        "",
      ].join("\n"),
    );
    const result = await importSessionPath(tmp, dir, { agent: "test" });
    expect(result.files.length).toBe(2);
    const created = result.files.reduce((s, r) => s + r.signals_created, 0);
    expect(created).toBe(2);
  });

  test("skips unknown-format files with a warning entry", async () => {
    const dir = join(tmp, "mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "junk.jsonl"), '{"foo":"bar"}\n');
    writeFileSync(
      join(dir, "valid.jsonl"),
      [
        '{"parentUuid":null,"sessionId":"x","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":"@osb feedback negative topic=mixed principle=p"},"uuid":"u","timestamp":"2026-05-16T10:00:00Z"}',
        "",
      ].join("\n"),
    );
    const result = await importSessionPath(tmp, dir, { agent: "test" });
    expect(result.files.length).toBe(1);
    expect(result.warnings.length).toBe(1);
  });
});
