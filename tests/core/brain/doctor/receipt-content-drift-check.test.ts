/**
 * The `receipt-content-drift` doctor check (t_4300e5fd, lane B task B4).
 *
 * The check re-verifies a bounded recent window of context receipts
 * through the same K2 kernel the verify faces serve, and reports ONE
 * warning with per-verdict counts and the next command when anything
 * reports changed. Legacy receipts without hashes are silent, like the
 * preference content-hash precedent; session_inject receipts are
 * nothing-verifiable by construction and stay silent too.
 *
 * The doctor.ts registration, the exit classification and the docs rows
 * are the shared registration pass; this suite pins the check module's
 * own contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../../src/core/brain/continuity/store.ts";
import { emitContextReceipt } from "../../../../src/core/brain/context-receipts.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  RECEIPT_CONTENT_DRIFT_CODE,
  RECEIPT_CONTENT_DRIFT_SINCE_DAYS,
  RECEIPT_CONTENT_DRIFT_WINDOW,
  receiptContentDriftCheck,
} from "../../../../src/core/brain/doctor/receipt-content-drift-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

/** Pinned so the window arithmetic below is exact, not wall clock. */
const NOW = new Date("2026-06-01T00:00:00.000Z");

/** A `createdAt` inside the recent window, `daysAgo` days before NOW. */
function recent(daysAgo = 1): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-drift-check-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePage(name: string, body: string): string {
  const abs = join(vault, "Brain", "preferences", name);
  writeFileSync(abs, `---\nid: ${name.replace(/\.md$/, "")}\n---\n\n${body}`, "utf8");
  return abs;
}

interface EmitOptions {
  readonly createdAt?: string;
  readonly trigger?: "context_pack" | "pre_compress" | "session_inject";
  readonly withText?: boolean;
}

function emitPageReceipt(abs: string, body: string, opts: EmitOptions = {}) {
  return emitContextReceipt(vault, {
    options: {
      host: "drift-test",
      trigger: opts.trigger ?? "context_pack",
      createdAt: opts.createdAt ?? recent(),
    },
    items: [
      {
        id: "pref-drift",
        path: abs,
        ...(opts.withText === false ? {} : { text: body.trim() }),
      },
    ],
    finalText: body.trim(),
  });
}

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  receiptContentDriftCheck.run({ vault, now: NOW } as unknown as DoctorCheckContext, {
    issues,
    uncertain,
  });
  return { issues, uncertain };
}

function runWithReadable(readable: (rel: string) => boolean): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  receiptContentDriftCheck.run({ vault, now: NOW, readable } as unknown as DoctorCheckContext, {
    issues,
    uncertain,
  });
  return { issues, uncertain };
}

function driftIssues(result: RunResult): ReadonlyArray<DoctorIssue> {
  return result.issues.filter((issue) => issue.code === RECEIPT_CONTENT_DRIFT_CODE);
}

