/**
 * Routing coverage for the two capture marker kinds added by "signals
 * that survive" unit 7.
 *
 * A `@osb fact` marker lands as an UNCONFIRMED preference through the
 * existing derive-fact path; a `@osb skill` marker lands in the PENDING
 * skill-proposal queue and never in accepted. Both destinations already
 * carry their own review gate, so nothing here asserts new gating - it
 * asserts the marker reaches the gated store, that a failure is named
 * rather than dropped, and that a second scan over the same file is a
 * no-op.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { scanInline } from "../../../src/core/brain/inline-scan.ts";
import { brainDirs, preferencePath } from "../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { deriveFact } from "../../../src/core/brain/derived-fact.ts";
import {
  acceptSkillProposal,
  listPendingSkillProposals,
  rejectSkillProposal,
} from "../../../src/core/brain/skill-proposals.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;

const NOW = new Date("2026-07-27T09:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-marker-routing-"));
  const dirs = brainDirs(vault);
  for (const dir of [
    dirs.brain,
    dirs.inbox,
    dirs.processed,
    dirs.preferences,
    dirs.retired,
    dirs.log,
    dirs.snapshots,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(
    join(dirs.brain, "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}\nnotes:\n  read_paths:\n    - Daily\n`,
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, content: string): string {
  const path = join(vault, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteFileSync(path, content);
  return path;
}

function seedPremise(slug: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `premise ${slug}`,
    created_at: "2026-07-01T00:00:00Z",
    unconfirmed_until: "2026-08-01T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
  });
}

function acceptedProposalCount(): number {
  const dir = join(vault, "Brain", "skill-proposals", "accepted");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
}

describe("fact markers route to an unconfirmed preference", () => {
  test("a complete fact marker writes the preference and consumes the marker", async () => {
    seedPremise("gate-green");
    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb fact topic="deploy gate" principle="ship only when the gate is green" premise=gate-green level=deduced\n`,
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.errors).toEqual([]);
    expect(result.facts).toBe(1);

    const path = preferencePath(vault, "deploy-gate");
    expect(existsSync(path)).toBe(true);
    const pref = parsePreference(path);
    expect(pref.status).toBe("unconfirmed");
    expect(pref.topic).toBe("deploy gate");
    expect(pref.evidenced_by).toEqual(["[[pref-gate-green]]"]);

    expect(readFileSync(note, "utf8")).toContain("@osb✓ [[pref-deploy-gate]]");
  });

  test("an unresolvable premise is an explicit named error and writes nothing", async () => {
    writeNote("Daily/2026-07-27.md", `@osb fact topic=t principle=p premise=nope level=deduced\n`);

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.facts).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("nope");
    expect(existsSync(preferencePath(vault, "t"))).toBe(false);
  });

  test("a missing required field is reported as an error naming the field", async () => {
    const note = writeNote("Daily/2026-07-27.md", `@osb fact topic=t principle=p premise=x\n`);

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.facts).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("level");
    // Unconsumed: an operator can fix the marker and rescan.
    expect(readFileSync(note, "utf8")).not.toContain("@osb✓");
  });

  test("a block fact marker routes exactly like the inline shape", async () => {
    seedPremise("gate-green");
    writeNote(
      "Daily/2026-07-27.md",
      [
        "```osb",
        "kind: fact",
        "topic: block fact",
        "principle: derived from the gate rule",
        "premise: gate-green",
        "level: inferred",
        "```",
        "",
      ].join("\n"),
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.errors).toEqual([]);
    expect(result.facts).toBe(1);
    expect(existsSync(preferencePath(vault, "block-fact"))).toBe(true);
  });
});

describe("skill markers route to the pending proposal queue", () => {
  test("a complete skill marker drafts a pending proposal and never an accepted one", async () => {
    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb skill name="release check" body="run the suite, then the linter"\n`,
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.errors).toEqual([]);
    expect(result.skills).toBe(1);

    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);
    expect(pending[0]!.patternKind).toBe("declared_marker");
    expect(pending[0]!.status).toBe("pending");
    expect(acceptedProposalCount()).toBe(0);

    expect(readFileSync(note, "utf8")).toContain(`@osb✓ [[${pending[0]!.id}]]`);
  });

  test("a block skill marker carries its multi-line body into the proposal", async () => {
    writeNote(
      "Daily/2026-07-27.md",
      [
        "```osb",
        "kind: skill",
        "name: release check",
        "body: |",
        "  run the suite",
        "  then the linter",
        "```",
        "",
      ].join("\n"),
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });
    expect(result.skills).toBe(1);

    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);
    const body = readFileSync(
      join(vault, "Brain", "skill-proposals", "pending", `prop-${pending[0]!.slug}.md`),
      "utf8",
    );
    expect(body).toContain("## Suggested skill body");
    expect(body).toContain("run the suite");
    expect(body).toContain("then the linter");
  });

  test("a missing required field is reported as an error naming the field", async () => {
    writeNote("Daily/2026-07-27.md", `@osb skill name="release check"\n`);

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.skills).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("body");
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });

  test("two declarations of the same skill name yield one proposal, both consumed", async () => {
    const note = writeNote(
      "Daily/2026-07-27.md",
      [
        `@osb skill name="release check" body="run the suite"`,
        `@osb skill name="Release Check" body="run the suite, then the linter"`,
        "",
      ].join("\n"),
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.errors).toEqual([]);
    // One draft was created; the second declaration resolved to it.
    expect(result.skills).toBe(1);
    const pending = listPendingSkillProposals(vault);
    expect(pending.length).toBe(1);
    const after = readFileSync(note, "utf8");
    expect(after.split(`@osb✓ [[${pending[0]!.id}]]`).length - 1).toBe(2);
  });
});

describe("a destination that refuses a marker leaves it live and says why", () => {
  test("a fact whose topic collides with an existing preference is an explicit error", async () => {
    seedPremise("gate-green");
    seedPremise("deploy-gate");
    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb fact topic="deploy gate" principle="ship only when green" premise=gate-green level=deduced\n`,
    );
    const before = readFileSync(preferencePath(vault, "deploy-gate"), "utf8");

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.facts).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("fact marker at line 1 was refused");
    // The existing rule is untouched and the marker stays live for a retry.
    expect(readFileSync(preferencePath(vault, "deploy-gate"), "utf8")).toBe(before);
    expect(readFileSync(note, "utf8")).not.toContain("@osb✓");
  });
});

describe("re-running the scan is idempotent for the new kinds", () => {
  test("a second scan over the same file writes nothing more", async () => {
    seedPremise("gate-green");
    const note = writeNote(
      "Daily/2026-07-27.md",
      [
        `@osb fact topic="deploy gate" principle="ship only when green" premise=gate-green level=deduced`,
        `@osb skill name="release check" body="run the suite"`,
        "",
      ].join("\n"),
    );

    const first = await scanInline(vault, { agent: "tester", now: NOW });
    expect(first.facts).toBe(1);
    expect(first.skills).toBe(1);
    const afterFirst = readFileSync(note, "utf8");

    const second = await scanInline(vault, { agent: "tester", now: NOW });
    expect(second.facts).toBe(0);
    expect(second.skills).toBe(0);
    expect(second.errors).toEqual([]);
    expect(readFileSync(note, "utf8")).toBe(afterFirst);
    expect(listPendingSkillProposals(vault).length).toBe(1);
    expect(readdirSync(brainDirs(vault).preferences).filter((n) => n.endsWith(".md")).length).toBe(
      2,
    );
  });
});

describe("a file with no markers of the new kinds is untouched by the new routing", () => {
  test("a feedback-only file still produces exactly one signal and nothing else", async () => {
    const note = writeNote(
      "Daily/2026-07-27.md",
      "@osb feedback negative topic=mocking principle=no-db-mocks\n",
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.created).toBe(1);
    expect(result.found).toBe(1);
    expect(result.facts).toBe(0);
    expect(result.skills).toBe(0);
    expect(result.errors).toEqual([]);
    expect(readFileSync(note, "utf8")).toContain("@osb✓ [[sig-");
    expect(readdirSync(brainDirs(vault).preferences).filter((n) => n.endsWith(".md")).length).toBe(
      0,
    );
    expect(listPendingSkillProposals(vault).length).toBe(0);
    expect(acceptedProposalCount()).toBe(0);
  });
});

describe("a dry run previews the routed kinds instead of hiding them", () => {
  test("routed markers are counted and reported, and nothing is written", async () => {
    seedPremise("gate-green");
    const note = writeNote(
      "Daily/2026-07-27.md",
      [
        `@osb fact topic="deploy gate" principle="ship only when green" premise=gate-green level=deduced`,
        `@osb skill name="release check" body="run the suite"`,
        "",
      ].join("\n"),
    );
    const before = readFileSync(note, "utf8");

    const dry = await scanInline(vault, { agent: "tester", now: NOW, dryRun: true });

    expect(dry.facts).toBe(1);
    expect(dry.skills).toBe(1);
    expect(dry.found).toBe(2);
    expect(dry.filesWithMarkers).toEqual([{ path: note, markers: 2 }]);
    expect(dry.errors).toEqual([]);

    // Nothing on disk moved: no preference, no proposal, no rewrite.
    expect(existsSync(preferencePath(vault, "deploy-gate"))).toBe(false);
    expect(listPendingSkillProposals(vault).length).toBe(0);
    expect(readFileSync(note, "utf8")).toBe(before);
  });

  test("a dry run refuses exactly the markers a real run refuses", async () => {
    seedPremise("gate-green");
    seedPremise("taken-topic");
    const note = writeNote(
      "Daily/2026-07-27.md",
      [
        // Unresolvable premise.
        `@osb fact topic=t1 principle=p premise=nope level=deduced`,
        // Derivation level outside the destination's vocabulary.
        `@osb fact topic=t2 principle=p premise=gate-green level=stated`,
        // The conclusion's slug is already taken by an existing preference.
        `@osb fact topic="taken topic" principle=p premise=gate-green level=deduced`,
        "",
      ].join("\n"),
    );
    const before = readFileSync(note, "utf8");

    const dry = await scanInline(vault, { agent: "tester", now: NOW, dryRun: true });
    const real = await scanInline(vault, { agent: "tester", now: NOW });

    expect(dry.facts).toBe(0);
    expect(real.facts).toBe(0);
    expect(dry.errors.length).toBe(3);
    expect(real.errors.length).toBe(dry.errors.length);
    // Same markers, named the same way: the preview's preconditions have
    // not drifted from the ones the writer enforces.
    expect(dry.errors.map((e) => e.message.split(":")[0])).toEqual(
      real.errors.map((e) => e.message.split(":")[0]),
    );
    expect(dry.errors.map((e) => e.path)).toEqual(real.errors.map((e) => e.path));
    expect(dry.errors[0]!.message).toContain("nope");
    expect(dry.errors[1]!.message).toContain("stated");
    expect(readFileSync(note, "utf8")).toBe(before);
  });

  test("a dry run reports a declaration the queue would decline", async () => {
    writeNote("Daily/2026-07-26.md", `@osb skill name="release check" body="run the suite"\n`);
    expect((await scanInline(vault, { agent: "tester", now: NOW })).skills).toBe(1);
    rejectSkillProposal(vault, listPendingSkillProposals(vault)[0]!.slug, {
      note: "not a skill",
      now: NOW,
    });

    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb skill name="release check" body="a completely different, newer body"\n`,
    );
    const before = readFileSync(note, "utf8");

    const dry = await scanInline(vault, { agent: "tester", now: NOW, dryRun: true });

    expect(dry.skills).toBe(0);
    expect(dry.suppressed).toBe(1);
    expect(dry.errors.length).toBe(1);
    expect(readFileSync(note, "utf8")).toBe(before);
  });
});

describe("a re-declared skill on a reviewed name is a named outcome, never a silent drop", () => {
  test("a rejected name is reported, counted, and leaves the marker live", async () => {
    writeNote("Daily/2026-07-26.md", `@osb skill name="release check" body="run the suite"\n`);
    await scanInline(vault, { agent: "tester", now: NOW });
    rejectSkillProposal(vault, listPendingSkillProposals(vault)[0]!.slug, {
      note: "not a skill",
      now: NOW,
    });

    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb skill name="release check" body="a completely different, newer body"\n`,
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.skills).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("skill marker at line 1 was not consumed");
    expect(result.errors[0]!.message).toContain("rejected");
    // The marker is the only copy of the declared body: it stays live and
    // never points at the rejected file.
    expect(readFileSync(note, "utf8")).not.toContain("@osb✓");
    expect(readFileSync(note, "utf8")).toContain("a completely different, newer body");
    expect(listPendingSkillProposals(vault).length).toBe(0);
  });

  test("an accepted name is reported the same way", async () => {
    writeNote("Daily/2026-07-26.md", `@osb skill name="release check" body="run the suite"\n`);
    await scanInline(vault, { agent: "tester", now: NOW });
    acceptSkillProposal(vault, listPendingSkillProposals(vault)[0]!.slug, { now: NOW });

    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb skill name="release check" body="a completely different, newer body"\n`,
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.suppressed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("accepted");
    expect(readFileSync(note, "utf8")).not.toContain("@osb✓");
  });

  test("a second declaration of a still-pending name stays benign dedup", async () => {
    writeNote("Daily/2026-07-26.md", `@osb skill name="release check" body="run the suite"\n`);
    await scanInline(vault, { agent: "tester", now: NOW });

    const note = writeNote(
      "Daily/2026-07-27.md",
      `@osb skill name="release check" body="run the suite"\n`,
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.suppressed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skills).toBe(0);
    expect(listPendingSkillProposals(vault).length).toBe(1);
    expect(readFileSync(note, "utf8")).toContain("@osb✓");
  });
});

describe("a file whose only markers are routed still appears in the report", () => {
  test("filesWithMarkers names it and `found` counts its markers", async () => {
    seedPremise("gate-green");
    const note = writeNote(
      "Daily/2026-07-27.md",
      [
        `@osb fact topic="deploy gate" principle="ship only when green" premise=gate-green level=deduced`,
        `@osb skill name="release check" body="run the suite"`,
        "",
      ].join("\n"),
    );

    const result = await scanInline(vault, { agent: "tester", now: NOW });

    expect(result.found).toBe(2);
    expect(result.filesWithMarkers).toEqual([{ path: note, markers: 2 }]);
  });
});

describe("the fact route reads its outcome off the destination's contract", () => {
  test("DeriveFactResult carries only the id", () => {
    seedPremise("gate-green");
    const result = deriveFact(
      vault,
      {
        slug: "census-fact",
        topic: "census fact",
        principle: "p",
        premises: ["gate-green"],
        level: "deduced",
      },
      { now: NOW },
    );
    // `routeFactMarker` concludes "created" from the fact that deriveFact
    // has no branch resolving to an artifact it did not write. The day it
    // reports what it did, this census fails and that field must be read.
    expect(Object.keys(result).toSorted()).toEqual(["id"]);
  });
});
