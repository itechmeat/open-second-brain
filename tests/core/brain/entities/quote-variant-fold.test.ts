/**
 * The identity kernel folds typographic quote variants (what-the-index-
 * already-knew, task A).
 *
 * `normalizeEntityName` used to do NFC + trim + collapse + lowercase and
 * nothing else, and no Unicode normal form maps U+2019 to U+0027 - so
 * `Taylor's` and `Taylor’s` were two canonical entities in one registry,
 * differing only in which key a text editor happened to insert.
 *
 * Three obligations are pinned here.
 *
 *   1. The fold merges the variants: two labels differing only in quote
 *      form produce one identity key.
 *   2. The fold's FOOTPRINT is exactly the Unicode classes it claims. The
 *      test below derives the population from `\p{Pi}`, `\p{Pf}` and the
 *      modifier-letter apostrophe over the whole code point space and
 *      asserts the kernel changes those code points and no others - so a
 *      widened rule cannot slip in unmeasured.
 *   3. The kernel stays byte-stable for everything else. A corpus of
 *      currently-valid labels is keyed by the PRE-FOLD kernel, reproduced
 *      verbatim here, and by the shipped one, and the two must agree
 *      character for character. That is the backward-compatibility
 *      guarantee `canonical.ts` documents; a spot check is not a proof.
 *
 * The collision the fold creates is pinned in the registry block at the
 * bottom: two previously-distinct records now claim one key, and the
 * refusal must name the registered command that resolves the duplicate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import {
  differsOnlyByQuoteVariant,
  entityIdentityKey,
  foldQuoteVariants,
  normalizeEntityName,
  QUOTE_VARIANT_FOLD_TARGET,
  ENTITY_QUOTE_VARIANT_COLLISION_CODE,
} from "../../../../src/core/brain/entities/canonical.ts";
import { archiveEntity, upsertEntity } from "../../../../src/core/brain/entities/registry.ts";

/**
 * The identity kernel EXACTLY as it shipped before the fold: NFC, trim,
 * collapse whitespace runs, lowercase. Reproduced here rather than
 * imported so the byte-stability corpus is compared against a fixed
 * reference that a future edit to the kernel cannot move.
 */
function preFoldNormalize(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Upper bound of the Unicode code point space. */
const MAX_CODE_POINT = 0x10ffff;
/** The surrogate range, which is not a scalar value. */
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/** `U+XXXX` for a code point, for readable failure output. */
function u(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The fold's declared population, derived from Unicode properties by the
 * engine rather than typed out: initial and final quotation punctuation,
 * plus the modifier-letter apostrophe (a LETTER by general category, so
 * outside `\p{Pi}`/`\p{Pf}`, and an apostrophe by function).
 */
const DECLARED_CLASS_RE = /[\p{Pi}\p{Pf}\u{02BC}]/u;

/** Every scalar value the declared class admits, in code point order. */
function declaredClassCodePoints(): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
    if (cp >= SURROGATE_FIRST && cp <= SURROGATE_LAST) continue;
    if (DECLARED_CLASS_RE.test(String.fromCodePoint(cp))) out.push(cp);
  }
  return out;
}

