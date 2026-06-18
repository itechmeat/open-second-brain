import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSignal,
  resolveEffectiveScope,
  writeSignal,
  type WriteSignalInput,
} from "../../src/core/brain/signal.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-signal-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function baseInput(overrides: Partial<WriteSignalInput> = {}): WriteSignalInput {
  return {
    topic: "no-internal-abbrev",
    signal: "negative",
    agent: "claude",
    principle: "Do not use internal abbreviations in user-facing copy unless explained first",
    created_at: "2026-05-14T10:15:00Z",
    date: "2026-05-14",
    slug: "no-internal-abbrev",
    scope: "writing",
    source: ["[[Daily/2026.05.14]]", "[[blog-header-draft]]"],
    raw: "Sergey pointed out that OSB appeared as an abbreviation.",
    ...overrides,
  };
}

describe("writeSignal — required field validation", () => {
  // Test each required field independently. The contract is
  // `Error('signal missing field: <name>')` so a regression that
  // changes the message format would be caught here.
  const requiredFields: ReadonlyArray<keyof WriteSignalInput> = [
    "topic",
    "signal",
    "agent",
    "principle",
    "created_at",
    "date",
    "slug",
  ];
  for (const field of requiredFields) {
    test(`missing '${String(field)}' throws naming the field`, () => {
      const input = baseInput();
      // `as any`-equivalent without `any`: structurally remove the
      // field by composing a fresh object that omits it.
      const partial = { ...input } as Record<string, unknown>;
      delete partial[field as string];
      expect(() => writeSignal(tmp, partial as unknown as WriteSignalInput)).toThrow(
        new RegExp(`signal missing field: ${String(field)}`),
      );
    });
  }

  test("invalid signal value throws", () => {
    expect(() =>
      writeSignal(tmp, baseInput({ signal: "neutral" as unknown as "positive" })),
    ).toThrow(/must be 'positive' or 'negative'/);
  });
});

describe("writeSignal + parseSignal roundtrip", () => {
  test("parses every field that was written", () => {
    const result = writeSignal(tmp, baseInput());
    expect(result.id).toBe("sig-2026-05-14-no-internal-abbrev");
    const parsed = parseSignal(result.path);
    expect(parsed.kind).toBe("brain-signal");
    expect(parsed.id).toBe(result.id);
    expect(parsed.created_at).toBe("2026-05-14T10:15:00Z");
    expect(parsed.topic).toBe("no-internal-abbrev");
    expect(parsed.signal).toBe("negative");
    expect(parsed.agent).toBe("claude");
    expect(parsed.scope).toBe("writing");
    expect(parsed.principle).toContain("internal abbreviations");
    expect(parsed.tags).toContain("brain");
    expect(parsed.tags).toContain("brain/signal");
    expect(parsed.tags).toContain("brain/topic/no-internal-abbrev");
    expect(parsed.tags).toContain("brain/scope/writing");
    expect(parsed.source).toEqual(["[[Daily/2026.05.14]]", "[[blog-header-draft]]"]);
    expect(parsed.raw).toContain("Sergey pointed out");
  });

  test("byte-equal roundtrip: write → parse → write to a fresh slug → identical bytes", () => {
    // Step 1: original write.
    const first = writeSignal(tmp, baseInput());
    const firstBytes = readFileSync(first.path, "utf8");

    // Step 2: parse what we wrote.
    const parsed = parseSignal(first.path);

    // Step 3: write to a second slug; same input, different filename
    // (so we can compare bytes without colliding on the first file).
    const second = writeSignal(
      tmp,
      baseInput({
        slug: "no-internal-abbrev-roundtrip",
      }),
    );
    const secondBytes = readFileSync(second.path, "utf8");

    // The two files differ only on the `id:` line and the filename
    // baked into the id; everything else must be byte-identical.
    const normalize = (s: string): string =>
      s
        .replace(/^id:.*$/m, "id: <ID>")
        .replace(/\bno-internal-abbrev-roundtrip\b/g, "no-internal-abbrev");
    expect(normalize(firstBytes)).toBe(normalize(secondBytes));

    // And the parsed source array survives untouched.
    expect(parsed.source).toEqual(["[[Daily/2026.05.14]]", "[[blog-header-draft]]"]);
  });
});

describe("resolveEffectiveScope — precedence rule", () => {
  test("explicit non-empty scope wins over a default", () => {
    expect(resolveEffectiveScope("docs", "coding")).toBe("docs");
  });
  test("default applies when explicit is undefined", () => {
    expect(resolveEffectiveScope(undefined, "coding")).toBe("coding");
  });
  test("default applies when explicit is whitespace-only", () => {
    expect(resolveEffectiveScope("   ", "coding")).toBe("coding");
  });
  test("returns undefined when neither is set", () => {
    expect(resolveEffectiveScope(undefined, undefined)).toBeUndefined();
  });
  test("returns undefined when both are whitespace/empty", () => {
    expect(resolveEffectiveScope("  ", "")).toBeUndefined();
  });
  test("trims the chosen value", () => {
    expect(resolveEffectiveScope("  docs  ", undefined)).toBe("docs");
    expect(resolveEffectiveScope(undefined, "  coding ")).toBe("coding");
  });
});

