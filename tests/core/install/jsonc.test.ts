/**
 * The vendored minimal JSONC editor.
 *
 * The repo has exactly one runtime dependency and no JSONC handling, and
 * the OpenCode V2 config surface needs exactly this narrow edit: locate a
 * nested key in a JSONC document, splice one entry in or out, and keep
 * every byte outside the spliced range - comments included - as it was.
 * These tests pin that contract: token-offset splices, not
 * re-serialization; named `JsoncEditError` refusals for malformed or
 * ambiguous input; BOM stripped on read and restored on write.
 */

import { describe, expect, test } from "bun:test";

import {
  JsoncEditError,
  hasJsoncSyntax,
  parseJsoncObject,
  removeJsoncEntry,
  setJsoncEntry,
} from "../../../src/core/install/jsonc.ts";

const FULL_ENTRY = { type: "local", command: ["o2b", "mcp"], enabled: true };
const WRITER_ENTRY = {
  type: "local",
  command: ["o2b", "mcp", "--writer-only"],
  enabled: true,
};

/** A JSONC config with a header comment, an inline comment and a trailing comma. */
const COMMENTED_CONFIG = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
  },
}
`;

const COMMENTED_CONFIG_WITH_FULL = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
    "servers": {
      "open-second-brain": {
        "type": "local",
        "command": [
          "o2b",
          "mcp"
        ],
        "enabled": true
      }
    }
  },
}
`;

