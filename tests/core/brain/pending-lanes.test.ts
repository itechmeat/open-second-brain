/**
 * The multi-lane pending queue (write-side trust, Task 9).
 *
 * One store, three lanes. Signals keep `Brain/pending/sig-*.md` exactly
 * as the A3 queue built it; note creates stage at
 * `Brain/pending/notes/note-<date>-<encoded-target>.md`; the ingest
 * summary page stages at `Brain/pending/ingest/ing-<date>-<basename>.md`.
 * The staged bytes are byte-for-byte what the publish target would have
 * received, apply moves them verbatim into the decoded target, and
 * reject renders into `Brain/retired/` with a `osb_pending_lane` stamp.
 * The target encoding is a reversible percent-encoding over a
 * Windows-legal alphabet, round-tripped here against CJK, spaces, dots
 * and nested paths, with the 255-character filename bound refused by
 * name rather than truncated into a collision.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { formatFrontmatter, parseFrontmatter } from "../../../src/core/vault.ts";
import { atomicWriteFileSync, FileAlreadyExistsError } from "../../../src/core/fs-atomic.ts";
import { PermissionsDocumentError } from "../../../src/core/brain/permissions/document.ts";
import { queryDecisionLedger } from "../../../src/core/brain/permissions/ledger.ts";
import { freezeVault } from "../../../src/core/brain/freeze.ts";
import { requireNextStep } from "../../../src/core/brain/next-step.ts";
import { WRITE_REFUSAL_NEXT_COMMAND } from "../../../src/core/brain/write-refusal-exit.ts";
import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { applyWriteBatch } from "../../../src/core/brain/write-batch.ts";
import {
  InvalidPendingIdError,
  PendingApplyConflictError,
  PendingSignalNotFoundError,
  PendingStageConflictError,
  PendingTargetPathError,
  WRITE_APPROVAL_SOURCES,
  WRITE_REFUSAL_CODES,
  WriteRefusedError,
  applyPendingLane,
  decodePendingTargetPath,
  encodePendingTargetPath,
  listPendingLane,
  refuseDocumentDeny,
  resolveWriteDisposition,
  rejectPendingLane,
  stageForReview,
} from "../../../src/core/brain/pending/pending-lanes.ts";
import { stagePendingSignal } from "../../../src/core/brain/pending.ts";

let tmp: string;
let vault: string;
let configPath: string;
const envSaved = new Map<string, string | undefined>();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-pending-lanes-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  for (const [key, value] of envSaved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSaved.clear();
  rmSync(tmp, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!envSaved.has(key)) envSaved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function enableNotes(): void {
  setEnv("OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED", "true");
}

function enableIngest(): void {
  setEnv("OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED", "true");
}

// ----- encode / decode ------------------------------------------------------

describe("encodePendingTargetPath / decodePendingTargetPath", () => {
  const ROUND_TRIPS = [
    "notes/foo/bar",
    "notes with spaces/and more",
    "CJK/项目/笔记",
    "dots.dotted/.hidden/ends.",
    "trailing-dash-",
    "under_scores and+mixed:chars",
    "a",
  ];

  for (const target of ROUND_TRIPS) {
    test(`round-trips ${JSON.stringify(target)}`, () => {
      const encoded = encodePendingTargetPath(target);
      expect(encoded).toMatch(/^[A-Za-z0-9._%-]+$/);
      expect(decodePendingTargetPath(encoded)).toBe(target);
    });
  }

  test("encodes the path separator so one target is one filename", () => {
    expect(encodePendingTargetPath("notes/foo/bar")).toBe("notes%2Ffoo%2Fbar");
  });

  test("encodes Windows-invalid characters and the escape character itself", () => {
    const encoded = encodePendingTargetPath('weird%2F:name*"ord');
    expect(encoded).not.toContain("%2F:"); // a literal colon is Windows-invalid
    expect(encoded).toContain("%25"); // "%" is escaped, so decode is unambiguous
    expect(decodePendingTargetPath(encoded)).toBe('weird%2F:name*"ord');
    expect(encoded).not.toMatch(/[:*?"<>|\\]/);
  });

  test("produces Windows-legal output for control characters", () => {
    const encoded = encodePendingTargetPath("tab\there");
    expect(encoded).toBe("tab%09here");
    expect(decodePendingTargetPath(encoded)).toBe("tab\there");
  });

  test("decoding refuses a malformed escape by name", () => {
    expect(() => decodePendingTargetPath("notes%2Zfoo")).toThrow(PendingTargetPathError);
    expect(() => decodePendingTargetPath("notes%2")).toThrow(PendingTargetPathError);
    expect(() => decodePendingTargetPath("notes%ZZfoo")).toThrow(PendingTargetPathError);
  });

  test("an over-long target refuses at the 255-character filename bound", () => {
    const longTarget = `notes/${"long".repeat(100)}`;
    expect(() => encodePendingTargetPath(longTarget)).toThrow(PendingTargetPathError);
    expect(() => encodePendingTargetPath(longTarget)).toThrow(/255/);
    // The refusal names the bound, not a truncation: nothing is returned.
    let encoded: string | undefined;
    try {
      encoded = encodePendingTargetPath(longTarget);
    } catch {
      encoded = undefined;
    }
    expect(encoded).toBeUndefined();
  });

  test("a reasonably long nested target still encodes", () => {
    const target = `notes/${"segment".repeat(10)}/${"deeper".repeat(5)}`;
    const encoded = encodePendingTargetPath(target);
    expect(decodePendingTargetPath(encoded)).toBe(target);
  });
});

// ----- dispositions ---------------------------------------------------------

describe("resolveWriteDisposition (write-approval keys)", () => {
  test("every lane publishes when no key is set", () => {
    for (const lane of ["signals", "notes", "ingest"] as const) {
      const d = resolveWriteDisposition(vault, lane);
      expect(d.verdict).toBe("publish");
      expect(d.source).toBe("write_approval.enabled");
    }
  });

  test("a config lane key on stages with the key as source", () => {
    setEnv("OPEN_SECOND_BRAIN_CONFIG", configPath);
    writeFileSync(
      configPath,
      `vault: ${vault}\nagent_name: test-agent\nwrite_approval.notes: true\n`,
    );
    const d = resolveWriteDisposition(vault, "notes");
    expect(d.verdict).toBe("stage");
    expect(d.source).toBe("write_approval.notes");
  });

  test("the master key stages every lane and names the link that decided", () => {
    setEnv("OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED", "true");
    for (const lane of ["signals", "notes", "ingest"] as const) {
      const d = resolveWriteDisposition(vault, lane);
      expect(d.verdict).toBe("stage");
      expect(d.source).toBe("OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED");
    }
  });

  test("an env-decided lane names its env twin as source", () => {
    enableIngest();
    const d = resolveWriteDisposition(vault, "ingest");
    expect(d.verdict).toBe("stage");
    expect(d.source).toBe("OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED");
  });
});

// ----- staging --------------------------------------------------------------

describe("stageForReview", () => {
  test("stages note bytes verbatim at the encoded pending path", () => {
    enableNotes();
    const bytes = formatFrontmatter({ title: "From agent" }, "body prose");
    const staged = stageForReview(vault, "notes", "Notes/From Agent.md", () => bytes);
    expect(staged.pendingId).toMatch(/^note-\d{4}-\d{2}-\d{2}-Notes%2FFrom%20Agent$/);
    expect(staged.path.startsWith(join(brainDirs(vault).pending, "notes"))).toBe(true);
    expect(readFileSync(staged.path, "utf8")).toBe(bytes);
  });

  test("stages an ingest page at the deterministic publish basename", () => {
    enableIngest();
    const target = "Brain/sources/src-my-source-abc123456789.md";
    const staged = stageForReview(vault, "ingest", target, () => "summary bytes");
    expect(staged.pendingId).toMatch(/^ing-\d{4}-\d{2}-\d{2}-src-my-source-abc123456789$/);
    expect(staged.path.startsWith(join(brainDirs(vault).pending, "ingest"))).toBe(true);
    expect(readFileSync(staged.path, "utf8")).toBe("summary bytes");
  });

  test("a non-lowercase .md target keeps its spelling through the queue", () => {
    // createNote admits a `.MD` spelling and writes it as given, so the
    // queue must apply into the caller's exact target - not fold it into
    // a different lowercase file on a case-sensitive vault.
    enableNotes();
    const bytes = formatFrontmatter({ title: "Case" }, "body");
    const staged = stageForReview(vault, "notes", "Notes/Foo.MD", () => bytes);
    const listed = listPendingLane(vault, "notes").entries[0]!;
    expect(listed.publishTarget).toBe("Notes/Foo.MD");
    const applied = applyPendingLane(vault, staged.pendingId);
    expect(applied.path).toBe(join(vault, "Notes/Foo.MD"));
    expect(readFileSync(applied.path, "utf8")).toBe(bytes);
  });

  test("compound markdown suffixes round-trip exactly too", () => {
    // A target whose remainder would be mistaken for a carried extension
    // rides whole: the id cannot drop a `.md` it could not re-attach
    // unambiguously.
    enableNotes();
    const staged = stageForReview(vault, "notes", "Notes/X.md.md", () => "twice");
    const listed = listPendingLane(vault, "notes").entries[0]!;
    expect(listed.publishTarget).toBe("Notes/X.md.md");
    const applied = applyPendingLane(vault, staged.pendingId);
    expect(applied.path).toBe(join(vault, "Notes/X.md.md"));
  });

  test("refuses the signals lane by name (the allocator owns that lane)", () => {
    enableNotes();
    expect(() => stageForReview(vault, "signals", "Brain/inbox/x.md", () => "y")).toThrow(
      /stagePendingSignal/,
    );
  });

  test("an over-long publish target refuses by name before anything is written", () => {
    enableNotes();
    const longTarget = `Notes/${"long".repeat(100)}.md`;
    expect(() => stageForReview(vault, "notes", longTarget, () => "bytes")).toThrow(
      PendingTargetPathError,
    );
    expect(existsSync(join(brainDirs(vault).pending, "notes"))).toBe(false);
  });
});

// ----- listing --------------------------------------------------------------

describe("listPendingLane", () => {
  test("lists all lanes sorted by id, with decoded publish targets", () => {
    enableNotes();
    enableIngest();
    stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "test-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
    });
    stageForReview(vault, "notes", "Notes/Zed.md", () => "zed bytes");
    stageForReview(vault, "ingest", "Brain/sources/src-a-bcdef1234567.md", () => "summary");

    const listing = listPendingLane(vault, "all");
    expect(listing.entries.map((e) => e.id)).toEqual(listing.entries.map((e) => e.id).toSorted());
    expect(listing.entries.map((e) => e.lane)).toEqual(["ingest", "notes", "signals"]);
    const noteEntry = listing.entries.find((e) => e.lane === "notes")!;
    expect(noteEntry.publishTarget).toBe("Notes/Zed.md");
    const ingestEntry = listing.entries.find((e) => e.lane === "ingest")!;
    expect(ingestEntry.publishTarget).toBe("Brain/sources/src-a-bcdef1234567.md");
    const signalEntry = listing.entries.find((e) => e.lane === "signals")!;
    expect(signalEntry.publishTarget).toBe(`Brain/inbox/${signalEntry.id}.md`);
    expect(signalEntry.signal?.principle).toBe("https://techmeat.dev");
  });

  test("filters by lane", () => {
    enableNotes();
    enableIngest();
    stageForReview(vault, "notes", "Notes/Only.md", () => "n");
    stageForReview(vault, "ingest", "Brain/sources/src-only-abcd12345678.md", () => "i");
    expect(listPendingLane(vault, "notes").entries.map((e) => e.lane)).toEqual(["notes"]);
    expect(listPendingLane(vault, "ingest").entries.map((e) => e.lane)).toEqual(["ingest"]);
    expect(listPendingLane(vault, "signals").entries).toEqual([]);
  });

  test("an empty queue lists nothing and names no unreadable entries", () => {
    const listing = listPendingLane(vault, "all");
    expect(listing.entries).toEqual([]);
    expect(listing.unreadable).toEqual([]);
  });

  test("corrupt and mis-named files are partitioned and named, not fatal", () => {
    enableNotes();
    stageForReview(vault, "notes", "Notes/Good.md", () => "good");
    // A signals file the signal reader refuses: parseSignal throws on a
    // missing required field, and the listing names it instead of dying.
    writeFileSync(
      join(brainDirs(vault).pending, "sig-2026-10-10-broken.md"),
      "no frontmatter here",
    );
    // A name the id grammar cannot carry is named the same way.
    writeFileSync(join(brainDirs(vault).pending, "notes", "stray-notes.md"), "stray");
    const listing = listPendingLane(vault, "all");
    expect(listing.entries.map((e) => e.publishTarget)).toContain("Notes/Good.md");
    const reasons = listing.unreadable.map((u) => u.path);
    expect(reasons.some((p) => p.endsWith("sig-2026-10-10-broken.md"))).toBe(true);
    expect(reasons.some((p) => p.endsWith("stray-notes.md"))).toBe(true);
    expect(listing.unreadable.every((u) => u.reason.length > 0)).toBe(true);
  });
});

// ----- apply ----------------------------------------------------------------

describe("applyPendingLane", () => {
  test("moves staged note bytes verbatim into the decoded target", () => {
    enableNotes();
    const bytes = formatFrontmatter({ title: "Round trip" }, "body");
    const staged = stageForReview(vault, "notes", "Notes/Round/Trip.md", () => bytes);
    const applied = applyPendingLane(vault, staged.pendingId);
    expect(applied.path).toBe(join(vault, "Notes/Round/Trip.md"));
    expect(readFileSync(applied.path, "utf8")).toBe(bytes);
    expect(existsSync(staged.path)).toBe(false);
  });

  test("moves a staged ingest page into Brain/sources verbatim", () => {
    enableIngest();
    const staged = stageForReview(
      vault,
      "ingest",
      "Brain/sources/src-x-abcdef123456.md",
      () => "page bytes",
    );
    const applied = applyPendingLane(vault, staged.pendingId);
    expect(applied.path).toBe(join(vault, "Brain/sources/src-x-abcdef123456.md"));
    expect(readFileSync(applied.path, "utf8")).toBe("page bytes");
  });

  test("an occupied target refuses with PendingApplyConflictError and keeps the staged copy", () => {
    enableNotes();
    const staged = stageForReview(vault, "notes", "Notes/Occupied.md", () => "staged");
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes/Occupied.md"), "published already");
    expect(() => applyPendingLane(vault, staged.pendingId)).toThrow(PendingApplyConflictError);
    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(join(vault, "Notes/Occupied.md"), "utf8")).toBe("published already");
  });

  test("a dry run reports the exact move and writes nothing", () => {
    enableNotes();
    const bytes = "dry-run bytes";
    const staged = stageForReview(vault, "notes", "Notes/Preview.md", () => bytes);
    const before = readFileSync(staged.path, "utf8");
    const preview = applyPendingLane(vault, staged.pendingId, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.path).toBe(join(vault, "Notes/Preview.md"));
    expect(existsSync(join(vault, "Notes/Preview.md"))).toBe(false);
    expect(readFileSync(staged.path, "utf8")).toBe(before);
  });

  test("a dry run refuses an occupied target exactly as the apply would", () => {
    enableNotes();
    const staged = stageForReview(vault, "notes", "Notes/Clash.md", () => "b");
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes/Clash.md"), "taken");
    expect(() => applyPendingLane(vault, staged.pendingId, { dryRun: true })).toThrow(
      PendingApplyConflictError,
    );
  });

  test("sig- ids keep applying into Brain/inbox unchanged", () => {
    const staged = stagePendingSignal(vault, {
      topic: "compat",
      signal: "positive",
      agent: "test-agent",
      principle: "compat principle",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "compat",
    });
    const applied = applyPendingLane(vault, staged.id);
    expect(applied.path.startsWith(brainDirs(vault).inbox)).toBe(true);
  });

  test("a missing id is a typed error; a malformed id is a different one", () => {
    expect(() => applyPendingLane(vault, "note-2026-10-10-notes%2Fmissing")).toThrow(
      PendingSignalNotFoundError,
    );
    expect(() => applyPendingLane(vault, "../escape")).toThrow(InvalidPendingIdError);
    expect(() => applyPendingLane(vault, "note-2026-10-10-%2Fleading-slash")).toThrow(
      InvalidPendingIdError,
    );
  });

  test("a decoded target that escapes the vault is refused", () => {
    enableNotes();
    // Compose the id by hand and stage bytes under it: the encoder cannot
    // produce a traversal, so this is the hand-edited-queue attack the
    // apply has to refuse even when the queue holds bytes for the id.
    const id = "note-2026-10-10-a%2F..%2F..%2Foutside";
    const notesDir = join(brainDirs(vault).pending, "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, `${id}.md`), "smuggled");
    expect(() => applyPendingLane(vault, id)).toThrow(PendingTargetPathError);
    expect(existsSync(join(notesDir, `${id}.md`))).toBe(true);
  });
});

// ----- reject ---------------------------------------------------------------

describe("rejectPendingLane", () => {
  test("renders a staged note into retired with the lane stamp", () => {
    enableNotes();
    const bytes = formatFrontmatter({ title: "Doomed", tags: ["brain/signal"] }, "body");
    const staged = stageForReview(vault, "notes", "Notes/Doomed.md", () => bytes);
    const rejected = rejectPendingLane(vault, staged.pendingId, "not useful", {
      now: new Date("2026-10-10T12:00:00Z"),
    });
    expect(existsSync(staged.path)).toBe(false);
    expect(rejected.path.startsWith(brainDirs(vault).retired)).toBe(true);
    const [meta] = parseFrontmatter(rejected.path);
    expect(meta["_status"]).toBe("retired");
    expect(meta["retired_reason"]).toBe("not useful");
    expect(meta["osb_pending_lane"]).toBe("notes");
    expect(meta["title"]).toBe("Doomed");
  });

  test("a reject dry run runs the checks and writes nothing", () => {
    enableNotes();
    const staged = stageForReview(vault, "notes", "Notes/Keep.md", () => "keep");
    const preview = rejectPendingLane(vault, staged.pendingId, "maybe", { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.path.startsWith(brainDirs(vault).retired)).toBe(true);
    expect(existsSync(staged.path)).toBe(true);
    expect(existsSync(join(brainDirs(vault).retired, `${staged.pendingId}.md`))).toBe(false);
  });

  test("a dry run refuses an occupied retire target exactly as the reject would", () => {
    // The real run's exclusive create throws FileAlreadyExistsError on a
    // taken retire path; the preview performs the same occupancy check, so
    // it cannot forecast a retire the reject would refuse.
    enableNotes();
    const staged = stageForReview(vault, "notes", "Notes/Taken.md", () => "b");
    const retired = join(brainDirs(vault).retired, `${staged.pendingId}.md`);
    writeFileSync(retired, "already retired");
    expect(() => rejectPendingLane(vault, staged.pendingId, "maybe", { dryRun: true })).toThrow(
      FileAlreadyExistsError,
    );
    expect(() => rejectPendingLane(vault, staged.pendingId, "maybe")).toThrow(
      FileAlreadyExistsError,
    );
    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(retired, "utf8")).toBe("already retired");
  });

  test("rejecting a missing id is a typed error", () => {
    expect(() => rejectPendingLane(vault, "note-2026-10-10-notes%2Fgone", "x")).toThrow(
      PendingSignalNotFoundError,
    );
  });

  test("a sig- id rejects into retired with the signals lane stamp", () => {
    const staged = stagePendingSignal(vault, {
      topic: "reject-compat",
      signal: "positive",
      agent: "test-agent",
      principle: "compat",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "reject-compat",
    });
    const rejected = rejectPendingLane(vault, staged.id, "nope");
    const [meta] = parseFrontmatter(rejected.path);
    expect(meta["osb_pending_lane"]).toBe("signals");
  });
});

// ----- lane directories -----------------------------------------------------

describe("lane directories", () => {
  test("the notes and ingest lanes stage into their own subdirectories", () => {
    enableNotes();
    enableIngest();
    stageForReview(vault, "notes", "Notes/Dir.md", () => "n");
    stageForReview(vault, "ingest", "Brain/sources/src-dir-abcdef123456.md", () => "i");
    expect(existsSync(join(brainDirs(vault).pending, "notes"))).toBe(true);
    expect(existsSync(join(brainDirs(vault).pending, "ingest"))).toBe(true);
    // The flat signals lane stays where the A3 queue put it.
    expect(existsSync(join(brainDirs(vault).pending, "notes", "note-2026-10-10-x.md"))).toBe(false);
  });

  test("mkdir of a lane directory happens only at stage time", () => {
    enableNotes();
    stageForReview(vault, "notes", "Notes/Late.md", () => "n");
    // No ingest directory appears behind a notes-only stage.
    expect(existsSync(join(brainDirs(vault).pending, "ingest"))).toBe(false);
  });
});

// ----- document-backed dispositions (write-side trust, Task 12) --------------

/**
 * When `Brain/_permissions.yaml` exists it is the ONLY gate: the lane
 * keys cannot bypass it, every verdict names the one rule that decided,
 * and a stage or refuse lands exactly one decision-ledger row whose
 * source names the entry, role or default. With no document the Task 9
 * arm is unchanged and the ledger stays empty.
 */
