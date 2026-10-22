/**
 * The registry's derived lookup lane (write-honesty-egress-consent, F3/C4).
 *
 * `getEntity` consults the derived person variants (the pure kernel in
 * `person-variants.ts`, fed by the operator nickname file) ONLY after an
 * exact name/alias miss. A unique derived match resolves; more than one
 * is an `EntityAmbiguityError` naming both ids. The WRITE lanes keep
 * their exact semantics: `resolveWriteTarget` never follows a variant,
 * so a trusted write cannot be captured by a quarantined namesake's
 * derived form and no write lands on a record through a form it never
 * declared.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  EntityAmbiguityError,
  archiveEntity,
  getEntity,
  listEntities,
  resolvePersonDerivedIndex,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import {
  PERSON_NICKNAMES_ARTIFACT_REL,
  PersonNicknameConfigError,
} from "../../../../src/core/brain/entities/person-nicknames.ts";
import { BRAIN_ENTITY_STATUS } from "../../../../src/core/brain/entities/types.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-derived-lookup-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-derived-lookup-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function upsertPerson(
  name: string,
  opts: { aliases?: string[]; untrusted?: boolean } = {},
): string {
  return upsertEntity(vault, {
    category: "people",
    name,
    ...(opts.aliases !== undefined ? { aliases: opts.aliases } : {}),
    agent: opts.untrusted === true ? "scraper" : "operator",
    now: NOW,
    ...(opts.untrusted === true ? { untrustedOrigin: true } : {}),
  }).entity.id;
}

function writeNicknames(entries: Record<string, string[]>): void {
  writeFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), JSON.stringify(entries));
}

describe("getEntity resolves a unique derived match after the exact miss", () => {
  test("an operator nickname resolves the person it stands for", () => {
    const id = upsertPerson("Robert Smith");
    writeNicknames({ bob: ["Robert Smith"] });

    const found = getEntity(vault, { query: "Bob" });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.status).toBe(BRAIN_ENTITY_STATUS.active);
  });

  test("the structural variants resolve too, scoped and unscoped", () => {
    const id = upsertPerson("Robert Smith");
    // No nickname data at all: the structural kernel alone must answer.
    expect(getEntity(vault, { query: "smith robert" })!.id).toBe(id);
    expect(getEntity(vault, { category: "people", query: "r smith" })!.id).toBe(id);
  });

  test("the dotted-initial and comma spellings resolve the plain-named person", () => {
    const id = upsertPerson("Ada Lovelace");
    // "A. Lovelace" and "Lovelace, Ada" are the two punctuation shapes
    // normalization keeps; both fold onto the derived forms of the
    // plain spelling instead of missing.
    expect(getEntity(vault, { query: "A. Lovelace" })!.id).toBe(id);
    expect(getEntity(vault, { query: "Lovelace, Ada" })!.id).toBe(id);
    expect(getEntity(vault, { category: "people", query: "lovelace, ada" })!.id).toBe(id);
  });

  test("an astral initial resolves through the derived initial form", () => {
    // U+10414 DESERET CAPITAL LETTER AIL - a surrogate pair in UTF-16,
    // so a UTF-16-unit initial slice would emit a lone surrogate.
    const id = upsertPerson("\u{10414}avid Smith");
    expect(getEntity(vault, { query: "\u{10414} smith" })!.id).toBe(id);
  });

  test("a two-letter operator nickname resolves the person it stands for", () => {
    // Operator-declared nicknames are exempt from the structural floor.
    const id = upsertPerson("Alan Lovelace");
    writeNicknames({ al: ["Alan Lovelace"] });
    expect(getEntity(vault, { query: "Al" })!.id).toBe(id);
    expect(getEntity(vault, { query: "a lovelace" })!.id).toBe(id);
  });

  test("an exact declared form still wins before the derived lane is consulted", () => {
    const id = upsertPerson("Robert Smith", { aliases: ["Rob"] });
    writeNicknames({ bob: ["Robert Smith"], rob: ["Robert Smith"] });

    expect(getEntity(vault, { query: "robert smith" })!.id).toBe(id);
    expect(getEntity(vault, { query: "Rob" })!.id).toBe(id);
  });
});

describe("a shared derived form is an ambiguity, not a silent pick", () => {
  test("two persons sharing a nickname throw with both ids named", () => {
    const smith = upsertPerson("Robert Smith");
    const jones = upsertPerson("Robert Jones");
    writeNicknames({ bob: ["Robert Smith", "Robert Jones"] });

    let err: unknown;
    try {
      getEntity(vault, { query: "bob" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EntityAmbiguityError);
    const amb = err as EntityAmbiguityError;
    expect(amb.name).toBe("EntityAmbiguityError");
    expect(amb.message).toContain(smith);
    expect(amb.message).toContain(jones);
  });

  test("the derived ambiguity names the remedy of two real people, not a merge", () => {
    // Two persons reaching one initial form are not duplicates: the
    // message must offer a more specific reference, never the
    // archive-or-merge exit the exact lane's duplicates get.
    upsertPerson("Robert Smith");
    upsertPerson("Robert Jones");
    writeNicknames({ bob: ["Robert Smith", "Robert Jones"] });

    let err: unknown;
    try {
      getEntity(vault, { query: "bob" });
    } catch (e) {
      err = e;
    }
    const amb = err as EntityAmbiguityError;
    expect(amb.derived).toBe(true);
    expect(amb.message).toContain("derived name form");
    expect(amb.message).toContain("full name");
    expect(amb.message).toContain("alias");
    expect(amb.message).toContain("category");
    expect(amb.message).not.toContain("archived or merged");
  });

  test("the exact forms of the same two persons still resolve uniquely", () => {
    const smith = upsertPerson("Robert Smith");
    const jones = upsertPerson("Robert Jones");
    writeNicknames({ bob: ["Robert Smith", "Robert Jones"] });

    expect(getEntity(vault, { query: "robert smith" })!.id).toBe(smith);
    expect(getEntity(vault, { query: "robert jones" })!.id).toBe(jones);
  });
});

describe("the derived lane resolves canonical records only", () => {
  test("a quarantined person's variant never resolves a read", () => {
    upsertPerson("Robert Smith", { untrusted: true });
    writeNicknames({ bob: ["Robert Smith"] });

    expect(getEntity(vault, { query: "bob" })).toBeNull();
  });

  test("an archived person derives nothing", () => {
    upsertPerson("Robert Smith");
    archiveEntity(vault, { query: "Robert Smith" }, { now: NOW });
    writeNicknames({ bob: ["Robert Smith"] });

    expect(getEntity(vault, { query: "bob" })).toBeNull();
    expect(getEntity(vault, { category: "people", query: "Robert Smith" })).toBeNull();
  });

  test("a non-person category never resolves through a derived form", () => {
    upsertEntity(vault, {
      category: "org",
      name: "Ada Lovelace",
      agent: "operator",
      now: NOW,
    });
    writeNicknames({ ada: ["Ada Lovelace"] });

    expect(getEntity(vault, { query: "lovelace ada" })).toBeNull();
    expect(getEntity(vault, { query: "ada" })).toBeNull();
  });
});

describe("write lanes keep exact semantics", () => {
  test("a TRUSTED write is never captured by a quarantined namesake's variant", () => {
    upsertPerson("Robert Smith", { untrusted: true });
    writeNicknames({ bob: ["robert smith"] });
    const quarantinedBefore = readFileSync(
      listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })[0]!.path,
      "utf8",
    );

    const res = upsertEntity(vault, {
      category: "people",
      name: "Bob",
      agent: "operator",
      now: NOW,
    });

    expect(res.created).toBe(true);
    expect(res.entity.status).toBe(BRAIN_ENTITY_STATUS.active);
    const found = getEntity(vault, { query: "Bob" });
    expect(found!.id).toBe(res.entity.id);
    // The quarantined record is neither promoted nor rewritten.
    const quarantined = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.source_agent).toBe("scraper");
    expect(readFileSync(quarantined[0]!.path, "utf8")).toBe(quarantinedBefore);
  });

  test("a trusted write does not land inside a canonical person through a derived form", () => {
    const smith = upsertPerson("Robert Smith");
    writeNicknames({ bob: ["Robert Smith"] });

    const res = upsertEntity(vault, {
      category: "people",
      name: "Bob",
      agent: "operator",
      now: NOW,
    });

    expect(res.created).toBe(true);
    expect(res.entity.id).not.toBe(smith);
    expect(listEntities(vault, { category: "people" })).toHaveLength(2);
    // The derived lane stays a read aid: once a record DECLARES the
    // spelling, the exact lane answers for it, and the person the
    // nickname was derived from keeps answering to its declared name.
    expect(getEntity(vault, { query: "bob" })!.id).toBe(res.entity.id);
    expect(getEntity(vault, { query: "robert smith" })!.id).toBe(smith);
  });
});

describe("a malformed nickname file degrades reads to exact-only", () => {
  test("exact resolution holds and the derived lane stays silent without throwing", () => {
    const id = upsertPerson("Robert Smith");
    writeFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), "{ not json");

    expect(getEntity(vault, { query: "robert smith" })!.id).toBe(id);
    expect(getEntity(vault, { query: "bob" })).toBeNull();
  });
});

describe("the derived person-form index is cached per signature", () => {
  test("unchanged inputs return the same object; a nickname edit forces a rebuild", () => {
    const smith = upsertPerson("Robert Smith");
    writeNicknames({ bob: ["Robert Smith"] });

    const first = resolvePersonDerivedIndex(vault);
    expect(resolvePersonDerivedIndex(vault)).toBe(first);

    // A nicknames edit shifts the mtime/size signature and forces a
    // fresh build that answers through the new entry.
    writeNicknames({ bob: ["Robert Smith"], rob: ["Robert Smith"] });
    const second = resolvePersonDerivedIndex(vault);
    expect(second).not.toBe(first);
    expect(second.byForm.get("rob")?.derived.map((e) => e.id)).toEqual([smith]);

    // A present-but-unusable file is captured, not thrown: the derived
    // lane empties while the structure stays available to consumers
    // that degrade by posture.
    writeFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), "{ not json");
    const broken = resolvePersonDerivedIndex(vault);
    expect(broken).not.toBe(second);
    expect(broken.nicknameError).toBeInstanceOf(PersonNicknameConfigError);
    expect(broken.byForm.get("bob")).toBeUndefined();
    // An entity write still shows up: the index identity is part of the
    // cache key.
    upsertPerson("Robert Jones");
    const afterWrite = resolvePersonDerivedIndex(vault);
    expect(afterWrite).not.toBe(broken);
    expect(afterWrite.nicknameError).toBeInstanceOf(PersonNicknameConfigError);
  });
});