const COMMENTED_CONFIG_WITH_BOTH = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
    "servers": {
      "open-second-brain": {
        "type": "local",
        "command": [
          "o2b",
          "mcp"
        ],
        "enabled": true
      },
      "open-second-brain-writer": {
        "type": "local",
        "command": [
          "o2b",
          "mcp",
          "--writer-only"
        ],
        "enabled": true
      }
    }
  },
}
`;

const COMMENTED_CONFIG_WITH_WRITER = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
    "servers": {
      "open-second-brain-writer": {
        "type": "local",
        "command": [
          "o2b",
          "mcp",
          "--writer-only"
        ],
        "enabled": true
      }
    }
  },
}
`;
const REPLACED_FULL_CONFIG = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
    "servers": {
      "open-second-brain": {
        "type": "local",
        "command": [
          "o2b",
          "mcp",
          "--vault",
          "/v"
        ],
        "enabled": false
      }
    }
  },
}
`;

/** Removing the last entry leaves its (now empty) object behind - entries go, keys stay. */
const EMPTY_SERVERS_CONFIG = `// opencode configuration
{
  "theme": "dark",
  "mcp": {
    "other": { "type": "remote" },
    "servers": {
    }
  },
}
`;

describe("parseJsoncObject", () => {
  test("parses line comments, block comments, comment-like string content, escapes and trailing commas", () => {
    const text = `{
  // a line comment with "quotes" and /* block-like content */
  "url": "https://example.test/a//b?c=1", /* trailing block comment */
  "escaped": "line\\nbreak \\"quoted\\" \\\\ backslash",
  "list": [1, 2,],
}`;
    expect(parseJsoncObject(text)).toEqual({
      url: "https://example.test/a//b?c=1",
      escaped: 'line\nbreak "quoted" \\ backslash',
      list: [1, 2],
    });
  });

  test("a BOM is stripped on read", () => {
    const parsed = parseJsoncObject("\uFEFF" + COMMENTED_CONFIG);
    expect(parsed["theme"]).toBe("dark");
  });

  test("malformed input raises the named JsoncEditError", () => {
    for (const text of ['{ "mcp": ', '{ "mcp": }', "{} trailing", '{ "a": 1 } /*', "{"]) {
      try {
        parseJsoncObject(text);
        throw new Error(`expected JsoncEditError for ${JSON.stringify(text)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(JsoncEditError);
        expect((e as Error).name).toBe("JsoncEditError");
      }
    }
  });

  test("punctuation in a value position raises instead of parsing as null", () => {
    // A missing value is malformed input, not a null: reading `{"a": ,}`
    // as `{"a": null}` would let apply proceed on a file no JSON parser
    // accepts. Each reviewed repro, plus the array and mid-object forms.
    for (const text of ['{"a": ,}', '{"a": :, "b": 1}', "[,]", '{"a": 1, "b": }', "[1, , 2]"]) {
      try {
        parseJsoncObject(text);
        throw new Error(`expected JsoncEditError for ${JSON.stringify(text)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(JsoncEditError);
        expect((e as Error).name).toBe("JsoncEditError");
      }
    }
    // The legal trailing-comma neighbors still parse.
    expect(parseJsoncObject('{"a": 1,}')).toEqual({ a: 1 });
    expect(parseJsoncObject('{"a": [1,]}')).toEqual({ a: [1] });
  });

  test("duplicate keys raise the named error mentioning the key", () => {
    expect(() => parseJsoncObject('{ "mcp": {}, "mcp": {} }')).toThrow(/mcp/);
    expect(() => parseJsoncObject('{ "mcp": { "servers": { "k": 1, "k": 2 } } }')).toThrow(/\bk\b/);
    try {
      parseJsoncObject('{ "mcp": {}, "mcp": {} }');
    } catch (e) {
      expect(e).toBeInstanceOf(JsoncEditError);
      expect((e as Error).message).toContain("mcp");
    }
  });

  test("a non-object root raises the named error", () => {
    expect(() => parseJsoncObject("[1, 2]")).toThrow(JsoncEditError);
    expect(() => parseJsoncObject('"just a string"')).toThrow(JsoncEditError);
  });
});

describe("parseJsoncObject - __proto__ keys", () => {
  /**
   * Both Open Second Brain entry keys with an attacker-chosen command,
   * as the audit's payload.
   */
  const CRAFTED_ENTRIES =
    '{"open-second-brain":{"type":"local","command":["evil"],"enabled":true},' +
    '"open-second-brain-writer":{"type":"local","command":["evil"],"enabled":true}}';

  test("a literal __proto__ key stays an inert own property, never the prototype", () => {
    const parsed = parseJsoncObject(`{"mcp":{"servers":{"__proto__":${CRAFTED_ENTRIES}}}}`);
    const mcp = parsed["mcp"] as Record<string, unknown>;
    const servers = mcp["servers"] as Record<string, unknown>;
    // These are the reads the audit forged: pre-fix, `in` and bracket
    // access saw the crafted entries through the injected prototype, so
    // detect reported an install on a file whose real content registers
    // nothing.
    expect("open-second-brain" in servers).toBe(false);
    expect("open-second-brain-writer" in servers).toBe(false);
    expect(servers["open-second-brain"]).toBeUndefined();
    expect(servers["open-second-brain-writer"]).toBeUndefined();
    // The key itself survives as an inert literal, exactly the semantics
    // JSON.parse gives it.
    expect(Object.hasOwn(servers, "__proto__")).toBe(true);
    expect(Object.keys(servers)).toEqual(["__proto__"]);
  });

  test("a root-level __proto__ carrying a whole mcp tree forges nothing", () => {
    const parsed = parseJsoncObject(`{"__proto__":{"mcp":{"servers":${CRAFTED_ENTRIES}}}}`);
    expect("mcp" in parsed).toBe(false);
    expect(parsed["mcp"]).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
  });

  test("the word __proto__ in comments and string values stays legal", () => {
    const text = '{ /* __proto__ */ "note": "see __proto__ docs", "mcp": { "servers": {} } }';
    expect(parseJsoncObject(text)).toEqual({ note: "see __proto__ docs", mcp: { servers: {} } });
  });
});

describe("hasJsoncSyntax", () => {
  test("plain JSON is not JSONC", () => {
    expect(hasJsoncSyntax('{ "mcp": { "servers": {} } }\n')).toBe(false);
    expect(hasJsoncSyntax('\uFEFF{ "mcp": {} }\n')).toBe(false);
  });

  test("comment-like content inside a string is not a JSONC feature", () => {
    expect(hasJsoncSyntax('{ "url": "https://x//not-a-comment", "b": "a/*b*/c" }')).toBe(false);
  });

  test("comments and trailing commas are JSONC features", () => {
    expect(hasJsoncSyntax('{ // note\n "a": 1 }')).toBe(true);
    expect(hasJsoncSyntax('{ "a": 1 } /* tail */')).toBe(true);
    expect(hasJsoncSyntax('{ "a": 1, }')).toBe(true);
    expect(hasJsoncSyntax('{ "a": [1, 2,] }')).toBe(true);
  });
});

describe("setJsoncEntry", () => {
  test("inserts one entry under a nested object, splicing at token offsets", () => {
    expect(
      setJsoncEntry(COMMENTED_CONFIG, ["mcp", "servers"], "open-second-brain", FULL_ENTRY),
    ).toBe(COMMENTED_CONFIG_WITH_FULL);
  });

  test("every byte outside the spliced range survives the insert", () => {
    const result = setJsoncEntry(
      COMMENTED_CONFIG,
      ["mcp", "servers"],
      "open-second-brain",
      FULL_ENTRY,
    );
    // The header comment and the untouched "theme" line are byte-identical.
    expect(result.startsWith('// opencode configuration\n{\n  "theme": "dark",')).toBe(true);
    expect(result).toContain('"other": { "type": "remote" },\n');
  });

  test("creates missing intermediate objects along the path", () => {
    const text = `{
  "theme": "dark"
}
`;
    expect(setJsoncEntry(text, ["mcp", "servers"], "k", { enabled: true })).toBe(`{
  "theme": "dark",
  "mcp": {
    "servers": {
      "k": {
        "enabled": true
      }
    }
  }
}
`);
  });

  test("replacing an existing entry splices exactly its value range", () => {
    const updated = {
      ...FULL_ENTRY,
      command: [...FULL_ENTRY.command, "--vault", "/v"],
      enabled: false,
    };
    expect(
      setJsoncEntry(COMMENTED_CONFIG_WITH_FULL, ["mcp", "servers"], "open-second-brain", updated),
    ).toBe(REPLACED_FULL_CONFIG);
  });

  test("a single-line object stays single-line when filled", () => {
    expect(setJsoncEntry('{ "mcp": {} }', ["mcp"], "k", { a: 1 })).toBe(
      '{ "mcp": {"k": {"a":1}} }',
    );
  });

  test("a single-line object with a trailing comma does not gain a doubled comma", () => {
    const grown = setJsoncEntry('{ "a": 1, }', [], "b", 2);
    expect(parseJsoncObject(grown)).toEqual({ a: 1, b: 2 });
  });

  test("an inserted entry does not take over the last entry's line comment", () => {
    const text = `{
  "a": {"x": 1} // keep me with a
}
`;
    const result = setJsoncEntry(text, [], "osb", { enabled: true });
    // The separator lands at the old value end, before the comment, and
    // the comment keeps annotating a's line - not the inserted entry.
    expect(result).toContain('"a": {"x": 1}, // keep me with a\n');
    const commentLine = result.split("\n").find((line) => line.includes("// keep me with a"));
    expect(commentLine).toContain('"a"');
    expect(commentLine).not.toContain('"osb"');
    expect(parseJsoncObject(result)).toEqual({ a: { x: 1 }, osb: { enabled: true } });
  });

  test("install then uninstall restores a commented trailing-comma line byte for byte", () => {
    const text = `{
  "a": 1, // note a
}
`;
    const grown = setJsoncEntry(text, [], "osb", { enabled: true });
    expect(parseJsoncObject(grown)).toEqual({ a: 1, osb: { enabled: true } });
    // The inserted entry opens the line after a's, past the comma and
    // the comment.
    expect(grown).toContain('"a": 1, // note a\n  "osb": {');
    expect(removeJsoncEntry(grown, [], "osb")).toBe(text);
  });

  test("an insert never lands inside a block comment that runs past the value's line", () => {
    const text = `{
  "a": 1 /* note
  more note */
}
`;
    const result = setJsoncEntry(text, [], "b", 2);
    expect(parseJsoncObject(result)).toEqual({ a: 1, b: 2 });
    expect(result).toContain("/* note\n  more note */");
  });

  test("a leading block comment does not shrink the indent unit", () => {
    const text = `/*
 * my config
 */
{
  "a": 1
}
`;
    const result = setJsoncEntry(text, [], "b", { k: 1 });
    // Two-space steps: the unit comes from the `"a": 1` line, which
    // starts with a token - not from the comment star's column.
    expect(result).toContain('  "b": {\n    "k": 1\n  }');
    expect(parseJsoncObject(result)).toEqual({ a: 1, b: { k: 1 } });
  });

  test("replacing a single-line entry keeps it single-line, so re-sets stay byte-stable", () => {
    // Compact form is JSON.stringify's own, the form this editor writes.
    const text = `{
  "mcp": {
    "servers": {"open-second-brain": {"enabled":true}}
  }
}
`;
    const once = setJsoncEntry(text, ["mcp", "servers"], "open-second-brain", { enabled: true });
    expect(once).toBe(text);
    const twice = setJsoncEntry(once, ["mcp", "servers"], "open-second-brain", { enabled: true });
    expect(twice).toBe(text);
  });

  test("a comment-free canonical file re-set with the same entry is byte-identical", () => {
    const canonical =
      JSON.stringify({ mcp: { servers: { "open-second-brain": FULL_ENTRY } } }, null, 2) + "\n";
    expect(setJsoncEntry(canonical, ["mcp", "servers"], "open-second-brain", FULL_ENTRY)).toBe(
      canonical,
    );
  });

  test("a path segment that is not an object raises the named error", () => {
    expect(() => setJsoncEntry('{ "mcp": 3 }', ["mcp", "servers"], "k", true)).toThrow(
      JsoncEditError,
    );
  });

  test("a non-serializable value raises instead of emitting partial text", () => {
    expect(() => setJsoncEntry("{}" as string, [], "k", undefined)).toThrow(JsoncEditError);
  });

  test("malformed input raises the named error rather than emitting partial text", () => {
    expect(() => setJsoncEntry("{ not json", ["mcp"], "k", true)).toThrow(JsoncEditError);
  });

  test("a BOM on the input is restored on the output", () => {
    const result = setJsoncEntry(
      "\uFEFF" + COMMENTED_CONFIG,
      ["mcp", "servers"],
      "open-second-brain",
      FULL_ENTRY,
    );
    expect(result.startsWith("\uFEFF// opencode configuration")).toBe(true);
    expect(result.slice(1)).toBe(COMMENTED_CONFIG_WITH_FULL);
  });
});

describe("removeJsoncEntry", () => {
  test("removing an entry closes the hole without disturbing neighbors", () => {
    expect(
      removeJsoncEntry(COMMENTED_CONFIG_WITH_BOTH, ["mcp", "servers"], "open-second-brain"),
    ).toBe(COMMENTED_CONFIG_WITH_WRITER);
    expect(
      removeJsoncEntry(
        COMMENTED_CONFIG_WITH_WRITER,
        ["mcp", "servers"],
        "open-second-brain-writer",
      ),
    ).toBe(EMPTY_SERVERS_CONFIG);
  });

  test("a set followed by a remove restores the original bytes", () => {
    const canonical =
      JSON.stringify({ mcp: { servers: { "open-second-brain": FULL_ENTRY } } }, null, 2) + "\n";
    const grown = setJsoncEntry(
      canonical,
      ["mcp", "servers"],
      "open-second-brain-writer",
      WRITER_ENTRY,
    );
    expect(grown).not.toBe(canonical);
    expect(removeJsoncEntry(grown, ["mcp", "servers"], "open-second-brain-writer")).toBe(canonical);
  });

  test("an absent key or absent path is a byte-identical no-op", () => {
    expect(removeJsoncEntry(COMMENTED_CONFIG, ["mcp", "servers"], "open-second-brain")).toBe(
      COMMENTED_CONFIG,
    );
    expect(removeJsoncEntry(COMMENTED_CONFIG, ["nope", "deeper"], "open-second-brain")).toBe(
      COMMENTED_CONFIG,
    );
  });

  test("a comment sharing the removed entry's line survives", () => {
    const text = `{
  "mcp": {
    "keep": 1,
    "osb": 2 /* operator note */
  }
}
`;
    const result = removeJsoncEntry(text, ["mcp"], "osb");
    expect(result).toContain("/* operator note */");
    expect(parseJsoncObject(result)).toEqual({ mcp: { keep: 1 } });
  });

  test("a BOM on the input is restored on the output", () => {
    const withBom = "\uFEFF" + COMMENTED_CONFIG_WITH_BOTH;
    const result = removeJsoncEntry(withBom, ["mcp", "servers"], "open-second-brain");
    expect(result.startsWith("\uFEFF")).toBe(true);
    expect(result.slice(1)).toBe(COMMENTED_CONFIG_WITH_WRITER);
  });

  test("a comma-first document survives removing its comma-free entry", () => {
    // The separator sits at the head of the FOLLOWING line - valid JSONC.
    // The removal must consume that following comma, or the collapse of
    // the entry's line strands it at the head of the object.
    const text = `{
  "a": 1
  , "b": 2
}
`;
    const result = removeJsoncEntry(text, [], "a");
    expect(parseJsoncObject(result)).toEqual({ b: 2 });
    // Bytes outside the splice survive: "b"'s line keeps its shape.
    expect(result).toContain('"b": 2\n}\n');
  });

  test("a comma-first document survives removing its last entry byte-exactly", () => {
    const text = `{
  "a": 1
  , "b": 2
}
`;
    expect(removeJsoncEntry(text, [], "b")).toBe(`{
  "a": 1
}
`);
  });

  test("inserting into a comma-first document keeps it parseable", () => {
    const text = `{
  "a": 1
  , "b": 2
}
`;
    const grown = setJsoncEntry(text, [], "c", 3);
    expect(parseJsoncObject(grown)).toEqual({ a: 1, b: 2, c: 3 });
    // The comma-first bytes survive the splice elsewhere; the new entry
    // carries its own separator.
    expect(grown).toContain('  , "b": 2,\n');
  });

  test("a trailing comma on a comment line above the entry is never eaten", () => {
    // The walk-back must treat that comma as comment content, not a
    // separator: every byte of an operator comment is kept exactly.
    const text = `{
  "a": 1,
  // about b,
  "b": 2
}
`;
    const result = removeJsoncEntry(text, [], "b");
    expect(result).toContain("// about b,\n");
    expect(parseJsoncObject(result)).toEqual({ a: 1 });
  });

  test("a CRLF trailing-comma document removes its last entry byte-exactly", () => {
    // \r is horizontal whitespace in the separator scans: a walk-back
    // that stopped at the carriage return would miss the comma and
    // strand a trailing comma instead of restoring the bytes.
    const text = '{\r\n  "a": 1,\r\n  "osb": 2\r\n}\r\n';
    expect(removeJsoncEntry(text, [], "osb")).toBe('{\r\n  "a": 1\r\n}\r\n');
  });

  test("a CRLF comma-first document survives removing either entry", () => {
    const text = '{\r\n  "a": 1\r\n  , "osb": 2\r\n}\r\n';
    const withoutFirst = removeJsoncEntry(text, [], "a");
    expect(parseJsoncObject(withoutFirst)).toEqual({ osb: 2 });
    const withoutLast = removeJsoncEntry(text, [], "osb");
    expect(parseJsoncObject(withoutLast)).toEqual({ a: 1 });
    expect(withoutLast).toBe('{\r\n  "a": 1\r\n}\r\n');
  });

  test("a comma-first separator hiding behind the entry's line comment is consumed", () => {
    // Removing a first entry that carries a line comment must also take
    // the next entry's leading comma with it, or the remainder is `{ // c
    // , "b": 2 }` - JSONC no parser accepts.
    const text = `{
  "osb": 1 // note on osb
  , "b": 2
}
`;
    const result = removeJsoncEntry(text, [], "osb");
    expect(parseJsoncObject(result)).toEqual({ b: 2 });
    expect(result).toContain('"b": 2');
  });

  test("a number literal longer than 64 characters parses instead of false-refusing", () => {
    const digits65 =
      "12345678901234567890123456789012345678901234567890123456789012345678901234567";
    const text = `{\n  "big": ${digits65},\n  "small": 1\n}\n`;
    expect(parseJsoncObject(text)).toEqual({ big: Number(digits65), small: 1 });
    // The editor route too: scanning the literal must not split it into
    // two tokens and refuse the whole document.
    expect(setJsoncEntry(text, [], "flag", true)).toContain('"flag": true');
  });
});
