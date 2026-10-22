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
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import { PERSON_NICKNAMES_ARTIFACT_REL } from "../../../../src/core/brain/entities/person-nicknames.ts";
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
