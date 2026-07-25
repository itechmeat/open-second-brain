/**
 * Seam 1 - the typed degradation notice channel.
 *
 * Pins the two properties the seam exists for: the code vocabulary is
 * CLOSED (an unhandled member is a compile error at the consumer, which
 * the exhaustive switch below proves), and a notice renders to exactly
 * one English line that names the path when one is known.
 */

import { describe, expect, test } from "bun:test";

import {
  DEGRADATION_CODE,
  DegradationNoticeError,
  degradationNotice,
  emitDegradationNotice,
  formatDegradationNotice,
  type DegradationCode,
  type DegradationNotice,
} from "../../../src/core/integrity/degradation.ts";

const ALL_CODES = Object.values(DEGRADATION_CODE) as ReadonlyArray<DegradationCode>;

function assertNever(value: never): never {
  throw new Error(`unhandled degradation code: ${String(value)}`);
}

/**
 * The exhaustiveness proof. Every member is handled explicitly; the
 * `default` arm binds `code` to `never`, so adding a member to the union
 * without adding an arm here fails `bun run typecheck`.
 */
function owningUnit(code: DegradationCode): string {
  switch (code) {
    case DEGRADATION_CODE.frontmatterLineDropped:
      return "F";
    case DEGRADATION_CODE.frontmatterUnreadable:
      return "F";
    case DEGRADATION_CODE.vaultWalkEntrySkipped:
      return "F";
    case DEGRADATION_CODE.sessionLinkAbstained:
      return "C";
    case DEGRADATION_CODE.lineageObservationDropped:
      return "D";
    case DEGRADATION_CODE.lineageChainBroken:
      return "D";
    case DEGRADATION_CODE.vaultMarkerAbsent:
      return "J";
    case DEGRADATION_CODE.vaultMarkerMismatch:
      return "J";
    default:
      return assertNever(code);
  }
}

