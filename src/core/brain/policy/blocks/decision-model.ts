/**
 * The `decision_model:` block - a vault's opt-out from the optional
 * decision-model feature.
 *
 * One reason to change: what a vault may say about decision models.
 *
 * The feature itself is configured only in the operator's machine config
 * (`decision_model_*` keys), never here: this file travels with the vault,
 * so anything it could turn ON would be a way for vault content to start
 * sending vault text to a remote endpoint. The block can therefore only
 * NARROW. `enabled: false` disables every use for this vault; every other
 * spelling - `enabled: true`, a use list, a mode, an endpoint - is ignored
 * with a warning naming the field.
 *
 * Shape:
 *   decision_model:
 *     enabled: false
 */

import type { BrainConfig, BrainDecisionModelConfig } from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "decision_model";
const ENABLED_KEY = "enabled";

export function parseDecisionModelBlock(
  ctx: BlockParseContext,
): BrainDecisionModelConfig | undefined {
  const obj = openBlock(ctx, BLOCK);
  if (obj === undefined) return undefined;
  warnUnknownKeys(ctx, obj, [ENABLED_KEY], BLOCK);
  if (!(ENABLED_KEY in obj)) return {};
  const value = obj[ENABLED_KEY];
  if (typeof value !== "boolean") {
    throw new BrainConfigError(
      "must be false (a vault can only disable)",
      `${BLOCK}.${ENABLED_KEY}`,
      ctx.source,
    );
  }
  if (value) {
    // A vault cannot widen what the operator configured. Ignored rather
    // than refused, so a vault written for a machine that allows the
    // feature still loads everywhere else.
    ctx.warnings.push({
      path: ctx.source ?? "<config>",
      message:
        `${BLOCK}.${ENABLED_KEY}: true ignored; a vault can only disable decision models, ` +
        "enabling them is the operator's machine config",
    });
    return {};
  }
  return { enabled: false };
}

/** True when this vault opted out of every decision-model use. */
export function decisionModelDisabledByVault(cfg: BrainConfig | undefined): boolean {
  return cfg?.decision_model?.enabled === false;
}
