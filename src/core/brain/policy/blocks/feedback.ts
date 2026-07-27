/**
 * The `feedback:` block (default-scope-feedback suite) — the vault-wide
 * default scope for feedback signal writes that pass none.
 *
 * One reason to change: what a vault-default scope may be. The
 * constraints mirror the signal `scope` field exactly (non-empty after
 * trim, single-line, at most {@link SCOPE_MAX_LEN}) so a configured
 * default can never pass validation here yet fail at write time.
 */

import type { BrainFeedbackConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { SCOPE_MAX_LEN } from "../../signal.ts";

const BLOCK = "feedback";
const FIELD = "feedback.default_scope";

const KNOWN_KEYS = ["default_scope"] as const;

export function parseFeedbackBlock(ctx: BlockParseContext): BrainFeedbackConfig | undefined {
  const rawMap = openBlock(ctx, BLOCK);
  if (rawMap === undefined) return undefined;

  const partial: { default_scope?: string } = {};
  if ("default_scope" in rawMap) {
    partial.default_scope = cleanScope(rawMap["default_scope"], ctx.source);
  }
  warnUnknownKeys(ctx, rawMap, KNOWN_KEYS, BLOCK);
  return Object.freeze(partial);
}

function cleanScope(value: unknown, source: string | null): string {
  if (typeof value !== "string") {
    throw new BrainConfigError(`must be a string; got ${describe(value)}`, FIELD, source);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new BrainConfigError("must be a non-empty single-line scope slug", FIELD, source);
  }
  if (/[\n\r]/.test(value)) {
    throw new BrainConfigError("must be single-line (no newline characters)", FIELD, source);
  }
  if (trimmed.length > SCOPE_MAX_LEN) {
    throw new BrainConfigError(
      `must be at most ${SCOPE_MAX_LEN} characters; got ${trimmed.length}`,
      FIELD,
      source,
    );
  }
  return trimmed;
}