describe("foldQuoteVariants", () => {
  test("the two apostrophe forms produce one identity key", () => {
    expect(entityIdentityKey("people", "Taylor's Version")).toBe(
      entityIdentityKey("people", "Taylor’s Version"),
    );
    expect(normalizeEntityName("Taylor’s")).toBe("taylor's");
  });

  test("the ASCII apostrophe is the fold target and is itself untouched", () => {
    expect(QUOTE_VARIANT_FOLD_TARGET).toBe("'");
    expect(foldQuoteVariants("Taylor's")).toBe("Taylor's");
  });

  test("the footprint is exactly the declared Unicode classes, nothing wider", () => {
    const declared = declaredClassCodePoints();
    // The class is non-empty and bounded - a regex that stopped matching
    // would otherwise report a clean sweep over an empty set.
    expect(declared.length).toBeGreaterThan(0);

    const changed: number[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp++) {
      if (cp >= SURROGATE_FIRST && cp <= SURROGATE_LAST) continue;
      const ch = String.fromCodePoint(cp);
      if (foldQuoteVariants(ch) !== ch) changed.push(cp);
    }
    expect(changed.map(u)).toEqual(declared.map(u));
    for (const cp of changed) {
      expect(`${u(cp)} -> ${foldQuoteVariants(String.fromCodePoint(cp))}`).toBe(
        `${u(cp)} -> ${QUOTE_VARIANT_FOLD_TARGET}`,
      );
    }
  });

  test("the modifier-letter apostrophe needs its own entry: it is a letter", () => {
    const modifierLetterApostrophe = "ʼ";
    expect(/\p{Lm}/u.test(modifierLetterApostrophe)).toBe(true);
    expect(/[\p{Pi}\p{Pf}]/u.test(modifierLetterApostrophe)).toBe(false);
    expect(foldQuoteVariants(modifierLetterApostrophe)).toBe(QUOTE_VARIANT_FOLD_TARGET);
  });

  test("no Unicode normal form would have done this - the premise of the fold", () => {
    const typographic = "Taylor’s";
    for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
      expect(`${form}: ${typographic.normalize(form)}`).toBe(`${form}: ${typographic}`);
    }
  });
});

describe("kernel byte-stability", () => {
  /**
   * Currently-valid labels that carry no quote variant: the population
   * whose identity keys must not move. Latin with internal punctuation,
   * an ASCII apostrophe, a comma, CJK, Cyrillic, emoji, mixed scripts,
   * combining marks, digits and symbols.
   */
  const CORPUS: ReadonlyArray<string> = [
    "Ada",
    "Open Second Brain",
    "Node.js",
    "C++",
    "New York, NY",
    "e.g",
    "café",
    "café",
    "Ада",
    "Пётр Ильич",
    "北京",
    "日本語のエンティティ",
    "한국어",
    "🙂 emoji label",
    "Mixed 混合 Script Ада",
    "Taylor's Version",
    "6' 2\"",
    "AT&T",
    "R&D / Q3",
    "  padded   spaces  ",
    "UPPER lower MiXeD",
    "version 2.0.1-rc1",
    "50% off",
    "@handle #tag",
    "a\tb\nc",
    "ʻokina Hawaiʻi",
  ];

  test("every corpus label keys identically to the pre-fold kernel", () => {
    for (const label of CORPUS) {
      expect(`${JSON.stringify(label)}: ${normalizeEntityName(label)}`).toBe(
        `${JSON.stringify(label)}: ${preFoldNormalize(label)}`,
      );
      expect(entityIdentityKey("people", label)).toBe(`people:${preFoldNormalize(label)}`);
    }
  });

  test("the corpus is discriminating: a quote variant does move", () => {
    const moved = "Taylor’s Version";
    expect(normalizeEntityName(moved)).not.toBe(preFoldNormalize(moved));
  });
});

describe("differsOnlyByQuoteVariant", () => {
  test("true when the folded forms agree and the unfolded ones do not", () => {
    expect(differsOnlyByQuoteVariant("Taylor's Version", "Taylor’s Version")).toBe(true);
    expect(differsOnlyByQuoteVariant("O’Brien", "O'Brien")).toBe(true);
  });

  test("false when the labels are already the same identity", () => {
    expect(differsOnlyByQuoteVariant("Ada", "  ADA ")).toBe(false);
    expect(differsOnlyByQuoteVariant("Taylor’s", "Taylor’s")).toBe(false);
  });

  test("false when the labels differ by anything other than quote form", () => {
    expect(differsOnlyByQuoteVariant("Ada", "Ада")).toBe(false);
    expect(differsOnlyByQuoteVariant("Taylor's Version", "Taylor's Album")).toBe(false);
  });
});

