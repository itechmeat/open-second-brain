/**
 * Page-link to entity resolver (note-change truth maintenance, F4/C1):
 * the ordered canonical entity ids a source page links to, resolved
 * server-side through an injected accessor so the mapping stays
 * testable without a real index. Withheld entity pages are dropped
 * BEFORE returning (the link-candidates precedent: identical to
 * absent), and a page whose links resolve to nothing answers an empty
 * list, never a throw.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import {
  entityLinkResolver,
  pageEntityLinks,
} from "../../../../src/core/brain/intake/page-entity-links.ts";
import { __clearEntityIndexCache } from "../../../../src/core/brain/entities/index-builder.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-links-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-page-links-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  __clearEntityIndexCache();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityIndexCache();
});

function writeEntityNode(
  category: string,
  id: string,
  name: string,
  aliases: ReadonlyArray<string> = [],
  status = "active",
): void {
  const dir = join(brainDirs(vault).entities, category);
  mkdirSync(dir, { recursive: true });
  writeFrontmatterAtomic(
    join(dir, `${id}.md`),
    {
      kind: "brain-entity",
      entity_id: id,
      category,
      name,
      ...(aliases.length > 0 ? { aliases: [...aliases] } : {}),
      status,
      created_at: "2026-10-19T00:00:00Z",
      updated_at: "2026-10-19T00:00:00Z",
      tags: ["brain", "brain/entity"],
    },
    `# ${name}`,
    { overwrite: true },
  );
  __clearEntityIndexCache();
}

describe("pageEntityLinks", () => {
  test("returns the linked canonical entity ids in body order, deduped across spellings", () => {
    const ids = pageEntityLinks(
      [
        "Intro prose.",
        "",
        "- [[ent-people-ada-lovelace]] wrote the note.",
        "- See [[ent-project-atlas]] and [[Ada]] again; [[ent-people-ada-lovelace|her page]].",
      ].join("\n"),
      (target) =>
        target === "ent-people-ada-lovelace" || target === "Ada"
          ? "ent-people-ada-lovelace"
          : target === "ent-project-atlas"
            ? "ent-project-atlas"
            : undefined,
    );
    expect(ids).toEqual(["ent-people-ada-lovelace", "ent-project-atlas"]);
  });

  test("answers empty when nothing resolves, and never throws on a failing accessor", () => {
    expect(pageEntityLinks("No links here at all.", () => undefined)).toEqual([]);
    expect(
      pageEntityLinks("- [[ent-people-ada-lovelace]]", () => {
        throw new Error("index exploded");
      }),
    ).toEqual([]);
  });

  test("skips media and code regions the wikilink extractor skips", () => {
    const ids = pageEntityLinks(
      ["![[ent-people-ada-lovelace.png]]", "`[[ent-project-atlas]]`", "[[ent-orgs-acme]]"].join(
        "\n",
      ),
      (target) => (target === "ent-orgs-acme" ? "ent-orgs-acme" : undefined),
    );
    expect(ids).toEqual(["ent-orgs-acme"]);
  });
});

describe("entityLinkResolver", () => {
  beforeEach(() => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace", ["Ada"]);
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
  });

  test("resolves the id, .md, path, slug-prefixed and alias spellings", () => {
    const resolve = entityLinkResolver(vault);
    expect(resolve("ent-people-ada-lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("ent-people-ada-lovelace.md")).toBe("ent-people-ada-lovelace");
    expect(resolve("Brain/entities/people/ent-people-ada-lovelace.md")).toBe(
      "ent-people-ada-lovelace",
    );
    expect(resolve("people/ada-lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("Ada")).toBe("ent-people-ada-lovelace");
    expect(resolve("ent-project-atlas")).toBe("ent-project-atlas");
  });

  test("leaves bare names, unknown targets and non-entity notes unresolved", () => {
    const resolve = entityLinkResolver(vault);
    expect(resolve("Ada Lovelace")).toBeUndefined();
    expect(resolve("ent-people-nobody")).toBeUndefined();
    expect(resolve("some-regular-note")).toBeUndefined();
  });

  test("drops non-canonical entity pages before returning", () => {
    writeEntityNode("orgs", "ent-orgs-retired", "Retired Co", [], "archived");
    writeEntityNode("orgs", "ent-orgs-quarantined", "Quarantined Co", [], "quarantine");
    const resolve = entityLinkResolver(vault);
    expect(resolve("ent-orgs-retired")).toBeUndefined();
    expect(resolve("ent-orgs-quarantined")).toBeUndefined();
    expect(resolve("orgs/retired-co")).toBeUndefined();
  });

  test("a page the visible predicate refuses is identical to absent", () => {
    const refused = new Set(["Brain/entities/people/ent-people-ada-lovelace.md"]);
    const resolve = entityLinkResolver(vault, {
      visible: (rel) => !refused.has(rel.split("\\").join("/")),
    });
    expect(resolve("ent-people-ada-lovelace")).toBeUndefined();
    expect(resolve("Ada")).toBeUndefined();
    expect(resolve("ent-project-atlas")).toBe("ent-project-atlas");
  });

  test("a malformed entity file is skipped and the rest of the index still resolves", () => {
    const broken = join(vault, "Brain", "entities", "people");
    writeFileSync(join(broken, "ent-people-broken.md"), "this is not frontmatter at all", "utf8");
    __clearEntityIndexCache();
    const resolve = entityLinkResolver(vault);
    expect(resolve("ent-people-broken")).toBeUndefined();
    expect(resolve("ent-people-ada-lovelace")).toBe("ent-people-ada-lovelace");
  });
});
