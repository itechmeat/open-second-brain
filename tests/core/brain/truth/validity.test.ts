/**
 * Ledger validity windows (truth-correctable-time-aware, contract item 1):
 * window parsing shares the `src/core/search/validity.ts` grammar with one
 * ledger-specific difference (bare dates resolve to their day start on
 * BOTH edges, so the until bound is exclusive - half-open; datetimes
 * parse; relative phrases are rejected), `claimWindow` is null exactly
 * for windowless events, and `windowsIntersect` is the half-open rule
 * with null as plus/minus infinity. The ingest-default cases pin the
 * frozen-at-ingest resolution: explicit input wins outright, a readable
 * source record's frontmatter window fills the missing bounds, an
 * unreadable or windowless source stores a windowless event
 * byte-identical to today's output, and mtime is never a window source.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimWindow,
  isValidityPoint,
  resolveIngestWindow,
  windowsIntersect,
} from "../../../../src/core/brain/truth/validity.ts";
import type { ClaimEvent } from "../../../../src/core/brain/truth/types.ts";
import { appendClaimEvent } from "../../../../src/core/brain/truth/store.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";

function claim(over: Partial<ClaimEvent> = {}): ClaimEvent {
  return {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "alice mason",
    aspect: "employer",
    value: "Google",
    valueKind: "text",
    source: "[[Brain/notes/standup.md]]",
    ...over,
  };
}

describe("claimWindow", () => {
  test("a windowless event has no window", () => {
    expect(claimWindow(claim())).toBeNull();
  });

  test("a bare-date from day-snaps to the day start", () => {
    const window = claimWindow(claim({ validFrom: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBe(Date.UTC(2026, 0, 1));
    expect(window!.untilMs).toBeNull();
  });

  test("a bare-date until resolves to that day's start, exclusive", () => {
    // Half-open [from, until): a bare-date until is the exclusive day
    // start, never a cover of its own day, so adjacent bare-date windows
    // (`until: 2026-01-01`, then `from: 2026-01-01`) stay disjoint.
    const window = claimWindow(claim({ validUntil: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBeNull();
    expect(window!.untilMs).toBe(Date.UTC(2026, 0, 1));
  });

  test("adjacent bare-date windows do not intersect", () => {
    const a = claimWindow(claim({ validFrom: "2025-12-01", validUntil: "2026-01-01" }));
    const b = claimWindow(claim({ validFrom: "2026-01-01", validUntil: "2026-02-01" }));
    expect(windowsIntersect(a!, b!)).toBe(false);
  });

  test("canonical UTC datetimes parse exactly", () => {
    const window = claimWindow(
      claim({ validFrom: "2026-01-01T00:00:00Z", validUntil: "2026-06-30T12:00:00Z" }),
    );
    expect(window!.fromMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(window!.untilMs).toBe(Date.parse("2026-06-30T12:00:00Z"));
  });

  test("a datetime without an offset reads as UTC", () => {
    const window = claimWindow(claim({ validFrom: "2026-01-01T10:30:00" }));
    expect(window!.fromMs).toBe(Date.parse("2026-01-01T10:30:00Z"));
  });

  test("relative phrases never parse", () => {
    expect(claimWindow(claim({ validFrom: "yesterday" }))!.fromMs).toBeNull();
    expect(claimWindow(claim({ validUntil: "last week" }))!.untilMs).toBeNull();
    expect(claimWindow(claim({ validFrom: "3 days ago" }))!.fromMs).toBeNull();
  });

  test("an impossible calendar date never parses", () => {
    expect(claimWindow(claim({ validFrom: "2026-02-30" }))!.fromMs).toBeNull();
  });

  test("an unparseable present bound reads as unbounded on that side", () => {
    // The write boundary (appendClaimEvent / coerceClaim) rejects these
    // with a named error, so this branch is defensive tolerance for
    // hand-built events only.
    const window = claimWindow(claim({ validFrom: "not a date", validUntil: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBeNull();
  });
});

describe("windowsIntersect", () => {
  test("overlapping half-open windows intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 15, untilMs: 25 })).toBe(true);
  });

  test("touching half-open windows do not intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 20, untilMs: 30 })).toBe(false);
    expect(windowsIntersect({ fromMs: 20, untilMs: 30 }, { fromMs: 10, untilMs: 20 })).toBe(false);
  });

  test("disjoint windows do not intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 40, untilMs: 50 })).toBe(false);
  });

  test("a missing bound is minus infinity on the from side", () => {
    expect(windowsIntersect({ fromMs: null, untilMs: 20 }, { fromMs: 10, untilMs: 30 })).toBe(true);
    expect(windowsIntersect({ fromMs: null, untilMs: 5 }, { fromMs: 10, untilMs: 30 })).toBe(false);
  });

  test("a missing bound is plus infinity on the until side", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 20, untilMs: 30 })).toBe(true);
    // [40, 50) starts after [10, infinity) begins and ends never, so the
    // non-intersecting counterpart must end before the from side opens.
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 40, untilMs: 50 })).toBe(true);
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: null, untilMs: 5 })).toBe(
      false,
    );
  });

  test("two fully open windows intersect", () => {
    expect(windowsIntersect({ fromMs: null, untilMs: null }, { fromMs: 0, untilMs: 1 })).toBe(true);
    expect(windowsIntersect({ fromMs: null, untilMs: null }, { fromMs: null, untilMs: null })).toBe(
      true,
    );
  });

  test("a later-opening unbounded window still intersects an earlier unbounded one", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 20, untilMs: null })).toBe(
      true,
    );
  });
});

describe("isValidityPoint", () => {
  test("accepts bare ISO dates and canonical UTC timestamps", () => {
    expect(isValidityPoint("2026-01-01")).toBe(true);
    expect(isValidityPoint("2026-01-01T10:00:00Z")).toBe(true);
    expect(isValidityPoint("2026-01-01T10:00:00.500Z")).toBe(true);
  });

  test("rejects relative phrases, offsets, and garbage", () => {
    expect(isValidityPoint("yesterday")).toBe(false);
    expect(isValidityPoint("last week")).toBe(false);
    expect(isValidityPoint("2026-01-01T10:00:00+02:00")).toBe(false);
    expect(isValidityPoint("")).toBe(false);
    expect(isValidityPoint("  ")).toBe(false);
    expect(isValidityPoint("not a date")).toBe(false);
    expect(isValidityPoint("2026-02-30")).toBe(false);
  });
});

describe("resolveIngestWindow", () => {
  test("explicit input wins outright - a readable source cannot leak in", () => {
    const resolved = resolveIngestWindow(
      { validFrom: "2026-02-01", validUntil: "2026-03-01" },
      { validFrom: "2026-01-01", validUntil: "2026-06-30" },
    );
    expect(resolved.validFrom).toBe("2026-02-01");
    expect(resolved.validUntil).toBe("2026-03-01");
  });

  test("absent input adopts the source record's frontmatter window verbatim", () => {
    const resolved = resolveIngestWindow(
      {},
      { validFrom: "2026-01-01", validUntil: "2026-06-30T23:59:59Z" },
    );
    expect(resolved.validFrom).toBe("2026-01-01");
    expect(resolved.validUntil).toBe("2026-06-30T23:59:59Z");
  });

  test("resolution is per bound: an explicit from pairs with a source until", () => {
    const resolved = resolveIngestWindow(
      { validFrom: "2026-02-01" },
      { validFrom: "2026-01-01", validUntil: "2026-06-30" },
    );
    expect(resolved.validFrom).toBe("2026-02-01");
    expect(resolved.validUntil).toBe("2026-06-30");
  });

  test("an unreadable source (null) resolves only the explicit bounds", () => {
    const resolved = resolveIngestWindow({ validFrom: "2026-02-01" }, null);
    expect(resolved.validFrom).toBe("2026-02-01");
    expect(resolved.validUntil).toBeUndefined();
    expect(resolveIngestWindow({}, null)).toEqual({});
  });

  test("an unparseable source bound is treated as absent", () => {
    // A malformed source window must never refuse an otherwise-valid
    // ingest nor leak garbage into the ledger.
    const resolved = resolveIngestWindow(
      {},
      { validFrom: "yesterday", validUntil: "also not a date" },
    );
    expect(resolved).toEqual({});
  });

  test("empty source bounds are absent", () => {
    const resolved = resolveIngestWindow({}, { validFrom: "  ", validUntil: "" });
    expect(resolved).toEqual({});
  });

  test("mtime-shaped source metadata is never a window source", () => {
    // Only the two named frontmatter keys participate; any other
    // record metadata (recorded_at, an mtime proxy) is ignored.
    const resolved = resolveIngestWindow({}, {
      recordedAt: "2026-05-01",
      validUntil: "2026-06-30",
    } as Record<string, string>);
    expect(resolved.validFrom).toBeUndefined();
    expect(resolved.validUntil).toBe("2026-06-30");
  });
});

describe("ingest window defaults (appendClaimEvent)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "osb-truth-window-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  function writeSource(rel: string, frontmatter: string): void {
    const path = join(vault, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `---\n${frontmatter}---\nbody\n`);
  }

  function firstLine(): string {
    const shard = withDeviceId("", () => appendClaimEvent(vault, STANDUP_CLAIM)).path;
    return readFileSync(shard, "utf8").trim();
  }

  const STANDUP_CLAIM = {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
  } as const;

  test("a readable source's frontmatter window is stored frozen on the event", () => {
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\nvalid_until: 2026-06-30\n");
    const line = firstLine();
    const row = JSON.parse(line) as Record<string, unknown>;
    expect(row["validFrom"]).toBe("2026-01-01");
    expect(row["validUntil"]).toBe("2026-06-30");
  });

  test("an extensionless wikilink source resolves through the .md variant", () => {
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\n");
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, { ...STANDUP_CLAIM, source: "[[Brain/notes/standup]]" }),
    );
    expect(written.event.validFrom).toBe("2026-01-01");
    expect(written.event.validUntil).toBeUndefined();
  });

  test("a directory at the bare spelling never shadows its .md twin", () => {
    // The bare candidate must be a regular file to name a page: a
    // directory where the extensionless spelling lands is not the
    // record, and accepting it used to shadow the .md twin beside it -
    // the same regular-file rule the artifact-ref view's isVaultFile
    // applies to the read side.
    mkdirSync(join(vault, "Brain", "notes", "standup"), { recursive: true });
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\n");
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, { ...STANDUP_CLAIM, source: "[[Brain/notes/standup]]" }),
    );
    expect(written.event.validFrom).toBe("2026-01-01");
    expect(written.event.validUntil).toBeUndefined();
  });

  test("an explicit window wins outright over the source record's window", () => {
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\nvalid_until: 2026-06-30\n");
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, { ...STANDUP_CLAIM, validFrom: "2026-02-01" }),
    );
    expect(written.event.validFrom).toBe("2026-02-01");
    // Explicit from + no explicit until: the source's until still fills
    // the open side (per-bound resolution).
    expect(written.event.validUntil).toBe("2026-06-30");
  });

  test("an unreadable source stores a windowless event byte-identical to today's output", () => {
    const line = firstLine();
    expect(line).toBe(
      '{"v":1,"ts":"2026-06-01T10:00:00Z","agent":"claude-dev-agent","entity":"alice mason","aspect":"employer","value":"Google","valueKind":"text","source":"[[Brain/notes/standup.md]]"}',
    );
  });

  test("a windowless source stores a windowless event byte-identical to today's output", () => {
    writeSource("Brain/notes/standup.md", "status: active\n");
    expect(firstLine()).toBe(
      '{"v":1,"ts":"2026-06-01T10:00:00Z","agent":"claude-dev-agent","entity":"alice mason","aspect":"employer","value":"Google","valueKind":"text","source":"[[Brain/notes/standup.md]]"}',
    );
  });

  test("a source file mtime alone never produces a window", () => {
    // The source exists and is readable but carries no validity
    // frontmatter; its filesystem mtime is an assertion-time proxy and
    // must not become validity.
    writeSource("Brain/notes/standup.md", "recorded_at: 2026-05-01\n");
    expect(firstLine()).not.toContain("validFrom");
    expect(firstLine()).not.toContain("validUntil");
  });

  test("a source traversal escape is treated as an unreadable source", () => {
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, { ...STANDUP_CLAIM, source: "../../outside-vault" }),
    );
    expect(written.event.validFrom).toBeUndefined();
    expect(written.event.validUntil).toBeUndefined();
  });

  test("a source the reach gate withholds stores a windowless event byte-identical to today's output", () => {
    // The MCP tools pass the caller's readable predicate; a source page
    // it withholds must resolve no window, exactly like an absent one -
    // the frozen event and the response shape carry no signal
    // distinguishing withheld from absent.
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\nvalid_until: 2026-06-30\n");
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, STANDUP_CLAIM, { readableSource: () => false }),
    );
    expect(readFileSync(written.path, "utf8").trim()).toBe(
      '{"v":1,"ts":"2026-06-01T10:00:00Z","agent":"claude-dev-agent","entity":"alice mason","aspect":"employer","value":"Google","valueKind":"text","source":"[[Brain/notes/standup.md]]"}',
    );
  });

  test("a source the reach gate admits still resolves its frontmatter window", () => {
    writeSource("Brain/notes/standup.md", "valid_from: 2026-01-01\n");
    const written = withDeviceId("", () =>
      appendClaimEvent(vault, STANDUP_CLAIM, {
        readableSource: (rel) => rel === "Brain/notes/standup.md",
      }),
    );
    expect(written.event.validFrom).toBe("2026-01-01");
    expect(written.event.validUntil).toBeUndefined();
  });
});