describe("DEGRADATION_CODE vocabulary", () => {
  test("is a non-empty closed set of unique kebab-case tokens", () => {
    expect(ALL_CODES.length).toBeGreaterThan(0);
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
    for (const code of ALL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  test("every member is handled by an exhaustive switch", () => {
    for (const code of ALL_CODES) {
      expect(owningUnit(code)).toBeTypeOf("string");
    }
  });

  test("the frozen table cannot be extended at runtime", () => {
    expect(Object.isFrozen(DEGRADATION_CODE)).toBe(true);
  });
});

describe("degradationNotice", () => {
  test("builds a frozen record carrying code, site and detail", () => {
    const notice = degradationNotice({
      code: DEGRADATION_CODE.frontmatterLineDropped,
      site: "parseFrontmatterText",
      detail: "line 3 is not a 'key: value' pair",
    });
    expect(notice.code).toBe(DEGRADATION_CODE.frontmatterLineDropped);
    expect(notice.site).toBe("parseFrontmatterText");
    expect(notice.detail).toBe("line 3 is not a 'key: value' pair");
    expect(Object.isFrozen(notice)).toBe(true);
  });

  test("omits the path key entirely when no path is known", () => {
    const notice = degradationNotice({
      code: DEGRADATION_CODE.sessionLinkAbstained,
      site: "resolveCrutchLink",
      detail: "two candidates inside the freshness window",
    });
    expect("path" in notice).toBe(false);
    expect(JSON.parse(JSON.stringify(notice))).toEqual({
      code: DEGRADATION_CODE.sessionLinkAbstained,
      site: "resolveCrutchLink",
      detail: "two candidates inside the freshness window",
    });
  });

  test("keeps the path when one is supplied", () => {
    const notice = degradationNotice({
      code: DEGRADATION_CODE.frontmatterUnreadable,
      site: "indexVault",
      detail: "EACCES",
      path: "Brain/preferences/pref-a.md",
    });
    expect(notice.path).toBe("Brain/preferences/pref-a.md");
  });

  test("rejects a blank site rather than emitting an unattributable notice", () => {
    expect(() =>
      degradationNotice({
        code: DEGRADATION_CODE.frontmatterLineDropped,
        site: "   ",
        detail: "something",
      }),
    ).toThrow(DegradationNoticeError);
  });

  test("rejects a blank detail rather than emitting an empty explanation", () => {
    expect(() =>
      degradationNotice({
        code: DEGRADATION_CODE.frontmatterLineDropped,
        site: "parseFrontmatterText",
        detail: "",
      }),
    ).toThrow(DegradationNoticeError);
  });

  test("rejects a present-but-blank path (omit the field instead)", () => {
    expect(() =>
      degradationNotice({
        code: DEGRADATION_CODE.frontmatterLineDropped,
        site: "parseFrontmatterText",
        detail: "something",
        path: "",
      }),
    ).toThrow(DegradationNoticeError);
  });
});

describe("formatDegradationNotice", () => {
  const base: DegradationNotice = degradationNotice({
    code: DEGRADATION_CODE.vaultMarkerMismatch,
    site: "assertBrainWriteTarget",
    detail: "recorded vault id does not match the resolved root",
  });

  test("renders a single line naming code, site and detail", () => {
    const line = formatDegradationNotice(base);
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain(DEGRADATION_CODE.vaultMarkerMismatch);
    expect(line).toContain("assertBrainWriteTarget");
    expect(line).toContain("recorded vault id does not match the resolved root");
  });

  test("includes the path when known and nothing path-shaped when not", () => {
    const withPath = degradationNotice({
      code: DEGRADATION_CODE.frontmatterUnreadable,
      site: "indexVault",
      detail: "EACCES",
      path: "Brain/log/2026-07-25.md",
    });
    expect(formatDegradationNotice(withPath)).toContain("Brain/log/2026-07-25.md");
    expect(formatDegradationNotice(base)).not.toContain("(");
  });

  test("collapses embedded newlines so the result is always one line", () => {
    const multiline = degradationNotice({
      code: DEGRADATION_CODE.lineageChainBroken,
      site: "verifyLineageLedger",
      detail: "sequence 7:\n  hash mismatch\r\n  recomputed locally",
      path: "Brain/.state/lineage.jsonl",
    });
    const line = formatDegradationNotice(multiline);
    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\r")).toBe(false);
    expect(line).toContain("sequence 7: hash mismatch recomputed locally");
  });

  test("passes the detail through verbatim - no vocabulary classification", () => {
    // A structural formatter must not inspect, translate, or match words:
    // arbitrary script survives to the rendered line unchanged.
    const detail = "поле _status отброшено";
    const notice = degradationNotice({
      code: DEGRADATION_CODE.frontmatterLineDropped,
      site: "parseFrontmatterText",
      detail,
    });
    expect(formatDegradationNotice(notice)).toContain(detail);
  });

  test("is deterministic for equal inputs", () => {
    expect(formatDegradationNotice(base)).toBe(formatDegradationNotice({ ...base }));
  });
});

describe("emitDegradationNotice", () => {
  test("appends to the sink in call order and returns the notice", () => {
    const sink: DegradationNotice[] = [];
    const first = emitDegradationNotice(sink, {
      code: DEGRADATION_CODE.vaultWalkEntrySkipped,
      site: "walk",
      detail: "ENOENT",
      path: "Archive",
    });
    emitDegradationNotice(sink, {
      code: DEGRADATION_CODE.lineageObservationDropped,
      site: "appendLineageObservation",
      detail: "writer lock held by another process",
    });
    expect(sink.length).toBe(2);
    expect(sink[0]).toBe(first);
    expect(sink[0]?.code).toBe(DEGRADATION_CODE.vaultWalkEntrySkipped);
    expect(sink[1]?.code).toBe(DEGRADATION_CODE.lineageObservationDropped);
  });

  test("propagates the construction error instead of pushing a blank notice", () => {
    const sink: DegradationNotice[] = [];
    expect(() =>
      emitDegradationNotice(sink, {
        code: DEGRADATION_CODE.vaultWalkEntrySkipped,
        site: "walk",
        detail: "  ",
      }),
    ).toThrow(DegradationNoticeError);
    expect(sink.length).toBe(0);
  });
});
