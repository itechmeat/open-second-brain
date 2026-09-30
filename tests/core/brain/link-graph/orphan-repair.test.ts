/**
 * The orphan-observation repair lane (t_6cc80627).
 *
 * The repair DETACHES a dangling `session_ref` from a signal's
 * frontmatter and keeps the observation: nothing is deleted, no content
 * is rewritten, and the detached value is named in the decision so the
 * change is auditable. What this file pins is the lane discipline the
 * memory-graph repair lane established, applied to a destructive-looking
 * act that is in fact a one-key removal: dry-run default, exact confirm
 * phrase, hard per-run write cap, and an idempotent rescan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detachSessionRef,
  ORPHAN_REPAIR_CONFIRM_PHRASE,
  OrphanRepairConfirmationError,
  ORPHAN_REPAIR_WRITE_CAP,
  runOrphanRepair,
} from "../../../../src/core/brain/link-graph/orphan-repair.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { acquireLockSync } from "../../../../src/core/brain/sync-lockfile.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-orphan-repair-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeOrphan(sessionRef = "session:sess-gone#turn-1"): string {
  const result = writeSignal(vault, {
    topic: "orphan-repair",
    signal: "positive",
    agent: "tester",
    principle: "repairs detach, never delete",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "orphan-repair",
    source_type: "session",
    session_ref: sessionRef,
    raw: "the observation body",
  });
  return result.path;
}

describe("dry-run is the default and writes nothing", () => {
  test("the detach is listed, the file is byte-identical", () => {
    const path = writeOrphan();
    const before = readFileSync(path, "utf8");
    const report = runOrphanRepair(vault);
    expect(report.mode).toBe("dry-run");
    // `detached` counts the writes a dry run WOULD make, the same
    // convention `RepairReport.written` established: the report is the
    // plan, and the plan says one detach is pending.
    expect(report.detached).toBe(1);
    expect(report.decisions.length).toBe(1);
    expect(report.decisions[0]!.action).toBe("detach");
    expect(report.decisions[0]!.session_ref).toBe("session:sess-gone#turn-1");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("apply requires the exact confirmation phrase", () => {
  test("a wrong phrase throws and the file keeps its reference", () => {
    const path = writeOrphan();
    expect(() => runOrphanRepair(vault, { apply: true, confirm: "nope" })).toThrow(
      OrphanRepairConfirmationError,
    );
    const [, body] = parseFrontmatter(path);
    const [meta] = parseFrontmatter(path);
    expect(meta["session_ref"]).toBeDefined();
    expect(body).toContain("the observation body");
  });

  test("the exact phrase detaches the reference and keeps the observation", () => {
    const path = writeOrphan();
    const report = runOrphanRepair(vault, {
      apply: true,
      confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
    });
    expect(report.mode).toBe("apply");
    expect(report.detached).toBe(1);
    expect(report.decisions[0]!.action).toBe("detach");
    const [meta, body] = parseFrontmatter(path);
    expect(meta["session_ref"]).toBeUndefined();
    expect(body).toContain("the observation body");
    // The observation content is untouched: the topic frontmatter and the
    // raw body read exactly as before the detach.
    expect(meta["topic"]).toBe("orphan-repair");
  });
});

describe("the hard per-run write cap stops a run", () => {
  test("findings past the cap are skip-cap, and an apply writes no more than the cap", () => {
    for (let i = 0; i < ORPHAN_REPAIR_WRITE_CAP + 5; i++) {
      writeSignal(vault, {
        topic: `cap-${i}`,
        signal: "positive",
        agent: "tester",
        principle: "repairs detach, never delete",
        created_at: "2026-06-01T00:00:00Z",
        date: "2026-06-01",
        slug: `cap-${i}`,
        source_type: "session",
        session_ref: `session:sess-gone-${i}#turn-1`,
      });
    }
    const report = runOrphanRepair(vault, {
      apply: true,
      confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
    });
    expect(report.detached).toBe(ORPHAN_REPAIR_WRITE_CAP);
    expect(report.decisions.filter((d) => d.action === "skip-cap").length).toBe(5);
  });

  test("a caller-named cap bounds the run the same way", () => {
    writeOrphan("session:sess-gone-a#turn-1");
    writeSignal(vault, {
      topic: "second",
      signal: "negative",
      agent: "tester",
      principle: "repairs detach, never delete",
      created_at: "2026-06-01T00:00:00Z",
      date: "2026-06-01",
      slug: "second",
      source_type: "session",
      session_ref: "session:sess-gone-b#turn-1",
    });
    const report = runOrphanRepair(vault, {
      apply: true,
      confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
      writeCap: 1,
    });
    expect(report.detached).toBe(1);
    expect(report.decisions.filter((d) => d.action === "skip-cap").length).toBe(1);
  });
});

describe("a rescan after apply is idempotent", () => {
  test("the second run finds nothing to detach and writes nothing", () => {
    const path = writeOrphan();
    runOrphanRepair(vault, { apply: true, confirm: ORPHAN_REPAIR_CONFIRM_PHRASE });
    const afterFirst = readFileSync(path, "utf8");
    const again = runOrphanRepair(vault, {
      apply: true,
      confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
    });
    expect(again.detached).toBe(0);
    expect(again.decisions).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });
});

describe("a reference that changed after the scan is not detached", () => {
  test("detachSessionRef removes only the value the scan quoted", () => {
    const path = writeOrphan("session:sess-new#turn-2");
    const before = readFileSync(path, "utf8");
    // The scan quoted an older value; the file now carries another one.
    expect(detachSessionRef(path, "session:sess-gone#turn-1")).toBe("skip-changed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(detachSessionRef(path, "session:sess-new#turn-2")).toBe("detached");
    expect(parseFrontmatter(path)[0]["session_ref"]).toBeUndefined();
  });
});

describe("the detach runs under the signal's per-file lock", () => {
  test("a held lock leaves the file untouched and is reported skip-locked", () => {
    const path = writeOrphan();
    const before = readFileSync(path, "utf8");
    const held = acquireLockSync(path);
    try {
      expect(detachSessionRef(path, "session:sess-gone#turn-1")).toBe("skip-locked");
      const report = runOrphanRepair(vault, {
        apply: true,
        confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
      });
      expect(report.detached).toBe(0);
      expect(report.decisions.map((d) => d.action)).toEqual(["skip-locked"]);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      held.release();
    }
    // Released, the same run detaches and leaves no lock behind.
    expect(detachSessionRef(path, "session:sess-gone#turn-1")).toBe("detached");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
