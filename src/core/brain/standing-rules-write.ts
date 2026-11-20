/**
 * The operator's own edit of the standing rules (`o2b brain standing-rules`).
 *
 * No agent tool writes the rules: the note tools, labels, attributes and
 * write sessions all refuse them (`assertStandingRulesNotTargeted`). Before
 * the brain store the operator edited `Brain/standing-rules.md` and the
 * files under `Brain/standing-rules/` with any editor. On a switched
 * machine those files are entries of the `standing-rule` lane (design D14
 * item 4) and the vault may have no `Brain/` folder at all, so this module
 * is the operator's way to change them: it writes the lane entry there,
 * with `human` authority, and the file itself on an unswitched machine,
 * exactly as an editor would. Nothing here is reachable from an MCP tool.
 */

import {
  assertLaneWrite,
  lanePageExists,
  removeLanePage,
  writeLaneText,
} from "../store/lane-pages.ts";
import { brainScopedRulePath, brainStandingRulesPath } from "./paths.ts";
import { scopedRuleKey } from "./scoped-rule-key.ts";
import type { ScopedRuleAxis } from "./scoped-rule-axis.ts";
import { readOperatorRuleFile } from "./standing-rules.ts";

/** Which rules: the vault-wide constitution, or one scoped rule file. */
export type OperatorRuleTarget =
  | { readonly kind: "constitution" }
  | { readonly kind: "scoped"; readonly axis: ScopedRuleAxis; readonly value: string };

/** A target this module cannot address (a scope value that keys to nothing). */
export class OperatorRuleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorRuleTargetError";
  }
}

/** The legacy path of the rule file `target` names (also its lane address). */
export function operatorRulePath(vault: string, target: OperatorRuleTarget): string {
  if (target.kind === "constitution") return brainStandingRulesPath(vault);
  const key = scopedRuleKey(target.value);
  if (key === null) {
    throw new OperatorRuleTargetError(
      `the ${target.axis} value '${target.value}' keys to no scoped rule file`,
    );
  }
  return brainScopedRulePath(vault, target.axis, key);
}

/** The rule text as stored, or null when there is none. */
export function readOperatorRules(vault: string, target: OperatorRuleTarget): string | null {
  try {
    return readOperatorRuleFile(vault, operatorRulePath(vault, target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Replace the rules `target` names with `text`, byte for byte. Returns the
 * path it wrote (a lane address on a switched machine). Empty text is
 * refused: clearing the rules is {@link clearOperatorRules}.
 */
export function writeOperatorRules(
  vault: string,
  target: OperatorRuleTarget,
  text: string,
): string {
  if (text.trim() === "") {
    throw new OperatorRuleTargetError("the rules text is empty; use clear to remove the rules");
  }
  const path = operatorRulePath(vault, target);
  assertLaneWrite(vault);
  writeLaneText(vault, path, text);
  return path;
}

/**
 * Remove the rules `target` names. Returns whether there were any. "None"
 * is answered only from a read that saw the whole store: over an
 * incomplete fold (an unreadable `events` shard, a record whose body has
 * not arrived) the read throws, as it does for `show`, so a rule the fold
 * skipped is never reported absent and left in force.
 */
export function clearOperatorRules(vault: string, target: OperatorRuleTarget): boolean {
  const path = operatorRulePath(vault, target);
  if (readOperatorRules(vault, target) === null) return false;
  if (!lanePageExists(vault, path)) return false;
  assertLaneWrite(vault);
  return removeLanePage(vault, path);
}
