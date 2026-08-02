/**
 * The polarity of the intake trust decision (provenance-at-the-boundary).
 *
 * `classifySourceTrust` originally answered "is this identity provably
 * OUTSIDE the vault?" and called everything else trusted, so a source
 * identity that established nothing at all - a bare host such as
 * `evil.com/article`, an address with the scheme dropped - entered as if the
 * operator had written it. The polarity here is the other way round: an
 * identity is trusted only when its SHAPE is that of a location inside this
 * vault, and every identity the shape cannot establish is untrusted.
 *
 * The same seam had the mirrored defect. `hasUriScheme` is written for
 * markdown link targets, where a colon can only be a scheme; a filename is a
 * different domain, and this project's own vault names notes like
 * `Meeting: Q3 planning.md`. Reused unguarded it read that colon as a scheme
 * and quarantined a note the operator wrote - damage that is one-way, since
 * the record then leaves every ordinary read and only an explicit release
 * brings it back. So the two failures a source identity can have are kept
 * apart: an identity that names something external, and an identity that
 * cannot be established at all. The first is a lane; the second is a
 * question for whoever named it.
 *
 * The MCP-boundary cases live here rather than under `tests/mcp/` because
 * they are the same decision as the classifier cases below it - the tool is
 * the surface where "no source was named at all" can still be handed back to
 * the caller with an exit, and testing it apart from the classifier would
 * split one rule across two files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { getEntity, listEntities } from "../../../../src/core/brain/entities/registry.ts";
import { BRAIN_ENTITY_STATUS } from "../../../../src/core/brain/entities/types.ts";
import { intakeExtraction } from "../../../../src/core/brain/intake/extract-intake.ts";
import { classifySourceTrust } from "../../../../src/core/brain/intake/source-trust.ts";
import { INTAKE_TRUST } from "../../../../src/core/brain/trust/untrusted-provenance.ts";
import { NER_TOOLS } from "../../../../src/mcp/brain/ner-tools.ts";
import { MCPError } from "../../../../src/mcp/protocol.ts";
import type { ServerContext } from "../../../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

const NOW = new Date("2026-06-13T12:00:00Z");
const EXTRACTION = { entities: [{ category: "concept", name: "Restaking" }] };
/** A note name this project's own vault conventions produce. */
const COLON_NOTE = "Meeting: Q3 planning.md";

const handler = NER_TOOLS[0]!.handler;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-polarity-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-polarity-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("classifySourceTrust - an identity that establishes nothing is not trusted", () => {
  test("a bare host, with or without a path, is untrusted", () => {
    for (const source of [
      "evil.com/article",
      "www.example.com/x",
      "example.com",
      "example.co.uk/posts/1",
      "[[evil.com/article]]",
    ]) {
      expect(classifySourceTrust(vault, source)).toBe(INTAKE_TRUST.untrusted);
    }
  });

  test("a scheme in front of a note-shaped path does not buy trust", () => {
    for (const source of ["file:/etc/passwd.md", "https://example.com/a.md", "//evil.com/x.md"]) {
      expect(classifySourceTrust(vault, source)).toBe(INTAKE_TRUST.untrusted);
    }
  });
});

describe("classifySourceTrust - a colon in a filename is not a scheme", () => {
  test("a vault note whose name carries a colon stays trusted", () => {
    for (const source of [
      COLON_NOTE,
      `[[${COLON_NOTE}]]`,
      "Meetings/Meeting: Q3 planning.md",
      "Meetings/Q3: planning/notes.md",
    ]) {
      expect(classifySourceTrust(vault, source)).toBe(INTAKE_TRUST.trusted);
    }
  });

  test("the ordinary vault-relative identities are unchanged", () => {
    for (const source of [
      "Articles/primer.md",
      "notes/deep/nested.md",
      "Code/widget.ts",
      "readme.md",
    ]) {
      expect(classifySourceTrust(vault, source)).toBe(INTAKE_TRUST.trusted);
    }
  });
});

describe("intakeExtraction derives trust from the source it was given", () => {
  test("a cited source outside the vault quarantines even when no trust is declared", () => {
    intakeExtraction(vault, EXTRACTION, {
      agent: "claude",
      now: NOW,
      provenance: { level: "stated", sources: ["[[evil.com/article]]"], premises: [] },
    });
    expect(getEntity(vault, { category: "concept", query: "Restaking" })).toBeNull();
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("one untrusted source among several makes the whole intake untrusted", () => {
    intakeExtraction(vault, EXTRACTION, {
      agent: "claude",
      now: NOW,
      provenance: {
        level: "stated",
        sources: ["[[Articles/primer.md]]", "[[https://example.com/a]]"],
        premises: [],
      },
    });
    expect(getEntity(vault, { category: "concept", query: "Restaking" })).toBeNull();
  });

  test("a declared trust still wins over the derivation", () => {
    intakeExtraction(vault, EXTRACTION, {
      agent: "claude",
      now: NOW,
      provenance: { level: "stated", sources: ["[[evil.com/article]]"], premises: [] },
      trust: INTAKE_TRUST.trusted,
    });
    expect(getEntity(vault, { category: "concept", query: "Restaking" })).not.toBeNull();
  });
});

describe("brain_intake_entities - the boundary that can still ask", () => {
  test("naming no source at all is refused with an exit, and writes nothing", async () => {
    await expect(
      handler(ctx, { entities: [{ category: "concept", name: "Layer 2s" }] }),
    ).rejects.toThrow(MCPError);
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(0);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("a source with the scheme dropped lands in quarantine, not in the registry", async () => {
    await handler(ctx, {
      entities: [{ category: "concept", name: "Layer 2s" }],
      source: "evil.com/article",
    });
    expect(getEntity(vault, { category: "concept", query: "Layer 2s" })).toBeNull();
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("a vault note whose name carries a colon is not quarantined", async () => {
    await handler(ctx, {
      entities: [{ category: "concept", name: "Layer 2s" }],
      source: `[[${COLON_NOTE}]]`,
    });
    expect(getEntity(vault, { category: "concept", query: "Layer 2s" })).not.toBeNull();
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(0);
  });
});
