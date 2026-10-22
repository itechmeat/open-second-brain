import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { relateEntities, upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { PERSON_NICKNAMES_ARTIFACT_REL } from "../../../src/core/brain/entities/person-nicknames.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-02T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function entityFile(name: string, lines: string[]): void {
  atomicWriteFileSync(join(brainDirs(vault).entities, "people", name), lines.join("\n") + "\n");
}

/** Write the operator nickname map the collision scan resolves. */
function writeNicknames(entries: Record<string, string[]>): void {
  atomicWriteFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), JSON.stringify(entries));
}

function person(name: string, opts: { aliases?: string[]; untrusted?: boolean } = {}): string {
  return upsertEntity(vault, {
    category: "people",
    name,
    ...(opts.aliases !== undefined ? { aliases: opts.aliases } : {}),
    agent: "a",
    now: NOW,
    ...(opts.untrusted === true ? { untrustedOrigin: true } : {}),
  }).entity.id;
}

describe("doctor entity lints", () => {
  test("clean registry produces no entity issues", () => {
    upsertEntity(vault, { category: "people", name: "Ada", agent: "a", now: NOW });
    const out = runDoctor(vault);
    const all = [...out.warnings, ...out.errors];
    expect(all.filter((i) => i.code.includes("entity"))).toEqual([]);
  });

  test("duplicate identity claims surface as duplicate-entity warnings", () => {
    upsertEntity(vault, { category: "people", name: "Ada", agent: "a", now: NOW });
    entityFile("ent-people-ada-dup.md", [
      "---",
      "kind: brain-entity",
      "entity_id: ent-people-ada-dup",
      "category: people",
      "name: ADA",
      "status: active",
      "created_at: 2026-06-02T12:30:00Z",
      "updated_at: 2026-06-02T12:30:00Z",
      "---",
      "",
      "# dup",
    ]);
    const out = runDoctor(vault);
    const dup = out.warnings.filter((i) => i.code === "duplicate-entity");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.severity).toBe("warning");
    expect(dup[0]!.message).toContain("people:ada");
  });

  test("alias-merge candidate lint is off by default (byte-identical report)", () => {
    upsertEntity(vault, { category: "org", name: "Google LLC", agent: "a", now: NOW });
    upsertEntity(vault, { category: "org", name: "Google Inc", agent: "a", now: NOW });
    const out = runDoctor(vault);
    expect(
      [...out.warnings, ...out.errors].filter((i) => i.code === "entity-alias-candidate"),
    ).toEqual([]);
  });

  test("enabled: lexical variants surface as an entity-alias-candidate warning", () => {
    upsertEntity(vault, { category: "org", name: "Google LLC", agent: "a", now: NOW });
    upsertEntity(vault, { category: "org", name: "Google Inc", agent: "a", now: NOW });
    const prevEnabled = process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"];
    const prevThreshold = process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"];
    process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"] = "1";
    process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"] = "0.3";
    try {
      const cand = runDoctor(vault).warnings.filter((i) => i.code === "entity-alias-candidate");
      expect(cand).toHaveLength(1);
      expect(cand[0]!.message).toContain("[lexical");
      expect(cand[0]!.message).toContain("never auto-merged");
    } finally {
      if (prevEnabled === undefined)
        delete process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"];
      else process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"] = prevEnabled;
      if (prevThreshold === undefined)
        delete process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"];
      else process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"] = prevThreshold;
    }
  });

  test("a relation pointing at a missing entity surfaces as broken-entity-relation", () => {
    upsertEntity(vault, { category: "people", name: "Ada", agent: "a", now: NOW });
    upsertEntity(vault, { category: "projects", name: "Open Second Brain", agent: "a", now: NOW });
    relateEntities(vault, {
      from: { category: "people", query: "Ada" },
      relation: "related",
      to: { category: "projects", query: "Open Second Brain" },
      now: NOW,
    });
    // Healthy relation: no issue.
    expect(runDoctor(vault).warnings.filter((i) => i.code === "broken-entity-relation")).toEqual(
      [],
    );

    // Hand-author a relation to a non-existent entity.
    entityFile("ent-people-orphan.md", [
      "---",
      "kind: brain-entity",
      "entity_id: ent-people-orphan",
      "category: people",
      "name: Orphan Author",
      "status: active",
      "created_at: 2026-06-02T12:30:00Z",
      "updated_at: 2026-06-02T12:30:00Z",
      'related: ["[[ent-systems-ghost]]"]',
      "---",
      "",
      "# orphan",
    ]);
    const broken = runDoctor(vault).warnings.filter((i) => i.code === "broken-entity-relation");
    expect(broken).toHaveLength(1);
    expect(broken[0]!.message).toContain("ent-systems-ghost");
  });
});

