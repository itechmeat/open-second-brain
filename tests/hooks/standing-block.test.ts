/**
 * The extracted standing-rules renderer (context-injection-pipeline, A1).
 *
 * One module renders the operator's constitution for both injection
 * lanes: the session-start lane puts it first in the preamble and the
 * subagent carrier delivers the same bytes into a delegated sub-agent's
 * first write-shaped tool call. These tests pin the contract the two
 * lanes share: the rendered block, absence yielding silence, a failed
 * read yielding the explicit failure block, and the meter staying
 * optional so the carrier can render without one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LANE_EXEMPT,
  renderStandingBlock,
  type InjectionMeter,
} from "../../hooks/lib/standing-block.ts";
import { RECEIPT_ITEM_STANDING_RULES } from "../../src/core/brain/context-receipts.ts";
import { STANDING_RULES_HEADER } from "../../src/core/brain/standing-rules.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-standing-block-vault-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeRules(body: string): string {
  const path = join(vault, "Brain", "standing-rules.md");
  writeFileSync(path, body, "utf8");
  return path;
}

function newMeter(): InjectionMeter {
  return { sources: [], configuredBudgetChars: 0, budgetChars: null, scopedRulesChars: 0 };
}

describe("renderStandingBlock", () => {
  test("renders the operator's block from a fixture rules file", () => {
    const body = "Always run the test suite before committing.";
    writeRules(body);
    expect(renderStandingBlock(vault, 4000)).toBe(`${STANDING_RULES_HEADER}\n\n${body}`);
  });

  test("an absent rules file yields an empty string", () => {
    expect(renderStandingBlock(vault, 4000)).toBe("");
  });

  test("an empty rules file yields an empty string", () => {
    writeRules("   \n\t\n");
    expect(renderStandingBlock(vault, 4000)).toBe("");
  });

  test("a body over the cap keeps the header and gains the truncation notice", () => {
    writeRules(
      Array.from({ length: 10 }, (_, i) => `rule line ${i} with some text to take up room`).join(
        "\n",
      ),
    );
    const block = renderStandingBlock(vault, 100);
    expect(block.startsWith(STANDING_RULES_HEADER)).toBe(true);
    expect(block).toContain("truncated to the configured cap");
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a failed read yields the explicit failure block, not silence",
    () => {
      const path = writeRules("rule that exists but cannot be read");
      chmodSync(path, 0o000);
      let block: string;
      try {
        block = renderStandingBlock(vault, 4000);
      } finally {
        chmodSync(path, 0o644);
      }
      expect(block.startsWith(STANDING_RULES_HEADER)).toBe(true);
      expect(block).toContain("UNAVAILABLE:");
      expect(block).toContain("standing-rules.md");
      expect(block).toContain("No standing rules are in force this session.");
    },
  );

  test("records the block on a passed meter and tolerates an absent meter", () => {
    const body = "Prefer small commits.";
    writeRules(body);
    const meter = newMeter();
    const block = renderStandingBlock(vault, 4000, meter);
    expect(meter.sources).toEqual([
      {
        name: RECEIPT_ITEM_STANDING_RULES,
        text: `${STANDING_RULES_HEADER}\n\n${body}`,
        lane: LANE_EXEMPT,
        outsideBoundary: true,
      },
    ]);
    expect(renderStandingBlock(vault, 4000)).toBe(block);
  });
});