describe("resolveWriteDisposition under a permissions document", () => {
  const DOC_PATH = () => join(vault, "Brain", "_permissions.yaml");

  function writeDoc(text: string): void {
    writeFileSync(DOC_PATH(), text, "utf8");
  }

  function rowsFor(filter: { verdict?: string } = {}): ReturnType<typeof queryDecisionLedger> {
    return queryDecisionLedger(vault, filter);
  }

  test("a deny default refuses by name and records exactly one row naming the rule", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const subject = { agent: "claude", via: "config" as const };
    let refused: WriteRefusedError | undefined;
    try {
      resolveWriteDisposition(vault, "notes", subject, { target: "Notes/X.md" });
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("claude");
    expect(refused?.via).toBe("config");
    expect(refused?.action).toBe("write");
    expect(refused?.rule).toBe("default");
    expect(refused?.target).toBe("Notes/X.md");
    expect(refused?.nextCommand).toBe("o2b brain permissions show");
    const rows = rowsFor({ verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "claude",
      via: "config",
      action: "write",
      target: "Notes/X.md",
      verdict: "deny",
      source: "default",
    });
  });

  test("an ask default stages and records exactly one row naming the rule", () => {
    writeDoc("version: 1\ndefault_action: ask\n");
    const disposition = resolveWriteDisposition(vault, "notes", {
      agent: "claude",
      via: "config",
    });
    expect(disposition.verdict).toBe("stage");
    expect(disposition.source).toBe("default");
    const rows = rowsFor({ verdict: "ask" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "write", source: "default", verdict: "ask" });
  });

  test("an allow publishes with no row unless the document records allows", () => {
    writeDoc("version: 1\ndefault_action: allow\n");
    const subject = { agent: "claude", via: "config" as const };
    const quiet = resolveWriteDisposition(vault, "notes", subject, { target: "Notes/Quiet.md" });
    expect(quiet.verdict).toBe("publish");
    expect(quiet.source).toBe("default");
    expect(queryDecisionLedger(vault)).toHaveLength(0);
    writeDoc("version: 1\ndefault_action: allow\nledger:\n  record_allows: true\n");
    const loud = resolveWriteDisposition(vault, "notes", subject, { target: "Notes/Loud.md" });
    expect(loud.verdict).toBe("publish");
    const rows = queryDecisionLedger(vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: "Notes/Loud.md",
      verdict: "allow",
      source: "default",
    });
  });

  test("a target entry overrides the default and the row names the entry", () => {
    writeDoc(
      [
        "version: 1",
        "default_action: deny",
        "ledger:",
        "  record_allows: true",
        "entries:",
        "  - id: admit-zed",
        "    agent: claude",
        "    action: write",
        "    target: Notes/Zed.md",
        "    verdict: allow",
      ].join("\n") + "\n",
    );
    const subject = { agent: "claude", via: "config" as const };
    const admitted = resolveWriteDisposition(vault, "notes", subject, { target: "Notes/Zed.md" });
    expect(admitted.verdict).toBe("publish");
    expect(admitted.source).toBe("entry:admit-zed");
    // A different target stays under the default and refuses.
    let refused: WriteRefusedError | undefined;
    try {
      resolveWriteDisposition(vault, "notes", subject, { target: "Notes/Other.md" });
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused?.rule).toBe("default");
    // Both consults recorded exactly their own row: the allow names the
    // entry, the deny names the default.
    const allowRows = rowsFor({ verdict: "allow" });
    expect(allowRows).toHaveLength(1);
    expect(allowRows[0]!.source).toBe("entry:admit-zed");
    const denyRows = rowsFor({ verdict: "deny" });
    expect(denyRows).toHaveLength(1);
    expect(denyRows[0]!.source).toBe("default");
  });

  test("a role mapping decides and the row names the role", () => {
    writeDoc(
      [
        "version: 1",
        "default_action: deny",
        "roles:",
        "  reviewers:",
        "    write: ask",
        "agents:",
        "  claude:",
        "    role: reviewers",
      ].join("\n") + "\n",
    );
    const disposition = resolveWriteDisposition(vault, "notes", {
      agent: "claude",
      via: "config",
    });
    expect(disposition.verdict).toBe("stage");
    expect(disposition.source).toBe("role:reviewers");
    const rows = queryDecisionLedger(vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("role:reviewers");
  });

  test("a document cannot be bypassed by the lane keys in either direction", () => {
    // Lane key on, document allow: the document alone decides, so publish.
    enableNotes();
    writeDoc("version: 1\ndefault_action: allow\n");
    expect(
      resolveWriteDisposition(vault, "notes", { agent: "claude", via: "config" }).verdict,
    ).toBe("publish");
    // Lane key on, document ask: still stage, but the deciding source is
    // the document's rule, never the lane key.
    writeDoc("version: 1\ndefault_action: ask\n");
    const staged = resolveWriteDisposition(vault, "notes", { agent: "claude", via: "config" });
    expect(staged.verdict).toBe("stage");
    expect(staged.source).toBe("default");
  });

  test("an unreadable document fails closed instead of publishing", () => {
    writeDoc("version: 2\ndefault_action: allow\n");
    expect(() =>
      resolveWriteDisposition(vault, "notes", { agent: "claude", via: "config" }),
    ).toThrow(PermissionsDocumentError);
    expect(queryDecisionLedger(vault)).toHaveLength(0);
  });

  test("an absent document keeps the Task 9 arm and writes no rows", () => {
    enableNotes();
    const disposition = resolveWriteDisposition(vault, "notes", { agent: "claude", via: "config" });
    expect(disposition.verdict).toBe("stage");
    expect(disposition.source).toBe("OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED");
    expect(queryDecisionLedger(vault)).toHaveLength(0);
  });
});