describe("writeSignal — defaultScope option", () => {
  test("applies the default when no explicit scope is given", () => {
    const input = { ...baseInput({ slug: "default-scope" }) } as Record<string, unknown>;
    delete input["scope"];
    const r = writeSignal(tmp, input as unknown as WriteSignalInput, { defaultScope: "coding" });
    const parsed = parseSignal(r.path);
    expect(parsed.scope).toBe("coding");
    expect(parsed.tags).toContain("brain/scope/coding");
  });

  test("explicit scope overrides the default", () => {
    const r = writeSignal(tmp, baseInput({ slug: "explicit-wins", scope: "writing" }), {
      defaultScope: "coding",
    });
    const parsed = parseSignal(r.path);
    expect(parsed.scope).toBe("writing");
    expect(parsed.tags).toContain("brain/scope/writing");
    expect(parsed.tags).not.toContain("brain/scope/coding");
  });

  test("no default and no explicit scope omits the scope frontmatter (byte-identical)", () => {
    const noScope = { ...baseInput({ slug: "no-scope" }) } as Record<string, unknown>;
    delete noScope["scope"];
    const withDefault = writeSignal(tmp, noScope as unknown as WriteSignalInput, {});
    const text = readFileSync(withDefault.path, "utf8");
    expect(text).not.toContain("scope:");
    expect(text).not.toContain("brain/scope/");
    expect(parseSignal(withDefault.path).scope).toBeUndefined();
  });
});

describe("writeSignal — wikilink preservation", () => {
  test("wikilink strings in source[] survive parse → write → parse unchanged", () => {
    const input = baseInput({
      source: ["[[Daily/2026.05.14]]", "[[blog-header-draft]]"],
    });
    const first = writeSignal(tmp, input);
    const parsed = parseSignal(first.path);
    expect(parsed.source).toEqual(["[[Daily/2026.05.14]]", "[[blog-header-draft]]"]);

    // Write again to a different slug, then re-parse.
    const second = writeSignal(tmp, {
      ...input,
      slug: "wiki-roundtrip",
      source: [...parsed.source!],
    });
    const reparsed = parseSignal(second.path);
    expect(reparsed.source).toEqual(["[[Daily/2026.05.14]]", "[[blog-header-draft]]"]);
  });

  test("file body actually contains the wikilink literally", () => {
    const result = writeSignal(tmp, baseInput());
    const bytes = readFileSync(result.path, "utf8");
    expect(bytes).toContain("[[Daily/2026.05.14]]");
    expect(bytes).toContain("[[blog-header-draft]]");
  });
});

describe("extractRawSection (via parseSignal)", () => {
  test("multi-line raw block survives the roundtrip in full (regression on m-flag $)", () => {
    // With the regex `/^##\s+Raw\s*\n+([\s\S]*?)\s*$/m`, the `m` flag
    // makes `$` match end-of-line — the lazy `[\s\S]*?` capture was
    // truncated at the first newline. The fix drops the `m` flag so
    // `$` only matches end-of-string, letting the full multi-line raw
    // block flow into the capture group.
    const multiLine = [
      "First line of the raw quote.",
      "Second line continues the thought.",
      "",
      "Third line after a blank gap.",
    ].join("\n");
    const result = writeSignal(
      tmp,
      baseInput({
        slug: "multi-line-raw",
        raw: multiLine,
      }),
    );
    const parsed = parseSignal(result.path);
    expect(parsed.raw).toBe(multiLine);
  });

  test("missing or placeholder raw returns undefined", () => {
    // The "## Raw\n\n_(not provided)_" placeholder should always parse
    // back to `undefined` so the schema shape stays clean.
    const noRawInput = baseInput({ slug: "no-raw" });
    delete (noRawInput as { raw?: string }).raw;
    const result = writeSignal(tmp, noRawInput);
    const parsed = parseSignal(result.path);
    expect(parsed.raw).toBeUndefined();
  });
});

describe("writeSignal — slug collision allocator", () => {
  test("second write with the same slug receives a `-2` suffix", () => {
    const a = writeSignal(tmp, baseInput());
    expect(a.id).toBe("sig-2026-05-14-no-internal-abbrev");

    const b = writeSignal(tmp, baseInput());
    expect(b.id).toBe("sig-2026-05-14-no-internal-abbrev-2");
    expect(b.path).not.toBe(a.path);
  });

  test("third write with the same slug receives `-3`", () => {
    writeSignal(tmp, baseInput());
    writeSignal(tmp, baseInput());
    const c = writeSignal(tmp, baseInput());
    expect(c.id).toBe("sig-2026-05-14-no-internal-abbrev-3");
  });
});

