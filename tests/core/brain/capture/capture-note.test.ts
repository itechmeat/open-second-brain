/**
 * Capture-note contract (Knowledge intake suite, seam 1, t_f8f5ef6a).
 *
 * The contract owns the staging vocabulary shared by the inbound Telegram
 * capture bot (writer) and the inbox-drain pass (reader): the frontmatter
 * kind, provenance (source, sender, capture timestamp), the staging and
 * archive path helpers, and the read/write/list/archive functions.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_CAPTURE_KIND,
  CaptureContractError,
  archiveCapture,
  capturesSince,
  listStagedCaptures,
  readCatchupWatermark,
  writeCaptureNote,
  writeCatchupWatermark,
  type CaptureProvenance,
} from "../../../../src/core/brain/capture/capture-note.ts";
import { capturesDir, capturesProcessedDir } from "../../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-capture-note-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function prov(overrides: Partial<CaptureProvenance> = {}): CaptureProvenance {
  return {
    source: "telegram",
    sender: "12345",
    capturedAt: "2026-07-19T12:00:00Z",
    ...overrides,
  };
}

test("writeCaptureNote stamps kind, provenance, and timestamp into staging", () => {
  const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
  expect(note.staged).toBe(true);
  expect(note.provenance.source).toBe("telegram");
  expect(note.provenance.sender).toBe("12345");
  expect(note.provenance.capturedAt).toBe("2026-07-19T12:00:00Z");
  expect(note.body).toBe("capture a thought");
  expect(existsSync(join(vault, note.path))).toBe(true);
  expect(note.path.startsWith("Brain/captures/")).toBe(true);
  expect(note.id.startsWith("cap-")).toBe(true);
});

test("BRAIN_CAPTURE_KIND is the frontmatter kind marker", () => {
  expect(BRAIN_CAPTURE_KIND).toBe("brain-capture");
});

test("writeCaptureNote refuses an empty body with a typed error", () => {
  expect(() => writeCaptureNote(vault, { body: "   ", provenance: prov() })).toThrow(
    CaptureContractError,
  );
});

test("writeCaptureNote refuses empty provenance identity with a typed error", () => {
  expect(() => writeCaptureNote(vault, { body: "x", provenance: prov({ sender: "" }) })).toThrow(
    CaptureContractError,
  );
  expect(() => writeCaptureNote(vault, { body: "x", provenance: prov({ source: "" }) })).toThrow(
    CaptureContractError,
  );
});

test("listStagedCaptures returns staged captures sorted chronologically", () => {
  writeCaptureNote(vault, {
    body: "second",
    provenance: prov({ capturedAt: "2026-07-19T12:00:02Z" }),
  });
  writeCaptureNote(vault, {
    body: "first",
    provenance: prov({ capturedAt: "2026-07-19T12:00:01Z" }),
  });
  const staged = listStagedCaptures(vault);
  expect(staged.map((c) => c.body)).toEqual(["first", "second"]);
  expect(staged.every((c) => c.staged)).toBe(true);
});

test("archiveCapture moves a staged capture into the processed area", () => {
  const note = writeCaptureNote(vault, { body: "drain me", provenance: prov() });
  const archived = archiveCapture(vault, note.id);
  expect(archived.staged).toBe(false);
  expect(existsSync(join(vault, note.path))).toBe(false);
  expect(existsSync(join(vault, archived.path))).toBe(true);
  expect(archived.path.startsWith("Brain/captures/processed/")).toBe(true);
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("archiveCapture on an unknown id is a typed error", () => {
  expect(() => archiveCapture(vault, "cap-2026-07-19-000000-deadbeef")).toThrow(
    CaptureContractError,
  );
});

test("capturesSince honours the watermark across staging and archive", () => {
  const a = writeCaptureNote(vault, {
    body: "a",
    provenance: prov({ capturedAt: "2026-07-19T12:00:01Z" }),
  });
  const b = writeCaptureNote(vault, {
    body: "b",
    provenance: prov({ capturedAt: "2026-07-19T12:00:02Z" }),
  });
  // Archiving must not hide a capture from catchup.
  archiveCapture(vault, a.id);
  expect(capturesSince(vault, null).map((c) => c.body)).toEqual(["a", "b"]);
  expect(capturesSince(vault, a.id).map((c) => c.body)).toEqual(["b"]);
  expect(capturesSince(vault, b.id)).toHaveLength(0);
});

test("catchup watermark round-trips and is absent by default", () => {
  expect(readCatchupWatermark(vault)).toBeNull();
  writeCatchupWatermark(vault, "cap-2026-07-19-120000-abcdabcd");
  expect(readCatchupWatermark(vault)).toBe("cap-2026-07-19-120000-abcdabcd");
});

test("path helpers resolve inside the Brain captures tree", () => {
  expect(capturesDir(vault).endsWith(join("Brain", "captures"))).toBe(true);
  expect(capturesProcessedDir(vault).endsWith(join("Brain", "captures", "processed"))).toBe(true);
});
