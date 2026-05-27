/**
 * Tests for `src/core/brain/templates.ts`.
 *
 * Focuses on the rendering primitives — the path constants are
 * implicitly exercised by `init.ts` and `upgrade.ts` tests, but the
 * substitution path needs its own targeted coverage so CR finding
 * around `String.prototype.replace` and `$&` / `$1` mangling
 * (CodeRabbit on PR #21) cannot regress.
 */

import { describe, expect, test } from "bun:test";

import { buildSubstitutions, renderTemplate } from "../../../src/core/brain/templates.ts";

describe("renderTemplate", () => {
  test("replaces a single placeholder verbatim", () => {
    const subs = new Map([["vault_name", "alpha"]]);
    expect(renderTemplate("Hello {{vault_name}}!", subs)).toBe("Hello alpha!");
  });

  test("replaces multiple placeholders independently", () => {
    const subs = new Map([
      ["vault_name", "alpha"],
      ["schema_version", "1"],
    ]);
    expect(renderTemplate("vault {{vault_name}} schema {{schema_version}}", subs)).toBe(
      "vault alpha schema 1",
    );
  });

  test("preserves literal $& / $1 in substitution values (regression: CR on PR #21)", () => {
    // String-form `replace` treats `$&`, `$1`, etc. in the
    // replacement value as backreference syntax. A vault basename
    // like `pay-$1` (or any future field carrying `$`) must round-
    // trip verbatim — the renderer uses the function form for this.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["pay-$1", "pay-$1"],
      ["team-$&", "team-$&"],
      ["double-$$", "double-$$"],
      ["mixed-$1-and-$&", "mixed-$1-and-$&"],
    ];
    for (const [input, expected] of cases) {
      const subs = new Map([["vault_name", input]]);
      expect(renderTemplate("name={{vault_name}}", subs)).toBe(`name=${expected}`);
    }
  });

  test("unknown placeholders are left intact (visible typo)", () => {
    const subs = new Map([["vault_name", "alpha"]]);
    expect(renderTemplate("Hi {{vault_naem}}", subs)).toBe("Hi {{vault_naem}}");
  });

  test("placeholder spacing tolerates whitespace inside braces", () => {
    const subs = new Map([["vault_name", "alpha"]]);
    expect(renderTemplate("X {{ vault_name }} Y", subs)).toBe("X alpha Y");
  });
});

describe("buildSubstitutions", () => {
  test("derives vault_name from path basename", () => {
    const subs = buildSubstitutions("/srv/projects/example");
    expect(subs.get("vault_name")).toBe("example");
  });

  test("falls back to 'Second Brain' on a vault path without a usable basename", () => {
    const subs = buildSubstitutions("/");
    expect(subs.get("vault_name")).toBe("Second Brain");
  });

  test("schema_version comes from the supplied BrainConfig", () => {
    const subs = buildSubstitutions("/srv/projects/example");
    expect(subs.get("schema_version")).toBe("1");
  });
});
