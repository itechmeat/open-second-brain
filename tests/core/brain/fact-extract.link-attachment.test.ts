/**
 * Link-derived fact attachment (note-change truth maintenance, F4/C2):
 * a page-sourced capture resolves the source page's outbound links to
 * canonical entity ids server-side and hands them to the extraction call
 * through ONE optional parameter. The persisted `entities:` union carries
 * the text-derived anchors AND the link-derived ones, the first
 * body-order link leading when both mechanisms match, and a capture that
 * passes nothing - every session-sourced caller - is byte-identical to
 * before the parameter existed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { __clearEntityIndexCache } from "../../../src/core/brain/entities/index-builder.ts";
import { routeExtractedFacts, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import {
  entityLinkResolver,
  pageEntityLinks,
} from "../../../src/core/brain/intake/page-entity-links.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-10-19T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-link-attach-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-link-attach-cfg-"));
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
      status: "active",
      created_at: "2026-10-19T00:00:00Z",
      updated_at: "2026-10-19T00:00:00Z",
      tags: ["brain", "brain/entity"],
    },
    `# ${name}`,
    { overwrite: true },
  );
  __clearEntityIndexCache();
}

/** Write a source page into the vault and resolve its links the way a
 * page-sourced caller does: server-side, in first-occurrence order. The
 * `visible` predicate is the resolver's REQUIRED argument - these
 * fixtures run at the vault's own reach, and say so here rather than
 * letting a default decide. */
function resolveSourcePageLinks(rel: string, body: string): string[] {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return pageEntityLinks(body, entityLinkResolver(vault, { visible: () => true }));
}

function entitiesLineOfBody(body: string): string | undefined {
  return body.split(/\r?\n/).find((line) => line.startsWith("entities: "));
}

function capture(
  facts: ReadonlyArray<ExtractedFact>,
  linkDerivedEntityIds?: ReadonlyArray<string>,
) {
  const dedup = new Map<string, DedupIndexEntry>();
  return routeExtractedFacts(vault, {
    facts,
    agent: "claude-dev-agent",
    now: NOW,
    sessionRef: "session#turn-1",
    dedup,
    ambientWriteback: true,
    ambientTtlDays: 0,
    writeApprovalEnabled: false,
    durabilityDenylist: [],
    ...(linkDerivedEntityIds !== undefined ? { linkDerivedEntityIds } : {}),
  });
}

function inboxSignalBodies(): string[] {
  const dir = brainDirs(vault).inbox;
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith("sig-") && f.endsWith(".md"))
        .map((f) => readFileSync(join(dir, f), "utf8"))
    : [];
}

describe("routeExtractedFacts link-derived attachment (F4/C2)", () => {
  test("a fact from a page linking an entity without naming it gains the anchor", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    const linkDerived = resolveSourcePageLinks(
      "notes/meeting.md",
      "# Meeting\n\n- [[ent-people-ada-lovelace]] joined the review.\n",
    );
    expect(linkDerived).toEqual(["ent-people-ada-lovelace"]);

    const result = capture(
      [{ family: "quantity", text: "the review concluded with five follow-ups", line: 1 }],
      linkDerived,
    );

    expect(result.created).toBe(1);
    const bodies = inboxSignalBodies();
    expect(bodies).toHaveLength(1);
    expect(entitiesLineOfBody(bodies[0]!)).toBe("entities: ent-people-ada-lovelace");
  });

  test("the first body-order link is the primary when both mechanisms match", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");
    // Body order: Ada's link comes first, so Ada leads the persisted union
    // even though the fact's own text names Atlas - and Atlas, matched by
    // BOTH mechanisms, is carried once.
    const linkDerived = resolveSourcePageLinks(
      "notes/meeting.md",
      ["# Meeting", "", "- [[ent-people-ada-lovelace]] presented.", "- [[ent-project-atlas]]"].join(
        "\n",
      ),
    );
    expect(linkDerived).toEqual(["ent-people-ada-lovelace", "ent-project-atlas"]);

    const result = capture(
      [{ family: "quantity", text: "atlas prime shipped five units", line: 1 }],
      linkDerived,
    );

    expect(result.created).toBe(1);
    const body = inboxSignalBodies()[0]!;
    expect(entitiesLineOfBody(body)).toBe("entities: ent-people-ada-lovelace, ent-project-atlas");
  });

  test("session-sourced extraction passes nothing and is behavior-identical", () => {
    writeEntityNode("project", "ent-project-atlas", "Atlas Prime");

    // A fact that names an entity anchors exactly as before...
    const named = capture([
      { family: "quantity", text: "atlas prime shipped five units", line: 1 },
    ]);
    expect(named.created).toBe(1);
    expect(entitiesLineOfBody(inboxSignalBodies()[0]!)).toBe("entities: ent-project-atlas");

    // ...and a fact that names nothing persists no anchor line at all.
    const unnamed = capture([
      { family: "quantity", text: "the review concluded with five follow-ups", line: 1 },
    ]);
    expect(unnamed.created).toBe(1);
    const bodies = inboxSignalBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((b) => entitiesLineOfBody(b) === undefined)).toHaveLength(1);
    expect(bodies.filter((b) => entitiesLineOfBody(b) !== undefined)).toHaveLength(1);
  });

  test("an empty link-derived list behaves exactly like passing nothing", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    const result = capture(
      [{ family: "quantity", text: "the review concluded with five follow-ups", line: 1 }],
      [],
    );
    expect(result.created).toBe(1);
    expect(inboxSignalBodies().every((b) => !b.includes("ent-people-ada-lovelace"))).toBe(true);
  });

  test("a dry run stays a rehearsal: link-derived ids forecast nothing and write nothing", () => {
    writeEntityNode("people", "ent-people-ada-lovelace", "Ada Lovelace");
    const dedup = new Map<string, DedupIndexEntry>();
    const result = routeExtractedFacts(vault, {
      facts: [{ family: "quantity", text: "the review concluded with five follow-ups", line: 1 }],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-2",
      dedup,
      dryRun: true,
      ambientWriteback: true,
      ambientTtlDays: 0,
      writeApprovalEnabled: false,
      durabilityDenylist: [],
      linkDerivedEntityIds: ["ent-people-ada-lovelace"],
    });
    expect(result).toEqual({
      created: 0,
      withheld: 1,
      deduped: 0,
      durabilityRejected: 0,
      ambientWithheld: 0,
    });
    expect(inboxSignalBodies()).toEqual([]);
  });
});
