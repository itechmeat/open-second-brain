/**
 * Stream mappings build the same records the live dual writes build
 * (task 2.1): a staged signal is marked staged, a log row keeps its hash
 * chain inside the body, and an item of the wrong shape is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { DualWriteRecord } from "../../../src/core/store/dual-write.ts";

import {
  blobFileItem,
  laneEntryItem,
} from "../../../src/core/store-migration/lane-entry-records.ts";
import {
  LegacyItemShapeError,
  logEventRow,
  preferencePage,
  signalPage,
} from "../../../src/core/store-migration/row-records.ts";
import { makeLegacyVault, type LegacyVaultFixture } from "./fixtures/legacy-vault.ts";

let fx: LegacyVaultFixture;
beforeEach(() => {
  fx = makeLegacyVault("osb-row-records-");
});
afterEach(() => fx.cleanup());

/** The single record a converter returned: neither `null` nor an array. */
function one(result: DualWriteRecord | ReadonlyArray<DualWriteRecord> | null): DualWriteRecord {
  expect(result).not.toBeNull();
  expect(Array.isArray(result)).toBe(false);
  return result as DualWriteRecord;
}

/** The records a converter returned as an array. */
function many(
  result: DualWriteRecord | ReadonlyArray<DualWriteRecord> | null,
): ReadonlyArray<DualWriteRecord> {
  expect(Array.isArray(result)).toBe(true);
  return result as ReadonlyArray<DualWriteRecord>;
}

describe("migration row records", () => {
  test("a signal in the pending lane is a staged signal record", () => {
    const path = join(fx.vault, "Brain", "pending", "2026-11-02-staged.md");
    const record = one(
      signalPage(fx.vault, {
        shape: "page",
        path,
        frontmatter: { id: "sig-staged", topic: "x" },
        body: "",
      }),
    );
    expect(record.kind).toBe("signal");
    expect(record.body).toMatchObject({
      id: "sig-staged",
      path: "Brain/pending/2026-11-02-staged.md",
      staged: true,
      raw: null,
    });
  });

  test("a log row keeps its chain fields beside the payload", () => {
    const record = logEventRow(fx.vault, {
      shape: "line",
      path: join(fx.vault, "Brain", "log", "2026-11-01.dev-a.jsonl"),
      line: 1,
      device: "dev-a",
      row: {
        ts: "2026-11-01T10:00:00Z",
        kind: "note",
        payload: { text: "t" },
        prev: null,
        h: "ab",
      },
    });
    expect(record).toMatchObject({
      stream: "log",
      kind: "log-event",
      private: false,
      body: {
        timestamp: "2026-11-01T10:00:00Z",
        event_type: "note",
        body: { text: "t", prev: null, h: "ab" },
      },
    });
  });

  test("a row of the wrong shape is refused, to be reported as unparseable", () => {
    expect(() =>
      logEventRow(fx.vault, { shape: "line", path: "x.jsonl", line: 1, row: [1, 2], device: "" }),
    ).toThrow(LegacyItemShapeError);
    expect(() =>
      logEventRow(fx.vault, {
        shape: "line",
        path: "x.jsonl",
        line: 1,
        row: { ts: "t" },
        device: "",
      }),
    ).toThrow("missing the payload object");
  });

  test("a preference the CLI wrote seeds its own fields at human authority", () => {
    const path = fx.write(
      "Brain/preferences/pref-cli.md",
      "---\nid: pref-cli\nprinciple: Mine\norigin_channel: cli\nstatus: active\n---\n",
    );
    const records = many(
      preferencePage(fx.vault, {
        shape: "page",
        path,
        frontmatter: { id: "pref-cli", principle: "Mine", origin_channel: "cli", status: "active" },
        body: "",
      }),
    );
    expect(
      records.map((r) => [r.body["authority"], Object.keys(r.body["fields"] as object)]),
    ).toEqual([
      // The prose register (`text`) is the human's: a page with no prose seeds it empty.
      ["human", ["id", "principle", "origin_channel", "text"]],
      ["agent", ["status"]],
    ]);
  });

  test("a standing rule is a human lane entry", () => {
    const record = one(
      laneEntryItem(fx.vault, {
        shape: "entry",
        path: join(fx.vault, "Brain", "standing-rules.md"),
        lane: "standing-rule",
        entry: "standing-rules",
        fields: {},
        text: "Always answer in full sentences.",
      }),
    );
    expect(record).toMatchObject({
      kind: "lane-entry",
      private: false,
      body: { authority: "human", lane: "standing-rule", entry: "standing-rules" },
    });
  });

  test("a blob-surface page marked private only in its frontmatter is a private record", () => {
    const record = one(
      blobFileItem(fx.vault, {
        shape: "entry",
        path: join(fx.vault, "Brain", "write-images", "abc123.md"),
        lane: "write-image",
        entry: "abc123",
        fields: { visibility: "private" },
        text: "A note body with no private region.",
      }),
    );
    expect(record).toMatchObject({ kind: "lane-entry", private: true });
  });
});
