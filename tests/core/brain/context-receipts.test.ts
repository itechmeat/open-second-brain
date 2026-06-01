import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { emitContextReceipt } from "../../../src/core/brain/context-receipts.ts";
import { brainActivePath } from "../../../src/core/brain/paths.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
} from "../../../src/core/brain/types.ts";

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
    writePref(
      "alpha",
      "alpha topic",
      "Keep answers short",
      "Body with token=secret-value",
    );

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
    writeFileSync(
      brainActivePath(vault),
      "# Active\n\nUse project conventions.\n",
    );
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
});

function writePref(
  slug: string,
  topic: string,
  principle: string,
  body: string,
): void {
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
