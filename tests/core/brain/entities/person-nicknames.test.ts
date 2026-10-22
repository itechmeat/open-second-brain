/**
 * The operator nickname reader (write-honesty-egress-consent, F3).
 *
 * Characterization tests for the reader after its move from
 * `src/core/search/entity-alias.ts` to this brain-side leaf: the
 * registry's derived lookup lane (C4) and the doctor's collision scan
 * (C5) consume it from the brain side, and the brain must not import
 * from `src/core/search/`. The reader's behavior is unchanged - the search
 * suite keeps exercising the same class through its re-export.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PersonNicknameConfigError,
  PERSON_NICKNAMES_ARTIFACT_REL,
  resolvePersonNicknameMap,
} from "../../../../src/core/brain/entities/person-nicknames.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-nicknames-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Write a nickname artifact into the vault, creating its directories. */
function writeArtifact(text: string): void {
  mkdirSync(join(vault, "Brain", "entities"), { recursive: true });
  writeFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), text);
}

describe("resolvePersonNicknameMap", () => {
  test("a missing file is the empty map, not an error", () => {
    const map = resolvePersonNicknameMap(vault);
    expect(map.size).toBe(0);
  });

  test("the artifact path is the Brain/entities neighbourhood of the vault", () => {
    expect(PERSON_NICKNAMES_ARTIFACT_REL).toContain("person-nicknames.json");
  });

  test("a present file parses to the normalized nickname map", () => {
    writeArtifact(
      JSON.stringify({ "  BOB  ": ["Robert  Smith", "Robert Smith", ""], "": ["ignored"] }),
    );
    const map = resolvePersonNicknameMap(vault);
    expect([...map.keys()]).toEqual(["bob"]);
    expect([...map.get("bob")!]).toEqual(["robert smith"]);
  });

  test("a malformed file surfaces by name", () => {
    writeArtifact("{ not json");
    let err: unknown;
    try {
      resolvePersonNicknameMap(vault);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PersonNicknameConfigError);
    expect((err as PersonNicknameConfigError).name).toBe("PersonNicknameConfigError");
    expect((err as PersonNicknameConfigError).path).toContain("person-nicknames.json");
  });

  test("the parse-failure detail is position-only, never the parser's message", () => {
    // The parser's own message can quote the bytes it choked on, and the
    // detail reaches doctor output and logs - so only a position (or the
    // fixed sentence) may travel.
    writeArtifact('{ "quoted-bytes" from the file }');
    let err: unknown;
    try {
      resolvePersonNicknameMap(vault);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PersonNicknameConfigError);
    const detail = (err as PersonNicknameConfigError).detail;
    expect(detail).not.toContain("quoted-bytes");
    expect(detail).not.toContain("Unexpected");
    expect(detail).toMatch(
      /^not parseable JSON \((parse failed at (line \d+|offset \d+)|the parser reported a syntax error)\)$/,
    );
  });

  test("a non-array value surfaces by name", () => {
    writeArtifact(JSON.stringify({ bob: "Robert Smith" }));
    expect(() => resolvePersonNicknameMap(vault)).toThrow(PersonNicknameConfigError);
  });

  test("a shape-error detail is position-only: the operator key never travels", () => {
    // The key of a nickname entry is a person's name - the same kind of
    // data the parse-error path keeps out of doctor output and logs - so
    // the shape detail names the entry's POSITION, not the key's text.
    writeArtifact(JSON.stringify({ "Bobby Tables": "Robert" }));
    let err: unknown;
    try {
      resolvePersonNicknameMap(vault);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PersonNicknameConfigError);
    const detail = (err as PersonNicknameConfigError).detail;
    expect(detail).not.toContain("Bobby Tables");
    expect(detail).toMatch(/^value of entry #1 must be an array of names$/);
  });

  test("two raw keys that normalize alike merge instead of the last one winning", () => {
    // "Bob" and "bob " normalize to the same key; a silent replace makes
    // the expansion depend on the JSON key order. The value lists merge.
    writeArtifact(JSON.stringify({ Bob: ["Robert Smith"], "bob ": ["Bobby"] }));
    const map = resolvePersonNicknameMap(vault);
    expect(map.get("bob")).toEqual(["robert smith", "bobby"]);
  });
});