describe("writeSignal — sanitisation (§7)", () => {
  test("redacts secrets in principle / scope / raw", () => {
    const r = writeSignal(
      tmp,
      baseInput({
        slug: "sec",
        principle: "do not put api_key=hunter2 anywhere",
        scope: "writing token: abcd",
        raw: 'config = {"client_secret": "shhh"}',
      }),
    );
    const round = parseSignal(r.path);
    expect(round.principle).toContain("***REDACTED***");
    expect(round.principle).not.toContain("hunter2");
    expect(round.scope).toContain("***REDACTED***");
    expect(round.scope).not.toContain("abcd");
    expect(round.raw).toContain("***REDACTED***");
    expect(round.raw).not.toContain("shhh");
  });

  test("strips C0 controls and folds U+2028/U+2029 in principle", () => {
    // U+2028 = line separator. C0 byte 0x07 (BEL) should be stripped.
    const r = writeSignal(
      tmp,
      baseInput({
        slug: "ctrl",
        principle: "be\x07tidy line2",
      }),
    );
    const round = parseSignal(r.path);
    expect(round.principle).not.toContain("\x07");
    // singleLine collapses the folded LF to space.
    expect(round.principle).toBe("betidy line2");
  });

  test("caps principle at 512 chars", () => {
    const huge = "a".repeat(2000);
    const r = writeSignal(tmp, baseInput({ slug: "big", principle: huge }));
    const round = parseSignal(r.path);
    expect(round.principle.length).toBeLessThanOrEqual(512);
  });

  test("rejects when sanitisation strips principle down to empty", () => {
    expect(() => writeSignal(tmp, baseInput({ slug: "empty", principle: "\x00\x01\x07" }))).toThrow(
      /signal missing field: principle/,
    );
  });
});

// ── §9 / §16: source_type / dedup_hash / session_ref ─────────────────────────

describe("writeSignal — capture-extension fields (§9/§16)", () => {
  test("records source_type / dedup_hash / session_ref when provided", () => {
    const r = writeSignal(
      tmp,
      baseInput({
        slug: "ext-fields",
        source_type: "inline",
        dedup_hash: "deadbeef".repeat(8),
        session_ref: "Daily/2026-05-14.md#turn-7",
      }),
    );
    const raw = readFileSync(r.path, "utf8");
    expect(raw).toMatch(/^source_type: inline$/m);
    expect(raw).toMatch(
      /^dedup_hash: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef$/m,
    );
    expect(raw).toMatch(/^session_ref: /m);
  });

  test("adds brain/source/<type> tag when source_type is 'inline'", () => {
    const r = writeSignal(tmp, baseInput({ slug: "inline-tag", source_type: "inline" }));
    const raw = readFileSync(r.path, "utf8");
    expect(raw).toMatch(/brain\/source\/inline/);
  });

  test("adds brain/source/<type> tag when source_type is 'session'", () => {
    const r = writeSignal(tmp, baseInput({ slug: "session-tag", source_type: "session" }));
    const raw = readFileSync(r.path, "utf8");
    expect(raw).toMatch(/brain\/source\/session/);
  });

  test("omits brain/source/* tag when source_type is 'live' (default)", () => {
    const r = writeSignal(tmp, baseInput({ slug: "live-default" }));
    const raw = readFileSync(r.path, "utf8");
    expect(raw).not.toMatch(/brain\/source\//);
  });

  test("parseSignal round-trips source_type / dedup_hash / session_ref", () => {
    const r = writeSignal(
      tmp,
      baseInput({
        slug: "roundtrip",
        source_type: "session",
        dedup_hash: "abc123",
        session_ref: "claude.jsonl#abc",
      }),
    );
    const parsed = parseSignal(r.path);
    expect(parsed.source_type).toBe("session");
    expect(parsed.dedup_hash).toBe("abc123");
    expect(parsed.session_ref).toBe("claude.jsonl#abc");
  });

  test("parseSignal returns undefined for capture-extension fields when absent (legacy file)", () => {
    const r = writeSignal(tmp, baseInput({ slug: "no-ext-fields" }));
    const parsed = parseSignal(r.path);
    expect(parsed.source_type).toBeUndefined();
    expect(parsed.dedup_hash).toBeUndefined();
    expect(parsed.session_ref).toBeUndefined();
  });

  test("rejects unknown source_type values", () => {
    expect(() =>
      writeSignal(
        tmp,
        baseInput({
          slug: "bad-source-type",
          source_type: "bogus" as unknown as "live",
        }),
      ),
    ).toThrow(/source_type/);
  });
});