describe("doctor derived-variant collisions (write-honesty-egress-consent F3/C5)", () => {
  function aliasCandidateWarnings() {
    return runDoctor(vault).warnings.filter((i) => i.code === "entity-alias-candidate");
  }

  test("a nickname derived from one person colliding with another person's name surfaces one warning", () => {
    const lovelace = person("Ada Lovelace");
    const ada = person("Ada");
    writeNicknames({ ada: ["Ada Lovelace"] });

    const warnings = aliasCandidateWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe("warning");
    // The existing alias-merge candidate shape, naming both ids.
    expect(warnings[0]!.message).toContain("possible alias-merge:");
    expect(warnings[0]!.message).toContain(lovelace);
    expect(warnings[0]!.message).toContain(ada);
    expect(warnings[0]!.message).toContain("[person-variant 1]");
    expect(warnings[0]!.message).toContain("never auto-merged");
  });

  test("a collision through a declared alias counts the same", () => {
    const lovelace = person("Ada Lovelace");
    const prime = person("Adeline Prime", { aliases: ["Ada"] });
    writeNicknames({ ada: ["Ada Lovelace"] });

    const warnings = aliasCandidateWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(lovelace);
    expect(warnings[0]!.message).toContain(prime);
  });

  test("several colliding variants of one pair still produce exactly one warning", () => {
    // Mutual: each record's declared name is the other's reversed
    // word-order variant, so both directions collide - the pair is
    // still one finding, not two.
    person("Grace Hopper");
    person("Hopper Grace");

    expect(aliasCandidateWarnings()).toHaveLength(1);
  });

  test("a variant shared as a variant is not a collision - only declared forms claim", () => {
    person("Robert Smith");
    person("Robert Jones");
    writeNicknames({ bob: ["Robert Smith", "Robert Jones"] });

    expect(aliasCandidateWarnings()).toEqual([]);
  });

  test("non-person records never collide on person variants", () => {
    upsertEntity(vault, { category: "org", name: "Ada Lovelace Ltd", agent: "a", now: NOW });
    person("Ada Lovelace");
    writeNicknames({ "ada lovelace ltd": ["Ada Lovelace"] });

    expect(aliasCandidateWarnings()).toEqual([]);
  });

  test("quarantined records are outside the collision scan", () => {
    person("Ada Lovelace");
    person("Ada", { untrusted: true });
    writeNicknames({ ada: ["Ada Lovelace"] });

    expect(aliasCandidateWarnings()).toEqual([]);
  });

  test("a malformed nickname file degrades the scan without losing the rest of the check", () => {
    person("Ada Lovelace");
    person("Ada");
    atomicWriteFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), "{ not json");

    const out = runDoctor(vault);
    expect(out.warnings.filter((i) => i.code === "entity-alias-candidate")).toEqual([]);
    // The other entity lints of the same check still ran: the registry
    // is clean apart from the two distinct persons, so nothing else
    // fires - the point is that the pass did not swallow the check.
    expect(out.warnings.filter((i) => i.code === "duplicate-entity")).toEqual([]);
  });

  test("a malformed nickname file surfaces exactly one warning naming the path", () => {
    // The read lanes degrade to their documented postures, but the
    // doctor is the surfacing point: a present-yet-unusable operator
    // file must be visible, by name.
    person("Ada Lovelace");
    person("Ada");
    atomicWriteFileSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), '{ "quoted-bytes" broken');

    const warnings = runDoctor(vault).warnings.filter(
      (i) => i.code === "person-nicknames-unreadable",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.path).toContain("person-nicknames.json");
    expect(warnings[0]!.message).toContain("person-nicknames.json");
    // The detail is short and never quotes the file bytes the parser
    // choked on: the message must not become a byte-echo channel.
    expect(warnings[0]!.message).not.toContain("quoted-bytes");
    expect(warnings[0]!.message).not.toContain("Unexpected");
  });

  test("a well-formed nickname file raises no unreadable warning", () => {
    person("Ada Lovelace");
    person("Ada");
    atomicWriteFileSync(
      join(vault, PERSON_NICKNAMES_ARTIFACT_REL),
      JSON.stringify({ ada: ["Ada Lovelace"] }),
    );
    expect(
      runDoctor(vault).warnings.filter((i) => i.code === "person-nicknames-unreadable"),
    ).toEqual([]);
  });

  test("a two-letter nickname never reads as a skip: declared nicknames are exempt from the floor", () => {
    person("Alan Lovelace");
    atomicWriteFileSync(
      join(vault, PERSON_NICKNAMES_ARTIFACT_REL),
      JSON.stringify({ al: ["Alan Lovelace"] }),
    );
    expect(
      runDoctor(vault).warnings.filter((i) => i.code === "person-nicknames-entry-skipped"),
    ).toEqual([]);
  });

  test("an entry the parser folds away surfaces once, by position", () => {
    person("Ada Lovelace");
    atomicWriteFileSync(
      join(vault, PERSON_NICKNAMES_ARTIFACT_REL),
      JSON.stringify({
        "   ": ["Ada Lovelace"],
        "no names": ["   ", ""],
        al: ["Alan Lovelace"],
        loop: ["Loop"],
      }),
    );

    const warnings = runDoctor(vault).warnings.filter(
      (i) => i.code === "person-nicknames-entry-skipped",
    );
    // Entries #1 (empty nickname), #2 (no usable value) and #4 (the
    // nickname equals the name it stands for) are each named by
    // position; #3, the usable two-letter nickname, is not a skip.
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.message).join(" ")).toContain("#1");
    expect(warnings.map((w) => w.message).join(" ")).toContain("#2");
    expect(warnings.map((w) => w.message).join(" ")).toContain("#4");
    expect(warnings.every((w) => w.severity === "warning")).toBe(true);
    for (const w of warnings) {
      expect(w.path).toContain("person-nicknames.json");
    }
  });

  test("a missing nickname file raises no skipped-entry warning", () => {
    person("Ada Lovelace");
    expect(
      runDoctor(vault).warnings.filter((i) => i.code === "person-nicknames-entry-skipped"),
    ).toEqual([]);
  });
});
