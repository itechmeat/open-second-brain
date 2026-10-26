import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { brainActivePath } from "../../../src/core/brain/paths.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

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

  test("the latest sibling record joins when several exist for the session", () => {
    const receipt = emitReceipt("session-turns");
    const earlier = appendPresence("session-turns", "2026-05-31T12:01:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "verified" },
    ]);
    const later = appendPresence("session-turns", "2026-05-31T12:09:00.000Z", [
      { path: "Brain/preferences/pref-alpha.md", verdict: "not-in-note" },
      { path: "Brain/preferences/pref-bravo.md", verdict: "verified" },
    ]);

    const join = lookupReceiptReplyPresence(vault, receipt);
    if (!join.joined) throw new Error("expected the sibling record to join");
    expect(join.presence.record_id).toBe(later.id);
    expect(join.presence.record_id).not.toBe(earlier.id);
    expect(join.presence.created_at).toBe("2026-05-31T12:09:00.000Z");
    expect(join.presence.checked).toBe(2);
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

function appendPresence(
  sessionId: string | undefined,
  createdAt: string,
  perNote: ReadonlyArray<Record<string, unknown>>,
): ContinuityRecord {
  return appendContinuityRecord(vault, {
    kind: "reply_presence",
    createdAt,
    payload: {
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      checked: perNote.length,
      per_note: perNote,
    },
  });
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
