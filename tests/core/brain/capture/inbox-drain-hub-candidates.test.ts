/**
 * Hub candidates at inbox-drain (t_23bd347d): an apply-mode idea route that
 * succeeds stages exactly one hub record for the routed page - a candidate
 * when one structural hub matches its scope bucket, a named refusal when
 * none or several do. Obligation and source-reference routes stage nothing,
 * a dry-run stages nothing, and re-routing the same capture converges to one
 * record. No edge is ever written here: the store is the only artifact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  CAPTURE_OBLIGATION_MARKER,
  drainInbox,
} from "../../../../src/core/brain/capture/inbox-drain.ts";
import {
  writeCaptureNote,
  type CaptureProvenance,
} from "../../../../src/core/brain/capture/capture-note.ts";
import { capturesProcessedDir } from "../../../../src/core/brain/paths.ts";
import {
  REPAIR_CANDIDATES_STORE_FILE,
  loadStagedHubRecords,
} from "../../../../src/core/brain/link-graph/hub-candidates.ts";
import { IDENTITY_STRENGTH } from "../../../../src/core/brain/link-graph/repair-lane.ts";
import { BRAIN_INTERNAL_STATE_REL } from "../../../../src/core/brain/path-constants.ts";

let vault: string;

const NOW = new Date("2026-07-19T12:00:00Z");
const IDEA_BODY = "a standalone atomic idea";
const ROUTED_REL = "captured/a-standalone-atomic-idea.md";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-drain-hub-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function prov(seconds: number): CaptureProvenance {
  const ss = String(seconds).padStart(2, "0");
  return { source: "telegram", sender: "100", capturedAt: `2026-07-19T12:00:${ss}Z` };
}

function writeHub(rel: string, title: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    [
      "---",
      "kind: brain-note",
      `title: ${title}`,
      "---",
      "",
      "[[a]] [[b]] [[c]] [[d]] [[e]]",
      "",
    ].join("\n"),
    "utf8",
  );
}

function storePath(): string {
  return join(vault, BRAIN_INTERNAL_STATE_REL, REPAIR_CANDIDATES_STORE_FILE);
}

describe("drainInbox hub candidates", () => {
  test("an apply-mode idea route stages a candidate for its unique hub", () => {
    writeHub("Brain/areas/ops.md", "Ops Hub");
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });
    const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    expect(report.routed).toBe(1);
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(1);
    expect(staged.refusals).toHaveLength(0);
    const candidate = staged.candidates[0]!;
    expect(candidate.source).toBe(ROUTED_REL);
    expect(candidate.target).toBe("Brain/areas/ops.md");
    expect(candidate.strength).toBe(IDENTITY_STRENGTH.areaMembership);
    expect(candidate.confidence).toBe(1);
    expect(candidate.reason).toContain("Brain/areas/ops.md");
  });

  test("zero hubs stages a skip-no-hub refusal and no candidate", () => {
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });
    drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(0);
    expect(staged.refusals).toHaveLength(1);
    expect(staged.refusals[0]!.action).toBe("skip-no-hub");
    expect(staged.refusals[0]!.source).toBe(ROUTED_REL);
    expect(staged.refusals[0]!.reason).toContain("(unscoped)");
  });

  test("multiple hubs stage a skip-ambiguous-hub refusal listing every hub", () => {
    writeHub("Brain/areas/alpha-hub.md", "Alpha Hub");
    writeHub("Brain/areas/beta-hub.md", "Beta Hub");
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });
    drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(0);
    expect(staged.refusals).toHaveLength(1);
    const refusal = staged.refusals[0]!;
    expect(refusal.action).toBe("skip-ambiguous-hub");
    expect(refusal.reason).toContain("Brain/areas/alpha-hub.md");
    expect(refusal.reason).toContain("Brain/areas/beta-hub.md");
  });

  test("a corrupt store line is a counted skip, and the drain completes", () => {
    writeHub("Brain/areas/ops.md", "Ops Hub");
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "not json\n", "utf8");
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });
    const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    expect(report.routed).toBe(1);
    expect(report.skippedCorrupt).toBe(1);
    expect(loadStagedHubRecords(vault).candidates).toHaveLength(1);
  });

  test("obligation and source-reference routes stage nothing", () => {
    writeCaptureNote(vault, { body: "https://example.com/article", provenance: prov(1) });
    writeCaptureNote(vault, {
      body: `${CAPTURE_OBLIGATION_MARKER}:weekly review the backlog`,
      provenance: prov(2),
    });
    const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    expect(report.routed).toBe(2);
    expect(existsSync(storePath())).toBe(false);
  });

  test("a dry-run drain stages nothing", () => {
    writeHub("Brain/areas/ops.md", "Ops Hub");
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });
    const report = drainInbox(vault, { apply: false, agent: "tester", now: NOW });
    expect(report.mode).toBe("dry-run");
    expect(existsSync(storePath())).toBe(false);
  });

  test("re-routing the same capture after a failed archive stages the record once", () => {
    writeHub("Brain/areas/ops.md", "Ops Hub");
    writeCaptureNote(vault, { body: IDEA_BODY, provenance: prov(1) });

    // The route succeeds, the hub record is staged, then the archive fails:
    // the capture is still staged, so a rerun re-executes the same route.
    writeFileSync(capturesProcessedDir(vault), "blocker");
    const first = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    expect(first.archiveFailed).toBe(1);
    expect(loadStagedHubRecords(vault).candidates).toHaveLength(1);

    rmSync(capturesProcessedDir(vault), { force: true });
    const rerun = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
    expect(rerun.routed).toBe(1);
    const staged = loadStagedHubRecords(vault);
    expect(staged.candidates).toHaveLength(1);
    expect(staged.candidates[0]!.target).toBe("Brain/areas/ops.md");
  });
});
