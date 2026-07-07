/**
 * C5 (t_a82b674e): caller-settable per-memory expiration on signals.
 *
 * A caller can stamp an explicit `expiration_date` on a signal at write
 * time. The default read/list path silently drops signals past their
 * date; an opt-in `showExpired` flag re-includes them for audit. An
 * expired-by-date signal is FILTERED on read, never deleted or moved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSignal, writeSignal, type WriteSignalInput } from "../../../src/core/brain/signal.ts";
import { queryByTopic } from "../../../src/core/brain/query.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sig-expiry-"));
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function baseSignal(slug: string, overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: "deploy",
    signal: "positive",
    agent: "tester",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
    ...overrides,
  };
}

describe("writeSignal — expiration_date frontmatter", () => {
  test("stamps expiration_date into the frontmatter when supplied", () => {
    const res = writeSignal(vault, baseSignal("with-expiry", { expiration_date: "2026-07-15" }));
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain("expiration_date: 2026-07-15");
  });

  test("does NOT emit expiration_date when the caller omits it (byte-identical)", () => {
    const res = writeSignal(vault, baseSignal("no-expiry"));
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain("expiration_date");
  });

  test("parseSignal reads the expiration_date back", () => {
    const res = writeSignal(vault, baseSignal("roundtrip", { expiration_date: "2026-07-15" }));
    const parsed = parseSignal(res.path);
    expect(parsed.expiration_date).toBe("2026-07-15");
  });

  test("rejects an unparseable expiration_date on write", () => {
    expect(() => writeSignal(vault, baseSignal("bad", { expiration_date: "whenever" }))).toThrow();
  });
});

describe("queryByTopic — default drops expired signals, showExpired re-includes", () => {
  const now = new Date("2026-08-01T00:00:00Z");

  function seed(): void {
    writeSignal(vault, baseSignal("live-sig", { expiration_date: "2026-12-31" }));
    writeSignal(vault, baseSignal("expired-sig", { expiration_date: "2026-07-15" }));
    writeSignal(vault, baseSignal("no-expiry-sig"));
  }

  test("default query drops signals past their expiration_date", () => {
    seed();
    const res = queryByTopic(vault, "deploy", { now });
    const principles = res.signals.map((s) => s.principle).sort();
    // The expired one is dropped; the live one and the never-expiring one stay.
    expect(principles).toEqual(["Principle for live-sig", "Principle for no-expiry-sig"]);
  });

  test("showExpired: true re-includes the expired signal (audit path)", () => {
    seed();
    const res = queryByTopic(vault, "deploy", { now, showExpired: true });
    expect(res.signals.length).toBe(3);
  });

  test("an expired signal is FILTERED, not deleted from the inbox", () => {
    const res = writeSignal(vault, baseSignal("expired-sig", { expiration_date: "2026-07-15" }));
    queryByTopic(vault, "deploy", { now });
    expect(existsSync(res.path)).toBe(true);
  });
});
