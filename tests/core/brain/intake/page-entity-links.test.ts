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
  type EntityLinkAccessor,
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

  test("a throwing accessor degrades to the partial list, not a failed page", () => {
    // PINNED, not incidental: the accessor is where withholding and
    // resolving live, and one target it raises on must cost the page
    // only THAT target - the links before it stay attached, the links
    // after it are indistinguishable from absent, and the page itself
    // never fails. If this test starts failing, someone turned a
    // resolver fault into a failed read.
    const ids = pageEntityLinks(
      [
        "- [[ent-people-ada-lovelace]] wrote the note.",
        "- [[ent-project-atlas]] funded it.",
        "- [[ent-orgs-acme]] reviewed it.",
      ].join("\n"),
      (target) => {
        if (target === "ent-people-ada-lovelace") return "ent-people-ada-lovelace";
        if (target === "ent-project-atlas") throw new Error("index exploded mid-page");
        return target === "ent-orgs-acme" ? "ent-orgs-acme" : undefined;
      },
    );
    expect(ids).toEqual(["ent-people-ada-lovelace", "ent-orgs-acme"]);
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
    // These tests run at the vault's own reach, and the resolver makes
    // that decision EXPLICIT: the predicate is a required argument, so
    // "everything counts" is written here rather than defaulted to.
    const resolve = entityLinkResolver(vault, { visible: () => true });
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
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("Ada Lovelace")).toBeUndefined();
    expect(resolve("ent-people-nobody")).toBeUndefined();
    expect(resolve("some-regular-note")).toBeUndefined();
  });

  test("the slug fold rung never folds a bare spelling into the id's slug", () => {
    // The fold is the category/slug rung: it maps each PATH SEGMENT the
    // way the anchoring kernel's separator-tolerant spelling does. Folded
    // over a bare name it would assemble the id's own slug out of
    // "People Ada Lovelace" or "people_ada_lovelace" - bare entity NAMEs,
    // which are deliberately not a rung - and resolve spellings the
    // vault's own link resolution dangles on. Case-varying a bare id
    // stays unresolved too: ids are answered case-sensitively.
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("People Ada Lovelace")).toBeUndefined();
    expect(resolve("people_ada_lovelace")).toBeUndefined();
    expect(resolve("Ent-People-Ada-Lovelace")).toBeUndefined();
    expect(resolve("people ada lovelace")).toBeUndefined();
    // The prefixed form keeps its rung, folded or not.
    expect(resolve("People/Ada Lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("PEOPLE/ADA-LOVELACE")).toBe("ent-people-ada-lovelace");
  });

  test("a directory prefix must be the page's own vault path, never a basename fallback", () => {
    // A link that carries a directory prefix names THAT page: the vault's
    // own link resolution dangles on Notes/ent-people-ada-lovelace, so
    // answering the entity by basename alone would attach an anchor the
    // link never supported. Only the entity page's real vault path - with
    // or without the .md suffix - resolves through a prefixed spelling.
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("Notes/ent-people-ada-lovelace")).toBeUndefined();
    expect(resolve("Notes/ent-people-ada-lovelace.md")).toBeUndefined();
    expect(resolve("Brain/entities/people/ent-people-ada-lovelace.md")).toBe(
      "ent-people-ada-lovelace",
    );
    expect(resolve("Brain/entities/people/ent-people-ada-lovelace")).toBe(
      "ent-people-ada-lovelace",
    );
  });

  test("an alias two visible entities claim stays unresolved instead of first-wins", () => {
    // The index refuses to answer a contested alias (duplicate-alias
    // conflicts, first claimant kept only for its own reads); a resolver
    // that answers first-wins turns an ambiguous link into a confident
    // wrong anchor. Ambiguous stays unresolved, for every claimant.
    writeEntityNode("people", "ent-people-ada-smith", "Ada Smith", ["Ada"]);
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("Ada")).toBeUndefined();
    // The contested spelling is gone; each entity's own spellings are not.
    expect(resolve("ent-people-ada-lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("ent-people-ada-smith")).toBe("ent-people-ada-smith");
  });

  test("an alias claim is counted over the visible canonical population only", () => {
    // An archived page is identical to absent here, so its claim cannot
    // make a visible entity's alias ambiguous; neither can a page the
    // visible predicate refuses.
    writeEntityNode("orgs", "ent-orgs-acme", "Acme Co", ["Shared"]);
    writeEntityNode("orgs", "ent-orgs-old", "Old Co", ["Shared"], "archived");
    writeEntityNode("orgs", "ent-orgs-hidden", "Hidden Co", ["Also Shared"]);
    writeEntityNode("orgs", "ent-orgs-visible", "Visible Co", ["Also Shared"]);
    const refused = new Set(["Brain/entities/orgs/ent-orgs-hidden.md"]);
    const resolve = entityLinkResolver(vault, {
      visible: (rel) => !refused.has(rel.split("\\").join("/")),
    });
    expect(resolve("Shared")).toBe("ent-orgs-acme");
    expect(resolve("Also Shared")).toBe("ent-orgs-visible");
  });

  test("a link target is trimmed before the rungs answer it", () => {
    // WIKILINK_TARGET_RE captures the target untrimmed, so `[[id ]]` and
    // `[[id #anchor]]` hand the resolver a trailing space; the rungs must
    // answer the target the author wrote, not the whitespace around it.
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("  ent-people-ada-lovelace  ")).toBe("ent-people-ada-lovelace");
    expect(resolve("ent-people-ada-lovelace.md ")).toBe("ent-people-ada-lovelace");
    expect(resolve(" people/ada-lovelace\t")).toBe("ent-people-ada-lovelace");
    expect(resolve(" Ada ")).toBe("ent-people-ada-lovelace");
  });

  test("the slug rung folds separator runs and case like the kernel's spellings", () => {
    // The anchoring kernel matches "ada lovelace", "ada-lovelace" and
    // "ada_lovelace" as one class at a path-segment boundary, and ids are
    // minted slugified; a slug-prefixed link spelled the way authors
    // actually write them must resolve to the id those rules mint.
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("people/Ada_Lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("People/ada lovelace")).toBe("ent-people-ada-lovelace");
    expect(resolve("people/ada--_ lovelace.md")).toBe("ent-people-ada-lovelace");
  });

  test("drops non-canonical entity pages before returning", () => {
    writeEntityNode("orgs", "ent-orgs-retired", "Retired Co", [], "archived");
    writeEntityNode("orgs", "ent-orgs-quarantined", "Quarantined Co", [], "quarantine");
    const resolve = entityLinkResolver(vault, { visible: () => true });
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
    const resolve = entityLinkResolver(vault, { visible: () => true });
    expect(resolve("ent-people-broken")).toBeUndefined();
    expect(resolve("ent-people-ada-lovelace")).toBe("ent-people-ada-lovelace");
  });

  test("the visibility predicate is a required argument, not a defaulted one", () => {
    // A forgotten predicate must be a TYPE error at the call site, never
    // a silent decision that every canonical-scope entity - private
    // pages included - may be named in an anchor list. The bad call sits
    // in a function the runtime never invokes: the assertion is tsc's,
    // not bun's.
    const resolveWith = entityLinkResolver;
    const forgets = (): EntityLinkAccessor =>
      // @ts-expect-error - omitting `visible` refuses to compile
      resolveWith(vault);
    expect(typeof forgets).toBe("function");
  });
});
