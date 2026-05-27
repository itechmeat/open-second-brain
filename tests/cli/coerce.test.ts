import { describe, expect, test } from "bun:test";

import { parseOptionalIsoDate } from "../../src/cli/coerce.ts";

describe("parseOptionalIsoDate", () => {
  test("requires complete ISO-8601 timestamps instead of permissive Date input", () => {
    for (const raw of ["not-a-date", "2026", "2026-05-15"]) {
      const parsed = parseOptionalIsoDate({ now: raw }, "now");
      expect(parsed.value).toBeNull();
      expect(parsed.error).toContain("--now");
    }

    expect(parseOptionalIsoDate({ now: "2026-05-15T10:20:30Z" }, "now").error).toBeNull();
    expect(parseOptionalIsoDate({ now: "" }, "now")).toEqual({
      value: null,
      error: null,
    });
  });
});
