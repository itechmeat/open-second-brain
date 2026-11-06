/**
 * The privacy verdict of a write batch (`store/operation-privacy.ts`): one
 * verdict for the whole batch, judged from its operations once, when the
 * batch writes its first store record (after every operation validated,
 * and never with dual writes off), and handed to every store record the
 * batch writes (each operation's log event, each note-write event, each
 * evidence record, every inner idempotency receipt and the batch's
 * request receipt). The records of one batch so never land in different
 * partitions.
 *
 * The batch's whole caller input is judged as content: every field of
 * every operation object (its `agent`, its `idempotency_key`, any field a
 * later operation kind adds) and the request id, so no caller field can
 * reach a record body without the verdict having seen it. Keys, ids and
 * local settings are opaque ({@link BATCH_INPUT_OPAQUE}): checked for a
 * `<private>` region, never judged as page references.
 *
 * A batch is also private when any operation is, by the rule each
 * operation's own writer applies, so the batch verdict covers every inner
 * verdict:
 *
 *  - `apply_evidence`: the evidence call's own verdict
 *    (`applyEvidencePrivacy`): its preference is private or cannot be
 *    judged, or its event names a private page or carries a region; a call
 *    that would be refused cannot be judged and counts as private;
 *  - `append_log_line`: the note event's own verdict (`brainNotePrivacy`);
 *  - `create_note`: the frontmatter it creates reserves the page as
 *    private, or its frontmatter or content names a private page or
 *    carries a region;
 *  - `update_note`, `append_note`: the page it changes is private or
 *    cannot be judged (missing, unreadable, outside the vault), the
 *    frontmatter an update merges reserves it, or the text it writes names
 *    a private page or carries a region.
 *
 * Note pages have no store copy of their own; their privacy reaches the
 * store through the batch's log events and receipt.
 */

import { existsSync } from "node:fs";

import { isPrivateFrontmatter, isPrivatePageFile } from "../store/dual-write-records.ts";
import {
  callerInput,
  opaqueFields,
  operationPrivacy,
  type JudgedContent,
  type OperationPrivacy,
  type PrivacyVerdict,
} from "../store/operation-privacy.ts";
import { applyEvidencePrivacy, type AppendApplyEvidenceInput } from "./apply-evidence.ts";
import { brainNotePrivacy } from "./note.ts";
import { resolveNoteTarget } from "./notes/create-note.ts";
import { createNotePrivacy, type JudgedCreate } from "./notes/create-note-privacy.ts";

/**
 * The fields of a batch operation this judge reads. Structural, so this
 * module does not import the batch kernel that imports it.
 */
export type JudgedOperation =
  | { readonly kind: "apply_evidence"; readonly input: AppendApplyEvidenceInput }
  | { readonly kind: "append_log_line"; readonly input: { readonly text: string } }
  | ({ readonly kind: "create_note" } & JudgedCreate)
  | {
      readonly kind: "update_note";
      readonly path: string;
      readonly frontmatter?: Readonly<Record<string, unknown>>;
      readonly body?: string;
    }
  | { readonly kind: "append_note"; readonly path: string; readonly content: string };

/**
 * Fields of a batch's input that are keys, ids or local settings: the
 * request id, each operation's kind, an inner idempotency key, a clock and
 * a config path an `append_log_line` input may carry.
 */
const BATCH_INPUT_OPAQUE: ReadonlySet<string> = opaqueFields("requestId", "now", "configPath");

/**
 * The single privacy verdict of a batch of `operations` sent under
 * `requestId`. `readable` is the caller's read filter, as the evidence
 * writer applies it.
 */
export function writeBatchPrivacy(
  vault: string,
  operations: ReadonlyArray<unknown>,
  requestId: string | undefined,
  readable?: (rel: string) => boolean,
): OperationPrivacy {
  // Nothing is read from the operations until a record is written: the
  // batch validates every operation first, and a malformed one must
  // surface as its indexed batch error, not as whatever reading it here
  // throws. Once judged, a shape this judge cannot read counts as private.
  return operationPrivacy(vault, {
    content: [callerInput({ operations, requestId: requestId ?? null }, BATCH_INPUT_OPAQUE)],
    inherit: [
      () =>
        operations.some((op) => {
          const verdict = operationVerdict(vault, op as JudgedOperation, readable);
          return typeof verdict === "function" ? verdict() : verdict;
        }),
    ],
  });
}

function operationVerdict(
  vault: string,
  op: JudgedOperation,
  readable: ((rel: string) => boolean) | undefined,
): PrivacyVerdict {
  switch (op.kind) {
    case "apply_evidence":
      return applyEvidencePrivacy(vault, op.input, readable);
    case "append_log_line":
      return brainNotePrivacy(vault, op.input);
    case "create_note":
      return createNotePrivacy(vault, op);
    case "update_note":
      return operationPrivacy(vault, {
        target: () => pageIsPrivate(vault, op.path) || isPrivateFrontmatter(op.frontmatter ?? {}),
        content: [text({ frontmatter: op.frontmatter ?? null, body: op.body ?? null })],
      });
    case "append_note":
      return operationPrivacy(vault, {
        target: () => pageIsPrivate(vault, op.path),
        content: [text({ content: op.content })],
      });
    default:
      return true;
  }
}

function text(value: unknown): JudgedContent {
  return { value };
}

/** A page that cannot be resolved, found or read counts as private. */
function pageIsPrivate(vault: string, path: string): boolean {
  let abs: string;
  try {
    abs = resolveNoteTarget(vault, path).abs;
  } catch {
    return true;
  }
  return !existsSync(abs) || isPrivatePageFile(abs);
}
