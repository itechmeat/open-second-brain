/**
 * Response-shape validation at the ingress of the three model-authored write
 * paths (signals-that-survive, unit 8, t_80b01448): source distillation,
 * fact derivation, and research synthesis.
 *
 * Every case here asserts the same contract from a different angle: the
 * payload is checked against its frozen descriptor BEFORE any normalization,
 * a violation is a named error rather than a coercion, and nothing at all is
 * written when any item of a batch is malformed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  BRAIN_DISTILLATIONS_REL,
  BRAIN_REPORTS_REL,
  brainConfigPath,
} from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import {
  ResponseShapeError,
  SHAPE_VIOLATION_CODES,
} from "../../../src/core/brain/response-shape.ts";
import { parseDistillClaims } from "../../../src/core/brain/distill/distill-source.ts";
import { parseDeriveFactInput } from "../../../src/core/brain/derived-fact.ts";
import { parseResearchReportInput } from "../../../src/core/brain/research/research.ts";
import { DISTILL_TOOLS } from "../../../src/mcp/brain/distill-tools.ts";
import { DERIVE_TOOLS } from "../../../src/mcp/brain/derive-tools.ts";
import { RESEARCH_TOOLS } from "../../../src/mcp/brain/research-tools.ts";
import { MCPError } from "../../../src/mcp/protocol.ts";
import type { ServerContext } from "../../../src/mcp/tool-contract.ts";

let vault: string;
let configHome: string;
let ctx: ServerContext;

const distillHandler = DISTILL_TOOLS[0]!.handler;
const deriveHandler = DERIVE_TOOLS[0]!.handler;
const researchHandler = RESEARCH_TOOLS[0]!.handler;

const SOURCE_PATH = "Articles/src.md";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-response-shape-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-response-shape-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Articles"), { recursive: true });
  writeFileSync(join(vault, SOURCE_PATH), "# Src\n\nBody.\n", "utf8");
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Vault-relative directory listing, empty when the directory was never made. */
function listing(relativeDir: string): string[] {
  const abs = join(vault, relativeDir);
  return existsSync(abs) ? readdirSync(abs) : [];
}

function enableDerivation(): void {
  writeFileSync(
    brainConfigPath(vault),
    "schema_version: 1\nguardrails:\n  derived_fact_synthesis: true\n",
  );
}

function seedPremise(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `premise ${slug}`,
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-07-01T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
  });
}

