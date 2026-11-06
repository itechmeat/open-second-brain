/**
 * The privacy verdict of one note create (`store/operation-privacy.ts`),
 * shared by the direct create writer and the write batch's `create_note`
 * operation so both judge a create by one rule.
 *
 * A create is private when the frontmatter it writes reserves the page as
 * private, when its frontmatter, content or template names a private page
 * or carries a `<private>` region, when any other caller-supplied field
 * does, or when an enclosing operation is private. The config path is a
 * local setting: checked for a region, never judged as a page reference.
 */

import { isPrivateFrontmatter } from "../../store/dual-write-records.ts";
import {
  callerInput,
  opaqueFields,
  operationPrivacy,
  type OperationPrivacy,
  type PrivacyVerdict,
} from "../../store/operation-privacy.ts";

/**
 * The fields of a create this judge reads by name, structurally; every
 * other field the caller passed is judged as content too.
 */
export interface JudgedCreate {
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  readonly content?: string;
  readonly storePrivate?: PrivacyVerdict;
}

const CREATE_INPUT_OPAQUE: ReadonlySet<string> = opaqueFields("configPath");

/** The single, memoised privacy verdict of creating a note from `input`. */
export function createNotePrivacy(
  vault: string,
  input: JudgedCreate,
  inherit?: PrivacyVerdict,
): OperationPrivacy {
  const { storePrivate, ...caller } = input;
  return operationPrivacy(vault, {
    target: () => isPrivateFrontmatter(input.frontmatter ?? {}),
    content: [callerInput(caller, CREATE_INPUT_OPAQUE)],
    inherit: [storePrivate, inherit],
  });
}
