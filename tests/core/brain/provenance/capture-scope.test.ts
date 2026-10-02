/**
 * The capture-scope vocabulary: how much of a source a page actually holds.
 *
 * Three members, decided structurally. `full-local` is the trusted verdict of
 * the intake classifier (a vault-shaped identity with a readable file behind
 * it); `url-only` is the untrusted one, so the lane and the scope cannot
 * disagree; `bounded-local` is a `url-only` source whose page stores a
 * verbatim excerpt in the marked block this module renders and reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertExcerptAdmissible,
  CAPTURE_EXCERPT_FENCE_INFO,
  CAPTURE_EXCERPT_HEADING,
  CAPTURE_EXCERPT_MAX_BYTES,
  CAPTURE_SCOPE,
  CAPTURE_SCOPE_KEY,
  CAPTURE_SCOPES_KEY,
  CaptureExcerptError,
  captureScopeForTrust,
  captureScopeFrontmatter,
  captureScopesFrontmatter,
  classifyCaptureScope,
  EXCERPT_HASH_KEY,
  excerptDigest,
  readExcerptSection,
  renderExcerptSection,
} from "../../../../src/core/brain/provenance/capture-scope.ts";
import { INTAKE_TRUST } from "../../../../src/core/brain/trust/untrusted-provenance.ts";

describe("CAPTURE_SCOPE vocabulary", () => {
  // Frozenness, membership and guard agreement are owned by the vocabulary
  // census; this pins the frontmatter spellings only.
  test("the scope tokens are the pinned spellings", () => {
    expect(CAPTURE_SCOPE).toEqual({
      fullLocal: "full-local",
      boundedLocal: "bounded-local",
      urlOnly: "url-only",
    });
  });

  test("the frontmatter keys are the pinned spellings", () => {
    expect(CAPTURE_SCOPE_KEY).toBe("capture_scope");
    expect(CAPTURE_SCOPES_KEY).toBe("capture_scopes");
    expect(EXCERPT_HASH_KEY).toBe("excerpt_hash");
  });
});

describe("classifyCaptureScope", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "capture-scope-"));
    mkdirSync(join(vault, "Articles", "folder.md"), { recursive: true });
    writeFileSync(join(vault, "Articles", "x.md"), "# X\n");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("an existing vault file is full-local", () => {
    expect(classifyCaptureScope(vault, "Articles/x.md")).toBe(CAPTURE_SCOPE.fullLocal);
    expect(classifyCaptureScope(vault, "[[Articles/x.md]]")).toBe(CAPTURE_SCOPE.fullLocal);
  });

  test("a URL, an authority shape and a scheme-less host are url-only", () => {
    for (const identity of ["https://x.test/a", "//x.test/a", "evil.com/x"]) {
      expect(classifyCaptureScope(vault, identity)).toBe(CAPTURE_SCOPE.urlOnly);
    }
  });

  test("a vault-shaped path with no file and a directory are url-only", () => {
    expect(classifyCaptureScope(vault, "Articles/missing.md")).toBe(CAPTURE_SCOPE.urlOnly);
    expect(classifyCaptureScope(vault, "Articles/folder.md")).toBe(CAPTURE_SCOPE.urlOnly);
  });

  test("an extensionless note identity is matched against its .md file", () => {
    for (const identity of ["Articles/x", "[[Articles/x]]", "[[Articles/x|Alias]]"]) {
      expect(classifyCaptureScope(vault, identity)).toBe(CAPTURE_SCOPE.fullLocal);
    }
    writeFileSync(join(vault, "Meeting.md"), "# Meeting\n");
    expect(classifyCaptureScope(vault, "[[Meeting]]")).toBe(CAPTURE_SCOPE.fullLocal);
    for (const identity of [
      "Articles/missing",
      "https://x.test/a",
      "evil.com/x",
      "Articles/x.txt",
    ]) {
      expect(classifyCaptureScope(vault, identity)).toBe(CAPTURE_SCOPE.urlOnly);
    }
  });

  test("captureScopeForTrust maps the two lanes", () => {
    expect(captureScopeForTrust(INTAKE_TRUST.trusted)).toBe(CAPTURE_SCOPE.fullLocal);
    expect(captureScopeForTrust(INTAKE_TRUST.untrusted)).toBe(CAPTURE_SCOPE.urlOnly);
  });
});

describe("capture-scope frontmatter", () => {
  test("full-local writes nothing, the others carry the key", () => {
    expect(captureScopeFrontmatter(CAPTURE_SCOPE.fullLocal)).toEqual({});
    expect(captureScopeFrontmatter(CAPTURE_SCOPE.urlOnly)).toEqual({ capture_scope: "url-only" });
    expect(captureScopeFrontmatter(CAPTURE_SCOPE.boundedLocal)).toEqual({
      capture_scope: "bounded-local",
    });
  });

  test("a list writes nothing when every member is full-local, otherwise the whole list", () => {
    expect(captureScopesFrontmatter([])).toEqual({});
    expect(captureScopesFrontmatter([CAPTURE_SCOPE.fullLocal, CAPTURE_SCOPE.fullLocal])).toEqual(
      {},
    );
    expect(captureScopesFrontmatter([CAPTURE_SCOPE.urlOnly, CAPTURE_SCOPE.fullLocal])).toEqual({
      capture_scopes: ["url-only", "full-local"],
    });
  });
});

describe("the excerpt section", () => {
  const TRICKY = "first line\n```js\ncode()\n```\n漢字の引用 and ````four````\n";

  test("render then read round-trips backtick runs, CJK and a trailing newline", () => {
    const rendered = renderExcerptSection(TRICKY);
    expect(rendered.startsWith(`${CAPTURE_EXCERPT_HEADING}\n\n`)).toBe(true);
    expect(rendered).toContain(`\`\`\`\`\`${CAPTURE_EXCERPT_FENCE_INFO}\n`);
    expect(readExcerptSection(`# Page\n\nbody\n\n${rendered}`)).toBe(TRICKY);
  });

  test("a plain excerpt uses a three-backtick fence and round-trips", () => {
    const plain = "no fences here";
    const rendered = renderExcerptSection(plain);
    expect(rendered).toContain("```excerpt\nno fences here\n```");
    expect(readExcerptSection(rendered)).toBe(plain);
  });

  test("a body without the heading, or with a broken fence, reads as null", () => {
    expect(readExcerptSection("# Page\n\nno excerpt\n")).toBeNull();
    expect(readExcerptSection(`${CAPTURE_EXCERPT_HEADING}\n\nnot a fence\n`)).toBeNull();
    expect(
      readExcerptSection(`${CAPTURE_EXCERPT_HEADING}\n\n\`\`\`excerpt\nunclosed\n`),
    ).toBeNull();
  });

  test("the digest is sha256 over the UTF-8 bytes as given", () => {
    const expected = createHash("sha256").update(Buffer.from(TRICKY, "utf8")).digest("hex");
    expect(excerptDigest(TRICKY)).toBe(expected);
  });
});

describe("assertExcerptAdmissible", () => {
  test("refuses an excerpt for a source that is not url-only", () => {
    expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.fullLocal, "text")).toThrow(
      CaptureExcerptError,
    );
    expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.boundedLocal, "text")).toThrow(
      CaptureExcerptError,
    );
  });

  test("refuses a whitespace-only excerpt", () => {
    expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.urlOnly, " \n\t ")).toThrow(
      CaptureExcerptError,
    );
  });

  test("refuses an excerpt of control or format characters only, as empty", () => {
    for (const excerpt of ["\u0001\u001b", "\u200b\u00ad \n", "\u0000"]) {
      expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.urlOnly, excerpt)).toThrow(
        new CaptureExcerptError("excerpt refused: the excerpt is empty"),
      );
    }
  });

  test("refuses an excerpt holding NUL", () => {
    expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.urlOnly, "text\u0000more")).toThrow(
      new CaptureExcerptError("excerpt refused: the excerpt contains NUL"),
    );
  });

  test("counts bytes, not characters, against the cap", () => {
    // U+00E9 is two UTF-8 bytes: half the cap in characters is the cap in bytes.
    const atCap = "é".repeat(CAPTURE_EXCERPT_MAX_BYTES / 2);
    expect(() => assertExcerptAdmissible(CAPTURE_SCOPE.urlOnly, atCap)).not.toThrow();
    let caught: unknown;
    try {
      assertExcerptAdmissible(CAPTURE_SCOPE.urlOnly, `${atCap}a`);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(CaptureExcerptError);
    expect((caught as Error).name).toBe("CaptureExcerptError");
    expect((caught as Error).message).toContain(String(CAPTURE_EXCERPT_MAX_BYTES + 1));
    expect((caught as Error).message).not.toContain("é");
  });
});