describe("receipt content drift check", () => {
  test("the check never fails the pass", () => {
    expect(receiptContentDriftCheck.failSoft).toBe(true);
  });

  test("a window with an edited page yields exactly one warning naming counts and the next command", () => {
    const abs = writePage("pref-drift.md", "The delivered rule.\n");
    const receipt = emitPageReceipt(abs, "The delivered rule.\n");
    writePage("pref-drift.md", "The rule was silently rewritten.\n");

    const result = run();

    const issues = driftIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("1 item(s) changed");
    expect(issues[0]!.message).toContain("o2b brain context-receipts verify");
    expect(issues[0]!.message).toContain(receipt.id);
    expect(result.uncertain).toEqual([]);
  });

  test("a clean window is silent", () => {
    const abs = writePage("pref-drift.md", "The delivered rule.\n");
    emitPageReceipt(abs, "The delivered rule.\n");

    const result = run();

    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("a vault with no receipts is silent and never throws", () => {
    const result = run();
    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("legacy hashless receipts are silent", () => {
    const abs = writePage("pref-drift.md", "Body.\n");
    emitPageReceipt(abs, "Body.\n", { withText: false });
    writePage("pref-drift.md", "Edited body.\n");

    const result = run();

    expect(driftIssues(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("session_inject receipts are silent - nothing verifiable by construction", () => {
    emitContextReceipt(vault, {
      options: { host: "hook", trigger: "session_inject", createdAt: recent() },
      items: [{ id: "active-body", bytes: 40, tokens: 10 }],
      finalText: "eager layer",
    });

    const result = run();

    expect(driftIssues(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("the window is bounded: an old drifted receipt outside the read window is silent", () => {
    const oldAbs = writePage("pref-drift.md", "Old delivered rule.\n");
    const oldReceipt = emitPageReceipt(oldAbs, "Old delivered rule.\n", {
      createdAt: new Date(
        NOW.getTime() - (RECEIPT_CONTENT_DRIFT_SINCE_DAYS + 11) * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    expect(Number.isNaN(Date.parse(oldReceipt.createdAt))).toBe(false);
    writePage("pref-drift.md", "Old rule rewritten.\n");

    const result = run();

    expect(driftIssues(result)).toEqual([]);
  });

  test("the fold is bounded to the newest WINDOW receipts", () => {
    const abs = writePage("pref-drift.md", "Shared body.\n");
    for (let i = 0; i < RECEIPT_CONTENT_DRIFT_WINDOW + 5; i++) {
      emitPageReceipt(abs, "Shared body.\n", { createdAt: recent(1 + i * 0.001) });
    }
    writePage("pref-drift.md", "Every receipt in the window now drifts.\n");

    const result = run();

    const issues = driftIssues(result);
    expect(issues).toHaveLength(1);
    // The warning names the WINDOW receipts folded, not the larger ledger.
    expect(issues[0]!.message).toContain(`${RECEIPT_CONTENT_DRIFT_WINDOW} recent`);
  });

  test("private receipts are withheld symmetrically with the fold", () => {
    const abs = writePage("pref-drift.md", "A private delivery.\n");
    const receipt = emitPageReceipt(abs, "A private delivery.\n");
    // Flag the stored record private in place, as the redaction path would.
    const storePath = join(vault, "Brain", "log", "continuity");
    for (const shard of readdirSync(storePath)) {
      const shardPath = join(storePath, shard);
      const lines = readFileSync(shardPath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      const rewritten = lines.map((line) => {
        const record = JSON.parse(line) as { id: string } & Record<string, unknown>;
        if (record.id === receipt.id) return JSON.stringify({ ...record, private: true });
        return line;
      });
      writeFileSync(shardPath, `${rewritten.join("\n")}\n`, "utf8");
    }
    writePage("pref-drift.md", "Edited after a private delivery.\n");

    const result = run();

    expect(driftIssues(result)).toEqual([]);
  });

  test("the check never mutates the ledger", () => {
    const abs = writePage("pref-drift.md", "The delivered rule.\n");
    emitPageReceipt(abs, "The delivered rule.\n");
    writePage("pref-drift.md", "Rewritten.\n");
    const before = listContinuityRecords(vault, { kind: "context_receipt" }).length;

    run();

    expect(listContinuityRecords(vault, { kind: "context_receipt" }).length).toBe(before);
  });
});

describe("the window counts verifiable receipts", () => {
  test("a burst of session-inject receipts does not push the drifted one out of the window", () => {
    const abs = writePage("pref-drift.md", "The original drifted text.\n");
    // One drifted context_pack receipt, ten days old - inside the read
    // window, but OLDER than a burst of newer session_inject receipts.
    emitPageReceipt(abs, "The original drifted text.\n", { createdAt: recent(10) });
    writePage("pref-drift.md", "The rule was silently rewritten.\n");
    for (let i = 0; i < RECEIPT_CONTENT_DRIFT_WINDOW + 5; i++) {
      emitPageReceipt(abs, "unused", {
        trigger: "session_inject",
        createdAt: recent(Math.max(1, 9 - Math.floor(i / 2))),
      });
    }
    const { issues } = run();
    // The verifiable receipt is inside the fold no matter how many
    // never-verifiable ones sit newer: "not looked at" is not "healthy".
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(RECEIPT_CONTENT_DRIFT_CODE);
  });

  test("items on pages the caller may not read move no count and name no receipt", () => {
    const abs = writePage("pref-drift.md", "The original drifted text.\n");
    emitPageReceipt(abs, "The original drifted text.\n");
    writePage("pref-drift.md", "The rule was silently rewritten.\n");
    // Every page withheld from this caller: the drifted receipt counts
    // nothing and the warning stays silent - the counting contract every
    // counting check follows.
    const { issues } = runWithReadable(() => false);
    expect(issues).toEqual([]);
    // The caller that may read the page sees the drift.
    const { issues: open } = runWithReadable(() => true);
    expect(open).toHaveLength(1);
  });
});
