/**
 * The end-of-turn advisories' settings and their per-host delivery are
 * documented where an operator looks: the hooks README, the CLI
 * reference's config keys, the brain-memory skill the model reads, and
 * the CHANGELOG.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

const SETTINGS = [
  ["stop_guardrail_enabled", "OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED"],
  ["quote_check_enabled", "OPEN_SECOND_BRAIN_QUOTE_CHECK_ENABLED"],
  ["stop_advisory_delivery", "OPEN_SECOND_BRAIN_STOP_ADVISORY_DELIVERY"],
] as const;

describe("end-of-turn advisory docs", () => {
  test("hooks/README.md and docs/cli-reference.md name the settings with their env overrides", () => {
    for (const doc of ["hooks/README.md", "docs/cli-reference.md"]) {
      const text = read(doc);
      for (const [key, env] of SETTINGS) {
        expect(text).toContain(`\`${key}\``);
        expect(text).toContain(`\`${env}\``);
      }
    }
  });

  test("hooks/README.md says what each host shows and cites the host docs", () => {
    const text = read("hooks/README.md");
    expect(text).toContain("### What the person sees on each host");
    expect(text).toContain("https://code.claude.com/docs/en/hooks");
    expect(text).toContain("https://developers.openai.com/codex/hooks");
    expect(text).toContain("Stop hook says");
    expect(text).toContain("`async: true`");
  });

  test("hooks/README.md says plainly what a one-shot claude -p run gets", () => {
    const text = read("hooks/README.md");
    const section = text.slice(text.indexOf("#### One-shot runs (`claude -p`)"));
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("The durable records: yes.");
    expect(section).toContain("The advisory text: no.");
    expect(section).toContain("cannot reach the model there");
    expect(section).toContain('`stop_advisory_delivery: "sync"`');
  });

  test("the cli-reference link lands on the README section", () => {
    expect(read("docs/cli-reference.md")).toContain(
      "hooks/README.md#what-the-person-sees-on-each-host",
    );
  });

  test("the brain-memory skill tells the model when the reminder arrives and how to read a quote check", () => {
    const skill = read("skills/brain-memory/SKILL.md");
    expect(skill).toContain("arrives with the next user message");
    expect(skill).toContain("stop_guardrail_enabled");
    expect(skill).toContain("claude -p");
    expect(skill).toContain("stop_advisory_delivery");
    expect(skill).toContain("Open Second Brain quote check");
    expect(skill).toContain("untrusted_source");
  });

  test("the CHANGELOG names the settings under Unreleased", () => {
    const changelog = read("CHANGELOG.md");
    const unreleased = changelog.slice(
      changelog.indexOf("## [Unreleased]"),
      changelog.indexOf("\n## [", changelog.indexOf("## [Unreleased]") + 1),
    );
    for (const [key, env] of SETTINGS) {
      expect(unreleased).toContain(`\`${key}\``);
      expect(unreleased).toContain(`\`${env}\``);
    }
  });
});
