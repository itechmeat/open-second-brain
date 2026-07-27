/**
 * Grammar coverage for the two capture marker kinds added by
 * "signals that survive" unit 7: `@osb fact` and `@osb skill`.
 *
 * These kinds ride the SAME parser, fence walker and consumed-sentinel
 * skip as `feedback` / `loop` / `set`, so the tests here assert the two
 * surface forms, the required-field contract (which must name the
 * missing field rather than drop the marker silently), and that nothing
 * about a file without the new kinds changes.
 */

import { describe, expect, test } from "bun:test";

import {
  discoverMarkers,
  discoverMarkersDetailed,
  isFactMarker,
  isFeedbackMarker,
  isSkillMarker,
  parseBlockMarker,
  parseInlineMarker,
} from "../../../src/core/brain/inline.ts";

describe("parseInlineMarker fact", () => {
  test("parses topic, principle, a single premise and the derivation level", () => {
    const m = parseInlineMarker(
      `@osb fact topic=deploy-gate principle="ship only when the gate is green" premise=pref-gate level=deduced`,
      7,
    );
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("fact");
    expect(m!.topic).toBe("deploy-gate");
    expect(m!.principle).toBe("ship only when the gate is green");
    expect(m!.premise).toEqual(["pref-gate"]);
    expect(m!.level).toBe("deduced");
    expect(m!.originLine).toBe(7);
    expect(m!.shape).toBe("inline");
  });

  test("collects repeated premise values in source order", () => {
    const m = parseInlineMarker(
      `@osb fact topic=t principle=p premise=pref-a premise=b level=inferred`,
      1,
    );
    expect(m!.premise).toEqual(["pref-a", "b"]);
  });

  test("a missing required field rejects the marker and names the field", () => {
    expect(parseInlineMarker(`@osb fact topic=t principle=p premise=pref-a`, 1)).toBeNull();
    const result = discoverMarkersDetailed(`@osb fact topic=t principle=p premise=pref-a\n`);
    expect(result.markers.length).toBe(0);
    expect(result.malformed).toBe(1);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]!.kind).toBe("fact");
    expect(result.issues[0]!.missingFields).toEqual(["level"]);
    expect(result.issues[0]!.message).toContain("level");
    expect(result.issues[0]!.originLine).toBe(1);
  });

  test("an absent premise is named just like any other required field", () => {
    const result = discoverMarkersDetailed(`@osb fact topic=t principle=p level=deduced\n`);
    expect(result.issues[0]!.missingFields).toEqual(["premise"]);
    expect(result.issues[0]!.message).toContain("premise");
  });

  test("the level value is not vetted by the grammar - the derive path owns it", () => {
    const m = parseInlineMarker(`@osb fact topic=t principle=p premise=pref-a level=guessed`, 1);
    expect(m).not.toBeNull();
    expect(m!.level).toBe("guessed");
  });
});

describe("parseBlockMarker fact", () => {
  test("parses the same field set from the block shape", () => {
    const body = [
      "kind: fact",
      "topic: deploy-gate",
      "principle: ship only when the gate is green",
      "premise: pref-gate",
      "premise: pref-review",
      "level: inferred",
    ].join("\n");
    const m = parseBlockMarker(body, 4);
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("fact");
    expect(m!.topic).toBe("deploy-gate");
    expect(m!.principle).toBe("ship only when the gate is green");
    expect(m!.premise).toEqual(["pref-gate", "pref-review"]);
    expect(m!.level).toBe("inferred");
    expect(m!.shape).toBe("block");
    expect(m!.originLine).toBe(4);
  });

  test("a repeated single-valued required field is ambiguous and rejects", () => {
    const body = [
      "kind: fact",
      "topic: one",
      "topic: two",
      "principle: p",
      "premise: pref-a",
      "level: deduced",
    ].join("\n");
    expect(parseBlockMarker(body, 1)).toBeNull();
    const result = discoverMarkersDetailed(["```osb", body, "```"].join("\n"));
    expect(result.markers.length).toBe(0);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]!.duplicateFields).toEqual(["topic"]);
    expect(result.issues[0]!.message).toContain("topic");
  });
});

describe("parseInlineMarker skill", () => {
  test("parses name and body", () => {
    const m = parseInlineMarker(
      `@osb skill name="release check" body="run the suite, then the linter"`,
      3,
    );
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("skill");
    expect(m!.name).toBe("release check");
    expect(m!.body).toBe("run the suite, then the linter");
    expect(m!.shape).toBe("inline");
  });

  test("a missing body rejects the marker and names the field", () => {
    expect(parseInlineMarker(`@osb skill name="release check"`, 1)).toBeNull();
    const result = discoverMarkersDetailed(`@osb skill name="release check"\n`);
    expect(result.issues[0]!.kind).toBe("skill");
    expect(result.issues[0]!.missingFields).toEqual(["body"]);
    expect(result.issues[0]!.message).toContain("body");
  });
});

describe("parseBlockMarker skill", () => {
  test("parses a multi-line body through the block scalar form", () => {
    const body = [
      "kind: skill",
      "name: release check",
      "body: |",
      "  run the suite",
      "  then the linter",
    ].join("\n");
    const m = parseBlockMarker(body, 1);
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("skill");
    expect(m!.name).toBe("release check");
    expect(m!.body).toBe("run the suite\nthen the linter");
  });
});

describe("type guards for the new kinds", () => {
  test("isFactMarker and isSkillMarker narrow, and neither claims a feedback marker", () => {
    const text = [
      "@osb feedback negative topic=t principle=p",
      "@osb fact topic=ft principle=fp premise=pref-a level=deduced",
      `@osb skill name="release check" body="run the suite"`,
    ].join("\n");
    const markers = discoverMarkers(text);
    expect(markers.length).toBe(3);
    expect(markers.filter(isFeedbackMarker).length).toBe(1);
    const facts = markers.filter(isFactMarker);
    const skills = markers.filter(isSkillMarker);
    expect(facts.length).toBe(1);
    expect(skills.length).toBe(1);
    expect(facts[0]!.premise).toEqual(["pref-a"]);
    expect(skills[0]!.name).toBe("release check");
  });
});

describe("the walker treats the new kinds exactly like the old ones", () => {
  test("a fact marker inside a non-osb fence stays inert", () => {
    const text = [
      "```markdown",
      "@osb fact topic=t principle=p premise=pref-a level=deduced",
      "```",
    ].join("\n");
    expect(discoverMarkers(text).length).toBe(0);
  });

  test("a consumed inline fact marker is skipped on a re-run", () => {
    const consumed = "@osb✓ [[pref-t]] fact topic=t principle=p premise=pref-a level=deduced";
    expect(discoverMarkers(consumed).length).toBe(0);
  });

  test("a consumed skill block is skipped on a re-run", () => {
    const text = [
      "```osb-checked",
      "<!-- @osb✓ [[prop-declared_marker-release-check-0badc0de]] -->",
      "kind: skill",
      "name: release check",
      "body: run the suite",
      "```",
    ].join("\n");
    expect(discoverMarkers(text).length).toBe(0);
  });

  test("a file with no fact or skill markers reports no issues", () => {
    const text = [
      "# notes",
      "@osb feedback negative topic=t principle=p",
      "@osb loop follow up on the contract",
      "@osb set note=Roadmap field=completion value=65",
    ].join("\n");
    const result = discoverMarkersDetailed(text);
    expect(result.markers.length).toBe(3);
    expect(result.malformed).toBe(0);
    expect(result.issues).toEqual([]);
  });
});
