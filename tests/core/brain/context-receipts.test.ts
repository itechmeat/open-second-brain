import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendContinuityRecord,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import type { ContinuityRecord } from "../../../src/core/brain/continuity/types.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import {
  CONTEXT_RECEIPT_TRIGGERS,
  emitContextReceipt,
  isContextReceiptTrigger,
  lookupReceiptReplyPresence,
  summarizeContextReceipt,
} from "../../../src/core/brain/context-receipts.ts";
import { reachView } from "../../../src/core/brain/reach-view.ts";
import { brainActivePath } from "../../../src/core/brain/paths.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-receipts-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("context receipts", () => {
  test("packContext can emit a redaction-safe receipt without changing selected items", () => {
    writePref("alpha", "alpha topic", "Keep answers short", "Body with token=secret-value");

    const pack = packContext(vault, {
      maxTokens: 10_000,
      receipt: {
        host: "unit-test",
        sessionId: "session-a",
        trigger: "context_pack",
        createdAt: "2026-05-31T12:00:00Z",
      },
    });

    expect(pack.items.map((item) => item.id)).toEqual(["pref-alpha"]);
    expect(pack.receiptId).toStartWith("ctn_");

    const receipts = listContinuityRecords(vault, { kind: "context_receipt" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toBe(pack.receiptId!);
    expect(receipts[0]!.sourceRefs).toEqual([
      expect.objectContaining({
        id: "pref-alpha",
        path: expect.stringContaining("pref-alpha.md"),
      }),
    ]);
    expect(receipts[0]!.payload).toEqual(
      expect.objectContaining({
        host: "unit-test",
        session_id: "session-a",
        trigger: "context_pack",
        item_count: 1,
        final_text_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(receipts)).not.toContain("secret-value");
  });

  test("buildPreCompressPack can emit a receipt for active head and preference items", () => {
    writeFileSync(brainActivePath(vault), "# Active\n\nUse project conventions.\n");
    writePref("bravo", "bravo topic", "Prefer concrete release notes", "Body");

    const pack = buildPreCompressPack(vault, {
      topK: 10,
      receipt: {
        host: "unit-test",
        sessionId: "session-b",
        trigger: "pre_compress",
        createdAt: "2026-05-31T12:05:00Z",
      },
    });

    expect(pack.receiptId).toStartWith("ctn_");
    const receipts = listContinuityRecords(vault, { kind: "context_receipt" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toEqual(
      expect.objectContaining({
        trigger: "pre_compress",
        active_head_included: true,
        item_count: 2,
      }),
    );
    expect(receipts[0]!.sourceRefs.map((source) => source.id)).toEqual([
      "__active__",
      "pref-bravo",
    ]);
  });

  test("rejects extra receipt fields that collide with core payload fields", () => {
    expect(() =>
      emitContextReceipt(vault, {
        options: {
          host: "unit-test",
          trigger: "context_pack",
          createdAt: "2026-05-31T12:10:00Z",
        },
        items: [],
        finalText: "",
        extra: { host: "override" },
      }),
    ).toThrow("context receipt extra key collides with payload field: host");
  });

  test("the trigger vocabulary names the SessionStart eager layer", () => {
    // Unit H: the eager layer emits receipts too, so a reader can tell a
    // hook injection from a pack build instead of seeing only pack builds.
    expect(isContextReceiptTrigger("session_inject")).toBe(true);
    expect(isContextReceiptTrigger("not_a_trigger")).toBe(false);
    expect([...CONTEXT_RECEIPT_TRIGGERS]).toEqual([
      "context_pack",
      "pre_compress",
      "session_inject",
    ]);
  });

  test("an item records its byte size beside its token estimate", () => {
    const record = emitContextReceipt(vault, {
      options: {
        host: "unit-test",
        trigger: "session_inject",
        createdAt: "2026-05-31T12:20:00Z",
      },
      items: [{ id: "active-body", bytes: 12, tokens: 3 }],
      finalText: "body",
    });
    const item = (record.payload["items"] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(item["bytes"]).toBe(12);
    expect(item["tokens"]).toBe(3);
  });
});

// ----- receipt reply-presence join (t_f8510c55) ---------------------------

describe("receipt reply-presence join", () => {
  test("a sibling record joins by exact session_id", () => {
    const receipt = emitReceipt("session-join");
    const presence = appendPresence("session-join", "2026-05-31T12:05:00.000Z", [
      {
        path: "Brain/preferences/pref-alpha.md",
        start_line: 3,
        end_line: 5,
        verdict: "verified",
      },
      { path: "Brain/preferences/pref-bravo.md", verdict: "absent" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    expect(join).toEqual({
      joined: true,
      presence: {
        record_id: presence.id,
        created_at: "2026-05-31T12:05:00.000Z",
        checked: 2,
        per_note: [
          {
            path: "Brain/preferences/pref-alpha.md",
            start_line: 3,
            end_line: 5,
            verdict: "verified",
          },
          { path: "Brain/preferences/pref-bravo.md", verdict: "absent" },
        ],
      },
    });
  });

  test("a note no span measured reads absent, never verified", () => {
    const receipt = emitReceipt("session-absent-note");
    appendPresence("session-absent-note", "2026-05-31T12:05:00.000Z", [
      {
        path: "Brain/preferences/pref-alpha.md",
        start_line: 1,
        end_line: 2,
        verdict: "not-in-note",
      },
      { path: "Brain/preferences/pref-bravo.md", verdict: "absent" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling record to join");
    expect(join.presence.per_note.map((note) => note.verdict)).toEqual(["not-in-note", "absent"]);
  });

  test("no key match reads unjoined, never an inferred window match", () => {
    const receipt = emitReceipt("session-lonely");
    // A presence record from ANOTHER session, recorded inside the same
    // minute: the join is keyed, so this record must not be pulled in.
    appendPresence("session-other", "2026-05-31T12:00:30.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    expect(join).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-lonely",
    });
  });

  test("a receipt with no session key reads unjoined, naming no session", () => {
    const receipt = emitReceipt(undefined);
    appendPresence(undefined, "2026-05-31T12:05:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    expect(join).toEqual({ joined: false, reason: "unjoined" });
    expect("session_id" in join).toBe(false);
  });

  test("the fold spans every sibling from the receipt onward, the newest readable record naming the join", () => {
    const receipt = emitReceipt("session-turns");
    appendPresence("session-turns", "2026-05-31T12:01:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);
    const later = appendPresence("session-turns", "2026-05-31T12:09:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "not-in-note" },
      { path: "Brain/preferences/pref-bravo.md", verdict: "verified" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling records to fold");
    // The join names the newest record the fold drew from, but the
    // verdicts are the FOLD's: alpha verified at 12:01 and missed at
    // 12:09 reads verified - a hit anywhere in the receipt's lifetime
    // wins over a later turn's miss.
    expect(join.presence.record_id).toBe(later.id);
    expect(join.presence.created_at).toBe("2026-05-31T12:09:00.000Z");
    expect(join.presence.checked).toBe(3);
    expect(join.presence.per_note).toEqual([
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
      { path: "Brain/preferences/pref-bravo.md", verdict: "verified" },
    ]);
  });

  test("a receipt folds the presence records written at or after it, verified winning across turns", () => {
    // The review's timeline: R1 (10:00, note a), P1 (10:01, a verified),
    // R2 (10:05, note b), P2 (10:06, a zero-span turn whose every note
    // reads absent), R3 (10:30, note c). The Stop hook writes a record on
    // every checked turn, including turns that quote nothing, so the
    // newest record is usually an all-absent one - a receipt must never
    // read that newer absence over its own lifetime's verification.
    const noteA = "Brain/notes/note-a.md";
    const noteB = "Brain/notes/note-b.md";
    const noteC = "Brain/notes/note-c.md";
    const r1 = emitReceiptAt("session-timeline", "2026-05-31T10:00:00.000Z", [noteA]);
    appendPresence("session-timeline", "2026-05-31T10:01:00.000Z", [
      { path: noteA, start_line: 2, end_line: 3, verdict: "verified" },
    ]);
    const r2 = emitReceiptAt("session-timeline", "2026-05-31T10:05:00.000Z", [noteB]);
    const p2 = appendPresence(
      "session-timeline",
      "2026-05-31T10:06:00.000Z",
      [
        { path: noteA, verdict: "absent" },
        { path: noteB, verdict: "absent" },
      ],
      0,
    );
    const r3 = emitReceiptAt("session-timeline", "2026-05-31T10:30:00.000Z", [noteC]);

    // R1 joins the fold from P1 onward: a's 10:01 verification survives
    // the later all-absent turn, and the join reports only the note R1
    // itself injected - never P2's row for b.
    const r1Join = lookupReceiptReplyPresence(vault, r1);
    if (!r1Join.joined) throw new Error("expected R1 to join the fold");
    expect(r1Join.presence.record_id).toBe(p2.id);
    expect(r1Join.presence.created_at).toBe("2026-05-31T10:06:00.000Z");
    expect(r1Join.presence.checked).toBe(1);
    expect(r1Join.presence.per_note).toEqual([
      { path: noteA, start_line: 2, end_line: 3, verdict: "verified" },
    ]);
    // Several answers fed the fold, so no single answer text hash binds
    // it: the member would claim a binding the fold cannot honor.
    expect("source_hash" in r1Join.presence).toBe(false);

    // R2 joins only what was written at or after it - P2 alone - so b
    // reads absent HONESTLY: that turn really quoted nothing. The record
    // R2's join names is P2, not the older P1.
    const r2Join = lookupReceiptReplyPresence(vault, r2);
    if (!r2Join.joined) throw new Error("expected R2 to join the fold");
    expect(r2Join.presence.record_id).toBe(p2.id);
    expect(r2Join.presence.checked).toBe(0);
    expect(r2Join.presence.per_note).toEqual([{ path: noteB, verdict: "absent" }]);

    // R3 was written after the last presence record: nothing answers it,
    // and the join says so instead of reaching back to a record that
    // predates R3's own injection.
    expect(lookupReceiptReplyPresence(vault, r3)).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-timeline",
    });
  });

  test("a receipt joins no presence record that predates it, however readable", () => {
    // A record written before the receipt describes turns the receipt's
    // injections did not exist for: joining it would answer the receipt
    // with checks it never benefited from.
    const receipt = emitReceiptAt("session-earlier", "2026-05-31T12:05:00.000Z", [
      "Brain/notes/note-a.md",
    ]);
    appendPresence("session-earlier", "2026-05-31T12:00:00.000Z", [
      { path: "Brain/notes/note-a.md", verdict: "verified" },
    ]);

    expect(lookupReceiptReplyPresence(vault, receipt)).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-earlier",
    });
  });

  test("a receipt whose only in-window records are unreadable reads unjoined, keyed", () => {
    // The walk-back stays per-record: an unreadable record is skipped,
    // never reported as the join - and a window holding nothing readable
    // is the named absence, not a reach-back before the receipt.
    const receipt = emitReceiptAt("session-late-corrupt", "2026-05-31T12:05:00.000Z", [
      "Brain/notes/note-a.md",
    ]);
    appendPresence("session-late-corrupt", "2026-05-31T12:00:00.000Z", [
      { path: "Brain/notes/note-a.md", verdict: "verified" },
    ]);
    appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-31T12:09:00.000Z",
      payload: {
        session_id: "session-late-corrupt",
        checked: 2,
        per_note: "not-an-array",
      },
    });

    expect(lookupReceiptReplyPresence(vault, receipt)).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-late-corrupt",
    });
  });

  test("per_note lists only the notes the receipt itself injected", () => {
    // The hook's record covers the session's whole ledger; the receipt's
    // join covers the receipt. A row for a note this receipt never
    // injected is not this receipt's history to report.
    const noteA = "Brain/notes/note-a.md";
    const noteB = "Brain/notes/note-b.md";
    const receipt = emitReceiptAt("session-scope", "2026-05-31T12:00:00.000Z", [noteA]);
    appendPresence("session-scope", "2026-05-31T12:01:00.000Z", [
      { path: noteA, verdict: "not-in-note" },
      { path: noteB, start_line: 1, end_line: 2, verdict: "not-in-note" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling record to join");
    expect(join.presence.per_note).toEqual([{ path: noteA, verdict: "not-in-note" }]);
    expect(join.presence.per_note.map((note) => note.path)).not.toContain(noteB);
  });

  test("a note missed in one turn and untouched in the next reads its strongest measured miss", () => {
    // Across the fold, `absent` neither upgrades nor downgrades a miss a
    // measured turn recorded: the note was checked once and missed, and
    // the untouched turn adds nothing to that finding.
    const noteA = "Brain/notes/note-a.md";
    const receipt = emitReceiptAt("session-miss-fold", "2026-05-31T12:00:00.000Z", [noteA]);
    appendPresence("session-miss-fold", "2026-05-31T12:01:00.000Z", [
      { path: noteA, start_line: 4, verdict: "not-in-note" },
    ]);
    const p2 = appendPresence(
      "session-miss-fold",
      "2026-05-31T12:06:00.000Z",
      [{ path: noteA, verdict: "absent" }],
      0,
    );

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling records to fold");
    expect(join.presence.record_id).toBe(p2.id);
    expect(join.presence.checked).toBe(1);
    expect(join.presence.per_note).toEqual([
      { path: noteA, start_line: 4, verdict: "not-in-note" },
    ]);
  });

  test("a fold over exactly one record carries that record's answer hash", () => {
    const receipt = emitReceipt("session-single-hash");
    const only = appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-31T12:05:00.000Z",
      payload: {
        session_id: "session-single-hash",
        checked: 1,
        per_note: [{ path: "Brain/preferences/pref-alpha.md", verdict: "not-in-note" }],
        source_hash: "b".repeat(64),
      },
    });

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling record to join");
    expect(join.presence.record_id).toBe(only.id);
    expect(join.presence.source_hash).toBe("b".repeat(64));
    expect(join.presence.per_note).toEqual([
      { path: "Brain/preferences/pref-alpha.md", verdict: "not-in-note" },
    ]);
  });

  test("a page reserved against remote reads drops its row below local reach, counted as withheld", () => {
    const receipt = emitReceipt("session-reserved");
    // The pages the Stop hook recorded, both injected by this receipt:
    // one public, one that reserves itself against remote reads with the
    // formal token.
    writePage("Brain/preferences/pref-alpha.md", "Public body.\n");
    writePage(
      "Brain/preferences/pref-bravo.md",
      "---\nvisibility: private\n---\n\nWithheld plan body.\n",
    );
    appendPresence("session-reserved", "2026-05-31T12:05:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
      {
        path: "Brain/preferences/pref-bravo.md",
        start_line: 3,
        end_line: 4,
        verdict: "verified",
      },
    ]);

    const below = lookupReceiptReplyPresence(
      vault,
      receipt,
      reachView(vault, TRANSPORT_REACH.remote),
    );
    if (!below.joined) throw new Error("expected the sibling record to join");
    expect(below.presence.per_note.map((note) => note.path)).toEqual([
      "Brain/preferences/pref-alpha.md",
    ]);
    // The drop is reported, never silent: the caller can tell a truncated
    // join from a session that checked one note.
    expect(below.presence.withheld).toBe(1);

    // Local reach keeps everything, and names no withholding.
    const local = lookupReceiptReplyPresence(
      vault,
      receipt,
      reachView(vault, TRANSPORT_REACH.local),
    );
    if (!local.joined) throw new Error("expected the sibling record to join");
    expect(local.presence.per_note.map((note) => note.path)).toEqual([
      "Brain/preferences/pref-alpha.md",
      "Brain/preferences/pref-bravo.md",
    ]);
    expect("withheld" in local.presence).toBe(false);
  });

  test("a row whose page cannot be read is withheld below local reach too, never shown", () => {
    // The fail-closed half of the same predicate: a path no file answers
    // (deleted or renamed since the hook recorded it) has an unknowable
    // visibility, and an unknowable claim is not the absence of one. The
    // unreadable path is one the receipt injected, so the withholding is
    // this join's to report.
    const receipt = emitReceipt("session-unmeasurable");
    writePage("Brain/preferences/pref-alpha.md", "Public body.\n");
    appendPresence("session-unmeasurable", "2026-05-31T12:05:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
      { path: "Brain/preferences/pref-bravo.md", verdict: "not-in-note" },
    ]);

    const below = lookupReceiptReplyPresence(
      vault,
      receipt,
      reachView(vault, TRANSPORT_REACH.remote),
    );
    if (!below.joined) throw new Error("expected the sibling record to join");
    expect(below.presence.per_note.map((note) => note.path)).toEqual([
      "Brain/preferences/pref-alpha.md",
    ]);
    expect(below.presence.withheld).toBe(1);
  });

  test("a corrupt latest sibling walks back to the latest readable one", () => {
    const receipt = emitReceipt("session-corrupt");
    appendPresence("session-corrupt", "2026-05-31T12:01:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);
    // A hand-edited or truncated line: the record exists and names the
    // session, but its payload carries no readable per-note list.
    appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-31T12:09:00.000Z",
      payload: {
        session_id: "session-corrupt",
        checked: 3,
        per_note: "not-an-array",
      },
    });

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the readable sibling to join");
    expect(join.presence.created_at).toBe("2026-05-31T12:01:00.000Z");
    expect(join.presence.per_note.map((note) => note.verdict)).toEqual(["verified"]);
  });

  test("a session whose every sibling is unreadable reads unjoined, keyed", () => {
    const receipt = emitReceipt("session-all-corrupt");
    appendContinuityRecord(vault, {
      kind: "reply_presence",
      createdAt: "2026-05-31T12:09:00.000Z",
      payload: {
        session_id: "session-all-corrupt",
        checked: 1,
        per_note: { broken: true },
      },
    });

    const join = lookupReceiptReplyPresence(vault, receipt);
    expect(join).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-all-corrupt",
    });
  });

  test("the summary carries the join only when one is handed to it", () => {
    const receipt = emitReceipt("session-summary");
    const join = lookupReceiptReplyPresence(vault, receipt);

    // No join computed (the list path): no member at all.
    expect("reply_presence" in summarizeContextReceipt(receipt)).toBe(false);
    // The unjoined outcome rides the summary verbatim (the show path's
    // honest absence - never silently dropped).
    const unjoined = summarizeContextReceipt(receipt, join);
    expect(unjoined.reply_presence).toEqual({
      joined: false,
      reason: "unjoined",
      session_id: "session-summary",
    });

    appendPresence("session-summary", "2026-05-31T12:05:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);
    const joined = summarizeContextReceipt(receipt, lookupReceiptReplyPresence(vault, receipt));
    if (!joined.reply_presence?.joined) throw new Error("expected the join to land");
    expect(joined.reply_presence.presence.per_note).toEqual([
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);
  });
});

function emitReceipt(sessionId: string | undefined): ContinuityRecord {
  return emitContextReceipt(vault, {
    options: {
      host: "unit-test",
      trigger: "session_inject",
      createdAt: "2026-05-31T12:00:00.000Z",
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    items: [
      { id: "pref-alpha", path: "Brain/preferences/pref-alpha.md" },
      { id: "pref-bravo", path: "Brain/preferences/pref-bravo.md" },
    ],
    finalText: "eager layer text",
  });
}

/** A receipt created at a chosen instant, injecting exactly the named notes. */
function emitReceiptAt(
  sessionId: string,
  createdAt: string,
  paths: ReadonlyArray<string>,
): ContinuityRecord {
  return emitContextReceipt(vault, {
    options: { host: "unit-test", trigger: "session_inject", createdAt, sessionId },
    items: paths.map((path) => ({ id: path, path })),
    finalText: "eager layer text",
  });
}

function appendPresence(
  sessionId: string | undefined,
  createdAt: string,
  perNote: ReadonlyArray<Record<string, unknown>>,
  checked: number = perNote.length,
): ContinuityRecord {
  return appendContinuityRecord(vault, {
    kind: "reply_presence",
    createdAt,
    payload: {
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      checked,
      per_note: perNote,
    },
  });
}

/** A plain vault page at a vault-relative path, frontmatter and all. */
function writePage(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function writePref(slug: string, topic: string, principle: string, body: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle,
    created_at: "2026-05-31T00:00:00Z",
    unconfirmed_until: "2026-06-07T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-31-${slug}]]`],
    confirmed_at: "2026-05-31T00:00:00Z",
    howToApply: body,
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.9,
  });
}