describe("the collision the fold creates names its exit", () => {
  const NOW = new Date("2026-06-02T12:00:00Z");
  const LATER = new Date("2026-06-02T13:00:00Z");
  const AGENT = "claude-dev-agent";

  let vault: string;
  let configHome: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-quote-fold-vault-"));
    configHome = mkdtempSync(join(tmpdir(), "o2b-quote-fold-cfg-"));
    atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  });

  /** The registered exit, read from the registry rather than retyped. */
  function registeredExit(): string {
    const signal = DIAGNOSTIC_SIGNALS.get(ENTITY_QUOTE_VARIANT_COLLISION_CODE);
    expect(signal).toBeDefined();
    return signal!.nextCommand;
  }

  test("the collision code is registered with a structural command", () => {
    const signal = DIAGNOSTIC_SIGNALS.get(ENTITY_QUOTE_VARIANT_COLLISION_CODE);
    expect(signal).toBeDefined();
    expect(signal!.nextCommand.startsWith("o2b ")).toBe(true);
    expect(signal!.autoRepairable).toBe(false);
  });

  test("an alias colliding on quote form alone refuses with the registered command", () => {
    upsertEntity(vault, {
      category: "music",
      name: "Taylor Swift",
      aliases: ["Taylor's Version"],
      agent: AGENT,
      now: NOW,
    });
    let message = "";
    try {
      upsertEntity(vault, {
        category: "music",
        name: "Red",
        aliases: ["Taylor’s Version"],
        agent: AGENT,
        now: LATER,
      });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("Taylor’s Version");
    expect(message).toContain(registeredExit());
  });

  test("an alias colliding with a canonical NAME on quote form alone names it too", () => {
    upsertEntity(vault, {
      category: "music",
      name: "Taylor's Version",
      agent: AGENT,
      now: NOW,
    });
    let message = "";
    try {
      upsertEntity(vault, {
        category: "music",
        name: "Red",
        aliases: ["Taylor’s Version"],
        agent: AGENT,
        now: LATER,
      });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("canonical name");
    expect(message).toContain(registeredExit());
  });

  test("an ordinary alias collision is unchanged - the exit is discriminating", () => {
    upsertEntity(vault, {
      category: "people",
      name: "Ada",
      aliases: ["Ада"],
      agent: AGENT,
      now: NOW,
    });
    let message = "";
    try {
      upsertEntity(vault, {
        category: "people",
        name: "Adam",
        aliases: ["Ада"],
        agent: AGENT,
        now: LATER,
      });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("already claimed by");
    expect(message).not.toContain(registeredExit());
  });

  test("releasing an archived record onto a folded namesake names the exit", () => {
    // The upgrade shape: both files were on disk before the fold, so
    // neither write seam ever saw a collision. Written directly for that
    // reason - the API cannot produce this state once the fold is in.
    const dir = join(vault, "Brain", "entities", "music");
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(
      join(dir, "ent-music-typographic.md"),
      [
        "---",
        "kind: brain-entity",
        "entity_id: ent-music-typographic",
        "category: music",
        "name: Taylor’s Version",
        "status: archived",
        "created_at: 2026-06-01T00:00:00Z",
        "updated_at: 2026-06-01T00:00:00Z",
        "archived_at: 2026-06-01T00:00:00Z",
        "---",
        "",
        "# Taylor’s Version",
        "",
      ].join("\n"),
    );
    atomicWriteFileSync(
      join(dir, "ent-music-ascii.md"),
      [
        "---",
        "kind: brain-entity",
        "entity_id: ent-music-ascii",
        "category: music",
        "name: Taylor's Version",
        "status: active",
        "created_at: 2026-06-01T00:00:00Z",
        "updated_at: 2026-06-01T00:00:00Z",
        "---",
        "",
        "# Taylor's Version",
        "",
      ].join("\n"),
    );

    let message = "";
    try {
      archiveEntity(
        vault,
        { category: "music", query: "Taylor’s Version" },
        { now: LATER, restore: true },
      );
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("ent-music-ascii");
    expect(message).toContain(registeredExit());
  });
});
