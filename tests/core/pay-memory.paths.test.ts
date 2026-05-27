import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  assetPath,
  isoDateNow,
  isoTimeNow,
  isoTimestampZ,
  PAY_MEMORY_ASSETS_REL,
  PAY_MEMORY_DRAFTS_REL,
  PAY_MEMORY_POLICIES_REL,
  PAY_MEMORY_REPORTS_REL,
  PAY_MEMORY_ROOT_REL,
  PAY_MEMORY_SPENDING_MD_REL,
  payMemoryDirs,
  paymentsDateDir,
  policyPath,
  receiptPath,
  reportPath,
  validateIsoDate,
  validateIsoTime,
  validateSlug,
} from "../../src/core/pay-memory/paths.ts";

describe("payMemoryDirs", () => {
  test("composes the canonical Brain/payments layout", () => {
    const dirs = payMemoryDirs("/vault");
    expect(dirs.policies).toBe(join("/vault", PAY_MEMORY_POLICIES_REL));
    expect(dirs.payments).toBe(join("/vault", PAY_MEMORY_ROOT_REL));
    expect(dirs.assets).toBe(join("/vault", PAY_MEMORY_ASSETS_REL));
    expect(dirs.drafts).toBe(join("/vault", PAY_MEMORY_DRAFTS_REL));
    expect(dirs.reports).toBe(join("/vault", PAY_MEMORY_REPORTS_REL));
  });

  test("policyPath, receiptPath, assetPath, reportPath", () => {
    expect(policyPath("/v")).toBe(join("/v", PAY_MEMORY_SPENDING_MD_REL));
    expect(receiptPath("/v", "2026-05-10", "fal-x")).toBe(
      join("/v", PAY_MEMORY_ROOT_REL, "2026-05-10", "fal-x.md"),
    );
    expect(assetPath("/v", "header")).toBe(join("/v", PAY_MEMORY_ASSETS_REL, "header.md"));
    expect(reportPath("/v", "demo")).toBe(join("/v", PAY_MEMORY_REPORTS_REL, "demo.md"));
  });

  test("paymentsDateDir validates date", () => {
    expect(paymentsDateDir("/v", "2026-05-10")).toBe(join("/v", PAY_MEMORY_ROOT_REL, "2026-05-10"));
    expect(() => paymentsDateDir("/v", "2026.05.10")).toThrow();
    expect(() => paymentsDateDir("/v", "10-05-2026")).toThrow();
  });
});

describe("validateIsoDate", () => {
  test("accepts well-formed ISO dates", () => {
    expect(validateIsoDate("2026-05-10")).toBe("2026-05-10");
    expect(validateIsoDate("2024-02-29")).toBe("2024-02-29"); // leap year
  });

  test("rejects bad shapes and impossible calendar dates", () => {
    expect(() => validateIsoDate("2026/05/10")).toThrow();
    expect(() => validateIsoDate("2026-13-01")).toThrow();
    expect(() => validateIsoDate("2026-02-30")).toThrow();
    expect(() => validateIsoDate("2025-02-29")).toThrow(); // non-leap
    expect(() => validateIsoDate("")).toThrow();
  });

  test("differentiates format vs calendar errors", () => {
    expect(() => validateIsoDate("nope")).toThrow(/format/);
    expect(() => validateIsoDate("2026-13-01")).toThrow(/valid calendar date/);
    expect(() => validateIsoDate("2025-02-29")).toThrow(/valid calendar date/);
  });
});

describe("validateIsoTime", () => {
  test("accepts 24-hour HH:MM", () => {
    expect(validateIsoTime("00:00")).toBe("00:00");
    expect(validateIsoTime("23:59")).toBe("23:59");
  });

  test("rejects out-of-range or malformed", () => {
    expect(() => validateIsoTime("24:00")).toThrow();
    expect(() => validateIsoTime("12:60")).toThrow();
    expect(() => validateIsoTime("9:30")).toThrow();
  });

  test("differentiates format vs range errors", () => {
    expect(() => validateIsoTime("nope")).toThrow(/format/);
    expect(() => validateIsoTime("24:00")).toThrow(/out of range/);
    expect(() => validateIsoTime("12:60")).toThrow(/out of range/);
  });
});

describe("validateSlug", () => {
  test("accepts plain slugs", () => {
    expect(validateSlug("fal-blog-header")).toBe("fal-blog-header");
    expect(validateSlug("alpha_beta-2")).toBe("alpha_beta-2");
  });

  test("rejects path separators", () => {
    expect(() => validateSlug("a/b")).toThrow(/path separators/);
    expect(() => validateSlug("a\\b")).toThrow(/path separators/);
  });

  test("rejects traversal", () => {
    expect(() => validateSlug("..")).toThrow(/traversal/);
    expect(() => validateSlug("..-evil")).toThrow(/traversal/);
    expect(() => validateSlug("evil-..")).toThrow(/traversal/);
  });

  test("rejects empty", () => {
    expect(() => validateSlug("")).toThrow();
    expect(() => validateSlug("   ")).toThrow();
  });

  test("trims whitespace", () => {
    expect(validateSlug("  ok-slug  ")).toBe("ok-slug");
  });
});

describe("receiptPath / assetPath / reportPath reject traversal slugs", () => {
  test("receiptPath rejects '../escape'", () => {
    expect(() => receiptPath("/v", "2026-05-10", "../escape")).toThrow();
  });
  test("assetPath rejects 'a/b'", () => {
    expect(() => assetPath("/v", "a/b")).toThrow();
  });
  test("reportPath rejects '..'", () => {
    expect(() => reportPath("/v", "..")).toThrow();
  });
});

describe("isoDateNow / isoTimeNow", () => {
  test("returns YYYY-MM-DD and HH:MM shapes", () => {
    expect(isoDateNow()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoTimeNow()).toMatch(/^\d{2}:\d{2}$/);
    // With an explicit timezone the shape is preserved.
    expect(isoDateNow("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoTimeNow("UTC")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("isoTimestampZ", () => {
  test("composes ISO Z timestamp from date+time (no tz = treat as UTC)", () => {
    expect(isoTimestampZ("2026-05-10", "17:20")).toBe("2026-05-10T17:20:00Z");
  });

  test("propagates validation errors", () => {
    expect(() => isoTimestampZ("nope", "17:20")).toThrow();
    expect(() => isoTimestampZ("2026-05-10", "25:00")).toThrow();
  });

  test("converts a local wall-clock in the given tz to real UTC", () => {
    // 09:00 in Asia/Tokyo (UTC+9, no DST) == 00:00Z same day. The point
    // of the tz-aware path is that 09:00 is not just relabelled `09:00Z`
    // (the bug the v0.8.0 review flagged) but actually shifted by the
    // zone's offset.
    expect(isoTimestampZ("2026-05-10", "09:00", "Asia/Tokyo")).toBe("2026-05-10T00:00:00Z");
    // Day rollover: 06:00 Tokyo = 21:00 UTC the previous day.
    expect(isoTimestampZ("2026-05-10", "06:00", "Asia/Tokyo")).toBe("2026-05-09T21:00:00Z");
  });

  test("uses the offset that was in effect for that specific instant (DST aware)", () => {
    // Belgrade is UTC+1 in winter, UTC+2 in summer. Same wall-clock,
    // different real UTC depending on the date.
    expect(isoTimestampZ("2026-01-15", "12:00", "Europe/Belgrade")).toBe("2026-01-15T11:00:00Z");
    expect(isoTimestampZ("2026-07-15", "12:00", "Europe/Belgrade")).toBe("2026-07-15T10:00:00Z");
  });
});
