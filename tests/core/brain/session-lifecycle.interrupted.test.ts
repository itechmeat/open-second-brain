import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-session-lifecycle-interrupted-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Write a minimal Claude-format transcript the session adapters can parse. */
function writeClaudeTranscript(sessionId: string, userTexts: ReadonlyArray<string>): string {
  const path = join(vault, `${sessionId}.jsonl`);
  const lines = userTexts.map((text, i) =>
    JSON.stringify({
      parentUuid: i === 0 ? null : `u-${i - 1}`,
      sessionId,
      entrypoint: "cli",
      type: "user",
      uuid: `u-${i}`,
      timestamp: "2026-06-20T10:00:00Z",
      message: { role: "user", content: text },
    }),
  );
  // An assistant turn whose text carries a marker must NOT be auto-extracted.
  lines.push(
    JSON.stringify({
      parentUuid: `u-${userTexts.length - 1}`,
      sessionId,
      entrypoint: "cli",
      type: "assistant",
      uuid: "a-0",
      timestamp: "2026-06-20T10:00:01Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '@osb feedback negative topic=assistant-noise principle="should not be captured"',
          },
        ],
      },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function readAuditDetails(auditPath: string): Record<string, unknown> {
  const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]!);
  return last.details as Record<string, unknown>;
}

describe("captureSessionLifecycleEvent interrupted close", () => {
  test("consumes the pre-restart transcript and records interrupted honestly", async () => {
    const sessionId = "session-interrupted";
    const transcriptPath = writeClaudeTranscript(sessionId, [
      '@osb feedback positive topic=interrupted-capture principle="capture in-flight turns"',
    ]);

    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        transcript_path: transcriptPath,
        interrupted: true,
      },
      { agent: "tester", now: new Date("2026-06-20T10:05:00Z") },
    );

    expect(result.event).toBe("SessionEnd");
    expect(result.interrupted).toBe(true);
    expect(result.transcript_consumed).toBe(true);
    // The in-flight user marker reached storage.
    expect(result.signals_created).toBe(1);

    const signalFiles = readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.endsWith(".md"));
    expect(signalFiles).toHaveLength(1);
    expect(readFileSync(join(vault, "Brain", "inbox", signalFiles[0]!), "utf8")).toContain(
      "interrupted-capture",
    );

    // Audit honesty.
    const details = readAuditDetails(result.audit_path);
    expect(details["interrupted"]).toBe(true);
    expect(details["transcript_consumed"]).toBe(true);
  });

  test("resuming the same session does not re-capture turns already captured", async () => {
    const sessionId = "session-resume";
    const transcriptPath = writeClaudeTranscript(sessionId, [
      '@osb feedback positive topic=resume-dedup principle="no double counting on resume"',
    ]);

    const first = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        transcript_path: transcriptPath,
        interrupted: true,
      },
      { agent: "tester", now: new Date("2026-06-20T10:05:00Z") },
    );
    expect(first.signals_created).toBe(1);

    // Resume: the same transcript turns are re-read on the next interrupted
    // close. The content-keyed dedupe seam must suppress them all.
    const second = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        transcript_path: transcriptPath,
        interrupted: true,
      },
      { agent: "tester", now: new Date("2026-06-20T10:10:00Z") },
    );
    expect(second.signals_created).toBe(0);
    expect(second.signals_deduped).toBe(1);
    expect(second.transcript_consumed).toBe(true);

    const signalFiles = readdirSync(join(vault, "Brain", "inbox")).filter((n) => n.endsWith(".md"));
    expect(signalFiles).toHaveLength(1);
  });

  test("an unreadable transcript records interrupted with transcript_consumed false", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "SessionEnd",
        session_id: "session-no-transcript",
        transcript_path: join(vault, "does-not-exist.jsonl"),
        interrupted: true,
      },
      { agent: "tester", now: new Date("2026-06-20T10:15:00Z") },
    );

    expect(result.interrupted).toBe(true);
    expect(result.transcript_consumed).toBe(false);
    expect(result.signals_created).toBe(0);
    const details = readAuditDetails(result.audit_path);
    expect(details["interrupted"]).toBe(true);
    expect(details["transcript_consumed"]).toBe(false);
  });

  test("a clean close (absent interrupted) stays byte-identical", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "SessionEnd", session_id: "session-clean" },
      { agent: "tester", now: new Date("2026-06-20T10:20:00Z") },
    );

    expect(result.event).toBe("SessionEnd");
    expect(result.interrupted).toBeUndefined();
    expect(result.transcript_consumed).toBeUndefined();
    const details = readAuditDetails(result.audit_path);
    expect("interrupted" in details).toBe(false);
    expect("transcript_consumed" in details).toBe(false);
  });
});
