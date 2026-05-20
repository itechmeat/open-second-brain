import { describe, expect, test } from "bun:test";
import { parseUpdateArgs } from "../../src/cli/update.ts";

describe("parseUpdateArgs", () => {
  test("parses no flags", () => {
    const args = parseUpdateArgs([]);
    expect(args.target).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.force).toBe(false);
    expect(args.json).toBe(false);
  });

  test("parses --target", () => {
    const args = parseUpdateArgs(["--target", "claudecode"]);
    expect(args.target).toBe("claudecode");
  });

  test("parses --dry-run", () => {
    const args = parseUpdateArgs(["--dry-run"]);
    expect(args.dryRun).toBe(true);
  });

  test("parses --force", () => {
    const args = parseUpdateArgs(["--force"]);
    expect(args.force).toBe(true);
  });

  test("parses --json", () => {
    const args = parseUpdateArgs(["--json"]);
    expect(args.json).toBe(true);
  });
});
