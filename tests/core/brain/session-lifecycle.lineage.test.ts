/**
 * Lineage plumbing through lifecycle capture
 * (continuity-hygiene-freshness suite, Task 3; kanban t_d08ccc5a).
 *
 * The hook payload boundary now carries optional native lineage fields
 * (upstream Hermes PR #42940); capture resolves them through the
 * lineage kernel, feeds the crutch ledger, and stamps non-flat lineage
 * into its result. Flat sessions stay byte-identical to the
 * pre-lineage behavior: no lineage key anywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import {
  readLineageLedger,
  sessionLineageLedgerPath,
} from "../../../src/core/brain/lineage/ledger.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lifecycle-lineage-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("captureSessionLifecycleEvent — native lineage payload", () => {
  test("resolves payload lineage fields and stamps them on the result", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "seg-2",
        parent_session_id: "seg-1",
        root_session_id: "seg-1",
        compression_depth: 1,
        cwd: "/work",
        prompt: "hello",
      },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z") },
    );
    expect(result.lineage).toEqual({
      rootId: "seg-1",
      parentId: "seg-1",
      depth: 1,
      source: "payload",
    });
    const entry = readLineageLedger(vault).get("seg-2");
    expect(entry?.lineage?.rootId).toBe("seg-1");
  });

  test("flat payload carries no lineage key and records a plain observation", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "solo-1",
        cwd: "/work",
        prompt: "hello",
      },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z") },
    );
    expect("lineage" in result).toBe(false);
    const entry = readLineageLedger(vault).get("solo-1");
    expect(entry).toBeDefined();
    expect(entry?.lineage).toBeUndefined();
  });
});

describe("captureSessionLifecycleEvent — crutch flow (CRUTCH(t_1459706f))", () => {
  test("stitches a new session that follows a compression boundary in the same cwd", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "old-1", cwd: "/work", prompt: "hi" },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z") },
    );
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "PostCompact", session_id: "old-1", cwd: "/work" },
      { agent: "tester", now: new Date("2026-06-10T09:10:00Z") },
    );
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "new-1", cwd: "/work", prompt: "go" },
      { agent: "tester", now: new Date("2026-06-10T09:11:00Z") },
    );
    expect(result.lineage).toEqual({
      rootId: "old-1",
      parentId: "old-1",
      depth: 1,
      source: "crutch",
    });
  });

  test("SessionStart with source compact counts as compression evidence", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "SessionStart", session_id: "old-2", cwd: "/work", source: "compact" },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z") },
    );
    const entry = readLineageLedger(vault).get("old-2");
    expect(entry?.compressionEvidence).toBe(true);
  });

  test("does not stitch across cwds", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "PostCompact", session_id: "old-3", cwd: "/a" },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z") },
    );
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "new-3", cwd: "/b", prompt: "go" },
      { agent: "tester", now: new Date("2026-06-10T09:01:00Z") },
    );
    expect("lineage" in result).toBe(false);
  });
});

describe("captureSessionLifecycleEvent — ledger write gating", () => {
  test("dry runs never write the ledger", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "dry-1", cwd: "/work", prompt: "x" },
      { agent: "tester", now: new Date("2026-06-10T09:00:00Z"), dryRun: true },
    );
    expect(existsSync(sessionLineageLedgerPath(vault))).toBe(false);
  });
});