/**
 * The no-subject fallback (write-side trust, Task 12): a caller that
 * carries no transport identity - the stdio and CLI surfaces - must be
 * consulted as the principal ITS config declares, the same one the owner
 * gate answers for, so a document rule naming that agent refuses a run
 * launched with an explicit configPath instead of fail-opening against
 * whatever the ambient discovery finds.
 */
describe("the no-subject fallback resolves the caller's configPath", () => {
  const DOC_PATH = () => join(vault, "Brain", "_permissions.yaml");

  function writeDoc(text: string): void {
    writeFileSync(DOC_PATH(), text, "utf8");
  }

  function writeAltConfig(): string {
    const altConfig = join(tmp, "alt-config.yaml");
    writeFileSync(altConfig, `vault: ${vault}\nagent_name: config-agent\n`);
    return altConfig;
  }

  test("refuseDocumentDeny consults the document as the configPath agent", () => {
    setEnv("VAULT_AGENT_NAME", undefined);
    const altConfig = writeAltConfig();
    writeDoc(
      [
        "version: 1",
        "default_action: allow",
        "entries:",
        "  - id: deny-config-agent",
        "    agent: config-agent",
        "    action: write",
        "    verdict: deny",
      ].join("\n") + "\n",
    );
    let refused: WriteRefusedError | undefined;
    try {
      refuseDocumentDeny(vault, "notes", undefined, {
        target: "Notes/X.md",
        configPath: altConfig,
      });
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("config-agent");
    expect(refused?.rule).toBe("entry:deny-config-agent");
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("config-agent");
  });

  test("resolveWriteDisposition's fallback consults through the configPath too", () => {
    setEnv("VAULT_AGENT_NAME", undefined);
    const altConfig = writeAltConfig();
    writeDoc("version: 1\ndefault_action: deny\n");
    let refused: WriteRefusedError | undefined;
    try {
      resolveWriteDisposition(vault, "notes", undefined, {
        target: "Notes/Y.md",
        configPath: altConfig,
      });
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("config-agent");
  });

  test("a write-batch update without a subject refuses naming the configPath agent", () => {
    setEnv("VAULT_AGENT_NAME", undefined);
    const altConfig = writeAltConfig();
    writeDoc(
      [
        "version: 1",
        "default_action: allow",
        "entries:",
        "  - id: deny-config-agent",
        "    agent: config-agent",
        "    action: write",
        "    verdict: deny",
      ].join("\n") + "\n",
    );
    // The deny-only consult rides ahead of the existing-note read, so the
    // refusal needs no target on disk.
    let refused: WriteRefusedError | undefined;
    try {
      applyWriteBatch(vault, [{ kind: "update_note", path: "Notes/Any.md", body: "rewritten" }], {
        configPath: altConfig,
      });
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("config-agent");
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("config-agent");
    expect(rows[0]!.target).toBe("Notes/Any.md");
  });
});

// ----- consumer refusals (write-side trust, Task 12) -------------------------

describe("createNote under a permissions document", () => {
  const DOC_PATH = () => join(vault, "Brain", "_permissions.yaml");

  test("a deny default refuses the create before any byte", () => {
    writeFileSync(DOC_PATH(), "version: 1\ndefault_action: deny\n", "utf8");
    expect(() => createNote(vault, { path: "Notes/Denied.md", content: "x" })).toThrow(
      WriteRefusedError,
    );
    expect(existsSync(join(vault, "Notes/Denied.md"))).toBe(false);
    expect(existsSync(join(vault, "Brain/pending/notes"))).toBe(false);
    // Exactly one row: the refusal, naming the default rule.
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("default");
  });

  test("an ask default stages the create and records exactly one row", () => {
    writeFileSync(DOC_PATH(), "version: 1\ndefault_action: ask\n", "utf8");
    const res = createNote(vault, { path: "Notes/Ask First.md", content: "reviewed bytes" });
    expect(res.outcome).toBe("staged");
    if (res.outcome !== "staged") throw new Error("unreachable");
    expect(existsSync(join(vault, "Notes/Ask First.md"))).toBe(false);
    const stagedBytes = readFileSync(res.pendingPath, "utf8");
    expect(stagedBytes).toContain("reviewed bytes");
    const rows = queryDecisionLedger(vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "write", verdict: "ask", source: "default" });
  });
});

describe("WRITE_APPROVAL_SOURCES", () => {
  test("names every write_approval link, keyed as the historical surface spelled it", () => {
    // Resolved through the queue's re-export on purpose: the disposition
    // layer moved to its own module and this historical import path is
    // the one that must keep resolving.
    expect(WRITE_APPROVAL_SOURCES.masterConfig).toBe("write_approval.enabled");
    expect(WRITE_APPROVAL_SOURCES.masterEnv).toBe("OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED");
    expect(WRITE_APPROVAL_SOURCES.notesConfig).toBe("write_approval.notes");
    expect(WRITE_APPROVAL_SOURCES.notesEnv).toBe("OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED");
    expect(WRITE_APPROVAL_SOURCES.ingestConfig).toBe("write_approval.ingest");
    expect(WRITE_APPROVAL_SOURCES.ingestEnv).toBe(
      "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED",
    );
  });
});

describe("disposition ledger rows that cannot land", () => {
  const DOC_PATH = () => join(vault, "Brain", "_permissions.yaml");

  test("a failed stage row is named on stderr, and the verdict still answers", () => {
    writeFileSync(DOC_PATH(), "version: 1\ndefault_action: ask\n", "utf8");
    freezeVault(vault, { agent: "@operator", reason: "audit drill" });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let disposition: ReturnType<typeof resolveWriteDisposition>;
    try {
      disposition = resolveWriteDisposition(vault, "notes", { agent: "claude", via: "config" });
    } finally {
      process.stderr.write = original;
    }
    // The row's loss never blocks the verdict it records.
    expect(disposition.verdict).toBe("stage");
    // The loss is named, never silent: the warning carries the append
    // failure and the target the row was aimed at.
    const combined = written.join("");
    expect(combined).toContain("decision-ledger append failed");
    expect(combined).toContain("warning:");
    // And the ledger genuinely holds nothing - the row did not land.
    expect(queryDecisionLedger(vault)).toEqual([]);
  });
});

describe("stageForReview one open entry per publish target", () => {
  test("a second staged entry for one target refuses, naming the open entry", () => {
    enableNotes();
    const first = stageForReview(vault, "notes", "Notes/Once.md", () => "first bytes");
    let conflict: PendingStageConflictError | undefined;
    try {
      stageForReview(vault, "notes", "Notes/Once.md", () => "second bytes");
    } catch (err) {
      conflict = err instanceof PendingStageConflictError ? err : undefined;
    }
    expect(conflict).toBeInstanceOf(PendingStageConflictError);
    expect(conflict?.existingId).toBe(first.pendingId);
    expect(conflict?.target).toBe("Notes/Once.md");
    // The refusal replaced nothing: the first proposal keeps its bytes and
    // the queue holds exactly one open entry for the target.
    expect(readFileSync(first.path, "utf8")).toBe("first bytes");
    expect(listPendingLane(vault, "notes").entries).toHaveLength(1);
  });

  test("the decoded comparison catches a later-day id for the same target", () => {
    enableNotes();
    // Hand-place a yesteryear entry whose decoded target is the one about
    // to be staged: two ids, one target, on different days.
    const olderId = "note-2026-01-01-Notes%2FOnce.md";
    const notesDir = join(brainDirs(vault).pending, "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, `${olderId}.md`), "older proposal");
    let conflict: PendingStageConflictError | undefined;
    try {
      stageForReview(vault, "notes", "Notes/Once.md", () => "today bytes");
    } catch (err) {
      conflict = err instanceof PendingStageConflictError ? err : undefined;
    }
    expect(conflict).toBeInstanceOf(PendingStageConflictError);
    expect(conflict?.existingId).toBe(olderId);
    expect(conflict?.target).toBe("Notes/Once.md");
    expect(readFileSync(join(notesDir, `${olderId}.md`), "utf8")).toBe("older proposal");
  });
});

describe("the review door's resolution rows", () => {
  function stageNote(rel: string, bytes: string) {
    enableNotes();
    return stageForReview(vault, "notes", rel, () => bytes);
  }

  test("a real apply appends one resolution row naming the decoded publish path", () => {
    const staged = stageNote("Notes/Rowed.md", "door bytes");
    applyPendingLane(vault, staged.pendingId);
    const rows = queryDecisionLedger(vault, { action: "resolution" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "operator",
      via: "operator",
      action: "resolution",
      target: "Notes/Rowed.md",
      verdict: "resolved",
      source: "review-door",
      reason: `pending "${staged.pendingId}" applied`,
    });
  });

  test("a real reject appends one row naming the path the bytes will never reach", () => {
    const staged = stageNote("Notes/Refused.md", "retired bytes");
    rejectPendingLane(vault, staged.pendingId, "not wanted", {
      now: new Date("2026-07-18T12:00:00Z"),
    });
    const rows = queryDecisionLedger(vault, { action: "resolution" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "operator",
      via: "operator",
      action: "resolution",
      target: "Notes/Refused.md",
      verdict: "rejected",
      source: "review-door",
      reason: `pending "${staged.pendingId}" rejected: not wanted`,
    });
  });

  test("a preview of either door moves writes no row", () => {
    const staged = stageNote("Notes/Previewed.md", "preview bytes");
    applyPendingLane(vault, staged.pendingId, { dryRun: true });
    rejectPendingLane(vault, staged.pendingId, "not yet", { dryRun: true });
    expect(queryDecisionLedger(vault)).toEqual([]);
  });

  test("a resolving credential names its agent in the row", () => {
    const staged = stageNote("Notes/Credited.md", "credited bytes");
    applyPendingLane(vault, staged.pendingId, { actor: "@resolver", via: "token" });
    const rows = queryDecisionLedger(vault, { action: "resolution" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "@resolver",
      via: "token",
      verdict: "resolved",
      source: "review-door",
    });
  });
});

describe("the write refusal's registered exit", () => {
  test("the registry entries and the refusal both name the leaf's one command", () => {
    // The exit lives in a leaf the diagnostics registry builds its entries
    // from, because resolving it through requireNextStep from the
    // disposition layer closes the diagnostics import cycle. This pin is
    // what keeps the leaf and the registry from drifting apart.
    expect(requireNextStep(WRITE_REFUSAL_CODES.documentDeny).nextCommand).toBe(
      WRITE_REFUSAL_NEXT_COMMAND,
    );
    expect(requireNextStep(WRITE_REFUSAL_CODES.forceConfirmedRequiresAllow).nextCommand).toBe(
      WRITE_REFUSAL_NEXT_COMMAND,
    );
    expect(WRITE_REFUSAL_NEXT_COMMAND).toBe("o2b brain permissions show");
  });
});
