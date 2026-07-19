/**
 * Inbox-drain classify-and-route pass (Knowledge intake suite, I2,
 * t_b0bba8cb).
 *
 * Walks staged captures via the seam-1 contract, classifies each
 * structurally (source-reference by URL-shaped body, obligation by explicit
 * marker, otherwise atomic idea), and routes on apply. Dry-run is the
 * default and writes nothing; a rerun after apply is a no-op.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPTURE_OBLIGATION_MARKER,
  CAPTURED_NOTES_DIR_REL,
  drainInbox,
} from "../../../../src/core/brain/capture/inbox-drain.ts";
import {
  listStagedCaptures,
  listArchivedCaptures,
  writeCaptureNote,
  type CaptureProvenance,
} from "../../../../src/core/brain/capture/capture-note.ts";
import { capturesProcessedDir } from "../../../../src/core/brain/paths.ts";
import { listObligations } from "../../../../src/core/brain/obligations.ts";

const NOW = new Date("2026-07-19T12:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-inbox-drain-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function prov(seconds: number): CaptureProvenance {
  const ss = String(seconds).padStart(2, "0");
  return { source: "telegram", sender: "100", capturedAt: `2026-07-19T12:00:${ss}Z` };
}

function seed() {
  writeCaptureNote(vault, { body: "https://example.com/article", provenance: prov(1) });
  writeCaptureNote(vault, {
    body: `${CAPTURE_OBLIGATION_MARKER}:weekly review the backlog`,
    provenance: prov(2),
  });
  writeCaptureNote(vault, { body: "a standalone atomic idea", provenance: prov(3) });
}

test("dry-run is the default: it classifies every capture and writes nothing", () => {
  seed();
  const report = drainInbox(vault, { apply: false, agent: "tester", now: NOW });
  expect(report.mode).toBe("dry-run");
  expect(report.items.map((i) => i.classification)).toEqual([
    "source-reference",
    "obligation",
    "idea",
  ]);
  // Nothing routed, nothing archived, everything still staged.
  expect(report.routed).toBe(0);
  expect(listStagedCaptures(vault)).toHaveLength(3);
  expect(listArchivedCaptures(vault)).toHaveLength(0);
  expect(existsSync(join(vault, CAPTURED_NOTES_DIR_REL))).toBe(false);
  expect(listObligations(vault, { now: NOW })).toHaveLength(0);
});

test("apply routes each class and archives the processed captures", () => {
  seed();
  const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(report.mode).toBe("apply");
  expect(report.routed).toBe(3);
  expect(report.items.map((i) => i.action)).toEqual(["ingest-source", "open-obligation", "note"]);
  // Every routed capture carries a resolved target and reason.
  expect(report.items.every((i) => i.target !== null && i.reason.length > 0)).toBe(true);
  // Obligation opened, idea note written, captures archived.
  expect(listObligations(vault, { now: NOW }).map((o) => o.title)).toContain("review the backlog");
  expect(existsSync(join(vault, CAPTURED_NOTES_DIR_REL))).toBe(true);
  expect(listStagedCaptures(vault)).toHaveLength(0);
  expect(listArchivedCaptures(vault)).toHaveLength(3);
});

test("rerun after apply is a no-op via the processed-marker idempotency", () => {
  seed();
  drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  const obligationsBefore = listObligations(vault, { now: NOW }).length;
  const rerun = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(rerun.items).toHaveLength(0);
  expect(rerun.routed).toBe(0);
  expect(listObligations(vault, { now: NOW })).toHaveLength(obligationsBefore);
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("an idea whose slug already exists merges instead of forking", () => {
  writeCaptureNote(vault, { body: "shared idea title", provenance: prov(1) });
  drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  writeCaptureNote(vault, { body: "shared idea title", provenance: prov(2) });
  const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(report.items[0]!.action).toBe("note");
  expect(report.items[0]!.reason.toLowerCase()).toContain("merge");
  // One note file, not two.
  const notes = existsSync(join(vault, CAPTURED_NOTES_DIR_REL))
    ? readdirSync(join(vault, CAPTURED_NOTES_DIR_REL))
    : [];
  expect(notes).toHaveLength(1);
});

test("an obligation marker without a title is unroutable and left in place", () => {
  writeCaptureNote(vault, { body: `${CAPTURE_OBLIGATION_MARKER}:weekly   `, provenance: prov(1) });
  const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(report.items[0]!.classification).toBe("unroutable");
  expect(report.unroutable).toBe(1);
  expect(report.routed).toBe(0);
  // Left in place, not archived.
  expect(listStagedCaptures(vault)).toHaveLength(1);
  expect(listArchivedCaptures(vault)).toHaveLength(0);
});

test("a route that succeeds but whose archive fails is a distinct state; a re-run does not duplicate the idea note", () => {
  const body = "an idea that survives a broken archive";
  writeCaptureNote(vault, { body, provenance: prov(1) });

  // Plant a FILE where the processed dir must be created, so archiveCapture's
  // mkdir throws AFTER plan.execute() has already written the idea note.
  const processed = capturesProcessedDir(vault);
  writeFileSync(processed, "blocker");

  const first = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(first.items[0]!.classification).toBe("archive-failed");
  expect(first.archiveFailed).toBe(1);
  expect(first.routed).toBe(0);
  expect(first.unroutable).toBe(0);
  // The route ran: the idea note exists and the capture is still staged.
  expect(existsSync(join(vault, CAPTURED_NOTES_DIR_REL))).toBe(true);
  expect(listStagedCaptures(vault)).toHaveLength(1);

  // Clear the blocker; the re-run archives without re-appending the idea body.
  rmSync(processed, { force: true });
  const rerun = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(rerun.routed).toBe(1);
  expect(rerun.archiveFailed).toBe(0);
  expect(listStagedCaptures(vault)).toHaveLength(0);
  expect(listArchivedCaptures(vault)).toHaveLength(1);

  // The idea note contains the captured body exactly once - no duplicate merge.
  const dir = join(vault, CAPTURED_NOTES_DIR_REL);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const noteBody = readFileSync(join(dir, files[0]!), "utf8");
  expect(noteBody.split(body).length - 1).toBe(1);
});

test("an obligation marker defaults the cadence when none is given", () => {
  writeCaptureNote(vault, {
    body: `${CAPTURE_OBLIGATION_MARKER} tidy the desk`,
    provenance: prov(1),
  });
  const report = drainInbox(vault, { apply: true, agent: "tester", now: NOW });
  expect(report.items[0]!.action).toBe("open-obligation");
  expect(listObligations(vault, { now: NOW }).map((o) => o.title)).toContain("tidy the desk");
});
