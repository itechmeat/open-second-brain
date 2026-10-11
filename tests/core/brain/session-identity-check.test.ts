/**
 * The blank-session-identity check (t_22d58fa7).
 *
 * Readers across the continuity surface used to coerce a missing or
 * non-string `session_id` to "" - a phantom identity no writer ever
 * stamped. The readers now treat absence as no-session explicitly, and
 * this check is the vault-level mirror of that decision: it COUNTS the
 * records that name no session, one issue per affected kind, and does
 * nothing else. No `fix` field (a session no writer stamped cannot be
 * restored from the record, and the ledger is append-only history), no
 * payload rewrite, and an unreadable ledger is an uncertainty rather
 * than a clean bill.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import type { AppendContinuityRecordInput } from "../../../src/core/brain/continuity/types.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  SESSION_IDENTITY_CHECK_CODE,
  sessionIdentityCheck,
} from "../../../src/core/brain/doctor/session-identity-check.ts";
import type { DoctorUncertainEntry } from "../../../src/core/brain/doctor/report.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-session-identity-"));
  vault = join(tmp, "vault");
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(
  payload: Record<string, unknown>,
  kind: AppendContinuityRecordInput["kind"] = "session_turn",
): void {
  appendContinuityRecord(vault, {
    kind,
    createdAt: "2026-06-01T00:00:00.000Z",
    payload,
  });
}

function findings(): { issues: DoctorIssue[]; uncertain: DoctorUncertainEntry[] } {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  sessionIdentityCheck.run(
    {
      vault,
      now: new Date("2026-06-02T00:00:00.000Z"),
      logs: [],
    } as unknown as Parameters<typeof sessionIdentityCheck.run>[0],
    { issues, uncertain },
  );
  return { issues, uncertain };
}

describe("blank-session-identity counts, and only counts", () => {
  test("one issue per affected kind, carrying the count, with no fix field", () => {
    seed({ turn_id: "t1", text: "names no session" });
    seed({ turn_id: "t2", text: "names no session either" });
    seed({ event: "recall", text: "telemetry names no session" }, "recall_telemetry");
    seed({ session_id: "sess-real", turn_id: "t3", text: "attributed" });

    const { issues, uncertain } = findings();
    expect(uncertain).toEqual([]);
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("1 recall_telemetry"),
      expect.stringContaining("2 session_turn"),
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
      expect(issue.code).toBe(SESSION_IDENTITY_CHECK_CODE);
      expect("fix" in issue).toBe(false);
    }
  });

  test("an empty-string or non-string session_id counts as blank, never as an identity", () => {
    seed({ session_id: "", turn_id: "t1", text: "blank string" });
    seed({ session_id: 42, turn_id: "t2", text: "numeric" });

    const { issues } = findings();
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("2 session_turn");
  });

  test("a clean ledger is quiet", () => {
    seed({ session_id: "sess-a", turn_id: "t1", text: "attributed" });
    expect(findings().issues).toEqual([]);
  });

  test("an unreadable ledger is an uncertain stream outcome, never a throw or a finding", () => {
    // A regular file where the continuity directory belongs: the listing
    // fails for a reason that is not absence, which is precisely what the
    // uncertainty stream exists for.
    const continuity = join(vault, "Brain", "log", "continuity");
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    writeFileSync(continuity, "not a directory\n");

    const { issues, uncertain } = findings();
    expect(issues).toEqual([]);
    expect(uncertain.length).toBe(1);
    expect(uncertain[0]!.code).toBe("vault-walk-entry-skipped");
  });

  test("an absent ledger is the ordinary quiet case, not uncertainty", () => {
    rmSync(join(vault, "Brain", "log", "continuity"), { recursive: true, force: true });
    const { issues, uncertain } = findings();
    expect(issues).toEqual([]);
    expect(uncertain).toEqual([]);
  });
});

describe("blank-session-identity runs in the pass", () => {
  test("runDoctor reports the count with zero config", () => {
    seed({ turn_id: "t1", text: "names no session" });
    const result = runDoctor(vault);
    const warning = result.warnings.find((issue) => issue.code === SESSION_IDENTITY_CHECK_CODE);
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("1 session_turn");
  });

  test("a clean vault stays clean", () => {
    const result = runDoctor(vault);
    expect(result.warnings.some((issue) => issue.code === SESSION_IDENTITY_CHECK_CODE)).toBe(false);
  });
});
