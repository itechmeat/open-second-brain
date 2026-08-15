/**
 * A redacted document still has to parse.
 *
 * ## The defect
 *
 * Two halves, both in `src/core/redactor.ts`.
 *
 * 1. `***REDACTED***` written UNQUOTED into a YAML mapping value starts an
 *    alias node (`*`), so a redacted markdown page's frontmatter is not
 *    valid YAML and Obsidian - or any spec-compliant reader - rejects the
 *    whole block. This repository's own lenient parser accepts it, which
 *    is why the branch's test (`expect(page).toContain(PLACEHOLDER)`)
 *    missed it. Every assertion here therefore goes through a STRICT
 *    parser (`Bun.YAML`), not the in-tree one.
 *
 * 2. `COLON_VALUE_RE`'s separator was `\s*:\s*`, which matches ACROSS a
 *    newline. `password:\nnext_key: kept` therefore consumed the following
 *    line whole, deleting a frontmatter key that was never a secret;
 *    `token: |` orphaned its indented block; and `token:\n  - a\n  - b`
 *    became `token:\n  ***REDACTED***\n  - b`.
 *
 * The fix direction is the one finding 3 and 8 share: redaction may not
 * damage structure. A secret whose value continues on indented lines is
 * replaced as a WHOLE (block scalar, list or nested map alike), a value on
 * the following line is not a value at all, and any placeholder landing in
 * frontmatter value position is quoted.
 */

import { describe, expect, test } from "bun:test";

import { redactRawOutput, REDACTION_PLACEHOLDER } from "../../src/core/redactor.ts";

/** Strict YAML: rejects the unquoted placeholder as an unresolved alias. */
function parseStrictYaml(text: string): unknown {
  return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(text);
}

/** The frontmatter block of a markdown page, without its fences. */
function frontmatterOf(page: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(page);
  if (match === null) throw new Error("page carries no frontmatter block");
  return match[1]!;
}

const VENDOR_TOKEN = "sk-live-9f8e7d6c5b4a32100112";
const TOKENS = { redactTokens: true, redactUrlCredentials: true } as const;

describe("a value on the NEXT line is not this key's value", () => {
  test("an empty secret key does not consume the key after it", () => {
    const out = redactRawOutput("password:\nnext_key: kept\n");
    expect(out).toContain("next_key: kept");
    expect(parseStrictYaml(out)).toMatchObject({ next_key: "kept" });
  });

  test("the key after a redacted one survives", () => {
    const out = redactRawOutput("api_key: abcd1234\nnext_key: kept\n");
    const parsed = parseStrictYaml(out) as Record<string, unknown>;
    expect(parsed["api_key"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed["next_key"]).toBe("kept");
  });
});

describe("a secret whose value continues on indented lines is replaced whole", () => {
  test("a block scalar is not orphaned", () => {
    const out = redactRawOutput("token: |\n  line one secret\n  line two secret\nother: kept\n");
    expect(out).not.toContain("line one secret");
    expect(out).not.toContain("line two secret");
    const parsed = parseStrictYaml(out) as Record<string, unknown>;
    expect(parsed["token"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed["other"]).toBe("kept");
  });

  test("a block list is not half-replaced", () => {
    const out = redactRawOutput("token:\n  - alpha\n  - beta\nother: kept\n");
    expect(out).not.toContain("alpha");
    expect(out).not.toContain("beta");
    const parsed = parseStrictYaml(out) as Record<string, unknown>;
    expect(parsed["token"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed["other"]).toBe("kept");
  });

  test("a nested mapping under a secret key goes too", () => {
    const out = redactRawOutput("credentials:\n  user: alice\n  secret: hunter2\nother: kept\n");
    expect(out).not.toContain("hunter2");
    const parsed = parseStrictYaml(out) as Record<string, unknown>;
    expect(parsed["other"]).toBe("kept");
  });

  test("a non-secret key keeps its indented block", () => {
    const source = "aliases:\n  - alpha\n  - beta\nother: kept\n";
    expect(redactRawOutput(source)).toBe(source);
  });
});

describe("a redacted frontmatter block is still valid YAML", () => {
  test("an unquoted placeholder in value position is quoted", () => {
    const page =
      `---\ntitle: Simple\napi_key: ${VENDOR_TOKEN}\nowner: ${VENDOR_TOKEN}\n` +
      `aliases:\n  - ${VENDOR_TOKEN}\n---\n\nbody\n`;
    const out = redactRawOutput(page, TOKENS);
    expect(out).not.toContain(VENDOR_TOKEN);

    const parsed = parseStrictYaml(frontmatterOf(out)) as Record<string, unknown>;
    expect(parsed["title"]).toBe("Simple");
    expect(parsed["api_key"]).toBe(REDACTION_PLACEHOLDER);
    // Reached by the bare-token pass rather than the key-name rule: the
    // placeholder can land in value position from either.
    expect(parsed["owner"]).toBe(REDACTION_PLACEHOLDER);
    expect(parsed["aliases"]).toEqual([REDACTION_PLACEHOLDER]);
  });

  test("a placeholder inside an inline list is quoted too", () => {
    // `formatFrontmatter` writes lists INLINE, so this is the shape an
    // exported OKF page actually carries - and the line-anchored rules
    // for `key:` and `- item` never see it.
    const page = `---\ntitle: Simple\naliases: [${VENDOR_TOKEN}, keep-me]\n---\n\nbody\n`;
    const parsed = parseStrictYaml(frontmatterOf(redactRawOutput(page, TOKENS))) as Record<
      string,
      unknown
    >;
    expect(parsed["aliases"]).toEqual([REDACTION_PLACEHOLDER, "keep-me"]);
  });

  test("an already-quoted value is not double-quoted", () => {
    const page = `---\ntitle: "Simple"\napi_key: "${VENDOR_TOKEN}"\n---\n\nbody\n`;
    const parsed = parseStrictYaml(frontmatterOf(redactRawOutput(page, TOKENS))) as Record<
      string,
      unknown
    >;
    expect(parsed["title"]).toBe("Simple");
    expect(parsed["api_key"]).toBe(REDACTION_PLACEHOLDER);
  });

  test("a page with nothing to redact is byte-identical", () => {
    const page = "---\ntitle: Clean\naliases:\n  - one\n---\n\nlinks to [[Other]].\n";
    expect(redactRawOutput(page, TOKENS)).toBe(page);
  });
});
