/**
 * The decision-model docs cover every registered use (task 4.5):
 * `docs/decision-models.md` names each use in the "Uses:" sentence and in
 * a row of the "Uses" table, and `docs/decision-models/
 * topics-and-agent-context.md` has a section per new use that states what
 * the code does: the threshold name and its built-in default, the question
 * id and the masked field it names, what it sends and its fallback.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DECISION_MODEL_USES } from "../../src/core/decision-model/contract.ts";
import {
  EVENT_KIND_QUESTIONS,
  HEAD_SELECT_QUESTIONS,
  HUMAN_READABLE_QUESTIONS,
  MILESTONE_DONE_QUESTIONS,
  NEIGHBOUR_RELEVANT_QUESTIONS,
  QUESTION_RESOLVED_QUESTIONS,
  TOPIC_NEW_QUESTIONS,
  TOPIC_ROUTE_QUESTIONS,
  TOPIC_USES,
} from "../../src/core/decision-model/questions-topics.ts";
import {
  BUILTIN_USE_THRESHOLDS,
  PRIMARY_THRESHOLD_NAME,
} from "../../src/core/decision-model/questions.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const main = readFileSync(join(REPO_ROOT, "docs", "decision-models.md"), "utf8");
const page = readFileSync(
  join(REPO_ROOT, "docs", "decision-models", "topics-and-agent-context.md"),
  "utf8",
);

// The sentence wraps over lines; the paragraph runs to the blank line.
const mainLines = main.split("\n");
const sentenceStart = mainLines.findIndex((line) => line.startsWith("Uses: `"));
let sentenceEnd = sentenceStart;
while (sentenceEnd < mainLines.length && mainLines[sentenceEnd] !== "") sentenceEnd += 1;
const usesSentence = mainLines.slice(sentenceStart, sentenceEnd).join(" ");
const tableRows = main.split("\n").filter((line) => /^\| `[a-z_]+` +\|/.test(line));

describe("the decision-model docs cover every use", () => {
  test.each([...DECISION_MODEL_USES])("documents the use %s", (use) => {
    expect(usesSentence).toBeDefined();
    expect(usesSentence).toContain(`\`${use}\``);
    expect(
      tableRows.some((row) => row.startsWith(`| \`${use}\` |`)),
      `docs/decision-models.md's Uses table has no row for ${use}`,
    ).toBe(true);
  });

  test.each([...TOPIC_USES])("topics-and-agent-context.md has a section for %s", (use) => {
    expect(page).toMatch(new RegExp(`^## ${use}$`, "m"));
  });
});

/** The section of the topics page for `use`, up to the next heading. */
function sectionOf(use: string): string {
  const start = page.search(new RegExp(`^## ${use}$`, "m"));
  if (start < 0) return "";
  const rest = page.slice(start + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The question id prefix and the masked field each batched use names. */
const QUESTION_NAMING: Readonly<Record<string, readonly [string, string] | null>> = {
  topic_route: [TOPIC_ROUTE_QUESTIONS.routeId(0), "records.R<k>"],
  event_kind: [EVENT_KIND_QUESTIONS.kindId(0), "records.R<k>"],
  human_readable: [HUMAN_READABLE_QUESTIONS.historyId(0), "records.R<k>"],
  topic_new: [TOPIC_NEW_QUESTIONS.newId(0), "groups"],
  topic_same: null,
  question_resolved: [QUESTION_RESOLVED_QUESTIONS.answersId(0), "records.R<k>"],
  milestone_done: [MILESTONE_DONE_QUESTIONS.doneId(0), "milestones.M<k>"],
  head_select: [HEAD_SELECT_QUESTIONS.relevantId(0), "topics.T<k>"],
  neighbour_relevant: [NEIGHBOUR_RELEVANT_QUESTIONS.mattersId(0), "records.R<k>"],
};

describe("each topic and agent-context section states what the code does", () => {
  test.each([...TOPIC_USES])("%s: threshold name and default, question, sends, fallback", (use) => {
    const section = sectionOf(use);
    const name = PRIMARY_THRESHOLD_NAME[use];
    const value = (BUILTIN_USE_THRESHOLDS[use] as Readonly<Record<string, number>>)[name]!;
    expect(section).toContain(`**Threshold:** \`${name}\`, default \`${value}\``);
    expect(section).toContain("**What it sends:**");
    expect(section).toContain("**Fallback:**");
    const naming = QUESTION_NAMING[use];
    if (naming !== null && naming !== undefined) {
      const [firstId, field] = naming;
      expect(section).toContain(`\`${firstId.replace(/0$/, "<k>")}\``);
      expect(section).toContain(`\`${field}\``);
    }
  });

  test("the stored verdict stream and the kept note match FORMAT.md", () => {
    const section = sectionOf("human_readable");
    expect(section).toContain("`log` stream of `shared`");
    expect(section).toContain("`keep: true`");
  });

  test("the shared mechanics name the applied thresholds and the guard on side texts", () => {
    expect(page).toContain("the value stored there is the threshold the use applies");
    expect(page).toContain("`(withheld)`");
    expect(page).toMatch(/stripped from every text a request carries/);
  });
});