describe("distill claims ingress", () => {
  test("a non-string claim text is a shape violation, never coerced to empty text", () => {
    let caught: unknown;
    try {
      parseDistillClaims([{ text: "first" }, { text: 42 }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    const err = caught as ResponseShapeError;
    expect(err.code).toBe(SHAPE_VIOLATION_CODES.typeMismatch);
    expect(err.path).toBe("$[1].text");
  });

  test("a conforming payload normalizes as before", () => {
    expect(parseDistillClaims([{ text: "a", block: "^abc" }, { text: "b" }])).toEqual([
      { text: "a", block: "abc" },
      { text: "b" },
    ]);
  });

  test("a malformed third claim writes nothing at all", async () => {
    await expect(
      distillHandler(ctx, {
        source_path: SOURCE_PATH,
        claims: [{ text: "one" }, { text: "two" }, { block: "^abc" }, { text: "four" }],
      }),
    ).rejects.toThrow(MCPError);
    expect(listing(BRAIN_DISTILLATIONS_REL)).toEqual([]);
  });

  test("a well-formed batch still writes its page", async () => {
    const res = (await distillHandler(ctx, {
      source_path: SOURCE_PATH,
      claims: [{ text: "one" }, { text: "two", block: "^abc" }],
    })) as { claim_count: number };
    expect(res.claim_count).toBe(2);
    expect(listing(BRAIN_DISTILLATIONS_REL)).toHaveLength(1);
  });
});

describe("derived-fact ingress", () => {
  const INPUT = {
    slug: "derived-1",
    topic: "derived",
    principle: "Therefore C",
    premises: ["pref-a"],
    level: "deduced",
  };

  test("a non-string premise is a shape violation naming its index", () => {
    let caught: unknown;
    try {
      parseDeriveFactInput({ ...INPUT, premises: ["pref-a", 7] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    expect((caught as ResponseShapeError).path).toBe("$.premises[1]");
  });

  test("a missing required key is refused before the premise lookup", () => {
    let caught: unknown;
    try {
      parseDeriveFactInput({ topic: "t", principle: "p", premises: ["pref-a"], level: "deduced" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    expect((caught as ResponseShapeError).code).toBe(SHAPE_VIOLATION_CODES.missingProperty);
  });

  test("a malformed payload writes no preference", async () => {
    seedPremise("a");
    enableDerivation();
    await expect(deriveHandler(ctx, { ...INPUT, premises: [{ id: "pref-a" }] })).rejects.toThrow(
      MCPError,
    );
    expect(existsSync(join(vault, "Brain", "preferences", "pref-derived-1.md"))).toBe(false);
  });

  test("a conforming payload still commits the derived fact", async () => {
    seedPremise("a");
    enableDerivation();
    const res = await deriveHandler(ctx, INPUT);
    expect(res).toMatchObject({ id: "pref-derived-1", level: "deduced" });
  });
});

describe("research-report ingress", () => {
  const INPUT = {
    title: "Survey",
    sources: ["Articles/src.md"],
    findings: [{ statement: "A point", sources: ["Articles/src.md"] }],
  };

  test("a finding missing its citation key is a shape violation", () => {
    let caught: unknown;
    try {
      parseResearchReportInput({ ...INPUT, findings: [{ statement: "uncited" }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    const err = caught as ResponseShapeError;
    expect(err.code).toBe(SHAPE_VIOLATION_CODES.missingProperty);
    expect(err.path).toBe("$.findings[0]");
  });

  test("a malformed third finding writes nothing at all", async () => {
    await expect(
      researchHandler(ctx, {
        ...INPUT,
        findings: [
          { statement: "one", sources: ["Articles/src.md"] },
          { statement: "two", sources: ["Articles/src.md"] },
          { statement: "three", sources: "Articles/src.md" },
        ],
      }),
    ).rejects.toThrow(MCPError);
    expect(listing(BRAIN_REPORTS_REL)).toEqual([]);
  });

  test("a well-formed report still lands", async () => {
    const res = (await researchHandler(ctx, INPUT)) as { finding_count: number };
    expect(res.finding_count).toBe(1);
    expect(listing(BRAIN_REPORTS_REL)).toHaveLength(1);
  });

  const BLANK_CITATION = {
    title: "Empty citation",
    sources: ["", "  "],
    findings: [{ statement: "claim with a blank citation", sources: [""] }],
  };

  test("a blank source is refused: nothing can satisfy the citation contract", () => {
    // A blank source is a member of the consulted set, so a finding citing it
    // passes the "no uncited claims" check against nothing at all.
    let caught: unknown;
    try {
      parseResearchReportInput(BLANK_CITATION);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    const err = caught as ResponseShapeError;
    expect(err.code).toBe(SHAPE_VIOLATION_CODES.blankString);
    expect(err.path).toBe("$.sources[0]");
    expect(err.message).toContain("must be a non-empty string");
  });

  test("the blank-citation report is never written", async () => {
    await expect(researchHandler(ctx, BLANK_CITATION)).rejects.toThrow(MCPError);
    expect(listing(BRAIN_REPORTS_REL)).toEqual([]);
  });

  test("a blank title or finding statement is refused by path", () => {
    const blankTitle = (() => {
      try {
        parseResearchReportInput({ ...INPUT, title: "  " });
      } catch (err) {
        return err as ResponseShapeError;
      }
      return null;
    })();
    expect(blankTitle?.path).toBe("$.title");

    const blankStatement = (() => {
      try {
        parseResearchReportInput({
          ...INPUT,
          findings: [{ statement: "", sources: ["Articles/src.md"] }],
        });
      } catch (err) {
        return err as ResponseShapeError;
      }
      return null;
    })();
    expect(blankStatement?.path).toBe("$.findings[0].statement");
    expect(blankStatement?.code).toBe(SHAPE_VIOLATION_CODES.blankString);
  });
});

/**
 * The audit the research-report fix demanded of the other two descriptors:
 * neither one expresses non-blankness, and neither one needs to, because the
 * write path itself refuses blank content by name before writing anything.
 * These cases hold that conclusion to the behaviour rather than to prose.
 */
describe("blank content never reaches a page", () => {
  test("a blank claim text aborts the distillation", async () => {
    await expect(
      distillHandler(ctx, { source_path: SOURCE_PATH, claims: [{ text: "one" }, { text: "  " }] }),
    ).rejects.toThrow(MCPError);
    expect(listing(BRAIN_DISTILLATIONS_REL)).toEqual([]);
  });

  test("an empty claim list aborts the distillation", async () => {
    await expect(distillHandler(ctx, { source_path: SOURCE_PATH, claims: [] })).rejects.toThrow(
      MCPError,
    );
    expect(listing(BRAIN_DISTILLATIONS_REL)).toEqual([]);
  });

  test("a blank slug, principle or premise aborts the derivation", async () => {
    seedPremise("a");
    enableDerivation();
    const base = {
      slug: "derived-1",
      topic: "derived",
      principle: "Therefore C",
      premises: ["pref-a"],
      level: "deduced",
    };
    const blanks = [{ slug: " " }, { principle: "" }, { premises: ["  "] }, { level: "" }];
    const outcomes = await Promise.allSettled(
      blanks.map((blank) => deriveHandler(ctx, { ...base, ...blank })),
    );
    outcomes.forEach((outcome, i) => {
      expect(outcome.status, JSON.stringify(blanks[i])).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(MCPError);
    });
    expect(existsSync(join(vault, "Brain", "preferences", "pref-derived-1.md"))).toBe(false);
  });
});

describe("validation is unconditional", () => {
  test("no configuration key turns the shape check off", async () => {
    // Every plausible opt-out spelling, set to the most permissive value a
    // caller could hope for. None of them is read: the check still fires.
    writeFileSync(
      brainConfigPath(vault),
      [
        "schema_version: 1",
        "response_shape: false",
        "response_shape_enabled: false",
        "response_shape_strict: false",
        "guardrails:",
        "  derived_fact_synthesis: true",
        "  response_shape_validation: false",
        "",
      ].join("\n"),
    );
    await expect(
      distillHandler(ctx, { source_path: SOURCE_PATH, claims: [{ text: 1 }] }),
    ).rejects.toThrow(MCPError);
    expect(listing(BRAIN_DISTILLATIONS_REL)).toEqual([]);
    await expect(
      researchHandler(ctx, { title: "Survey", sources: ["Articles/src.md"], findings: [{}] }),
    ).rejects.toThrow(MCPError);
    expect(listing(BRAIN_REPORTS_REL)).toEqual([]);
  });
});
