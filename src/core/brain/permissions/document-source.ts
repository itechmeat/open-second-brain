/**
 * Where the permissions document is read from (design D14 item 3, review
 * finding F461). The document is a shared setting, `permissions.document`,
 * that holds the YAML text `Brain/_permissions.yaml` held; the migration
 * imports the file into it, so a deny rule an operator wrote stays in force
 * once the legacy tree leaves the vault, and a machine with no vault reads
 * it too. Every machine reads the setting first. Only an unswitched machine
 * with a vault falls back to the legacy file when the setting is not set:
 * there the file is still the operator's document.
 *
 * Only an operator-authored value is in force: the setting is
 * operator-only (`settings-write.ts` refuses an agent), and a value whose
 * winning record carries agent authority (written past that refusal) is
 * not read as a policy. Every gate keeps the split
 * {@link loadPermissionsDocument} defines: absent is `{ document: null }`,
 * present but unreadable throws (fail closed).
 */

import { foldSettings } from "../../store/fold-settings.ts";
import { protectionStore, StoreUnavailableError } from "../../store/read/protection-store.ts";
import { readStreamRecords } from "../../store/read/stream-read.ts";
import { isStoreOnly } from "../../store/store-only.ts";
import {
  loadPermissionsDocument,
  PermissionsDocumentError,
  parsePermissionsDocumentText,
  PERMISSIONS_DOCUMENT_SETTING,
  type PermissionsDocument,
} from "./document.ts";

/** The label refusals and the CLI name for a store-backed document. */
export const PERMISSIONS_SETTING_LABEL = `brain setting ${PERMISSIONS_DOCUMENT_SETTING}`;

/**
 * The operator's document text in the shared settings, or `null` when it
 * is not set, was removed, or only an agent ever won it. A settings shard
 * that cannot be read, or that this machine read before and is gone now,
 * throws {@link PermissionsDocumentError}: the record it hides may be the
 * document, so the gates fail closed instead of reading "no policy". So
 * does a switched machine whose store cannot be opened, or shows no
 * `shared` partition (`protection-store.ts`): the sticky switch keeps the
 * legacy file from standing in, so "no store" is never "no rules" there.
 */
export function storedPermissionsText(configPath?: string): string | null {
  let store;
  try {
    store = protectionStore(configPath, { needShared: true });
  } catch (err) {
    if (!(err instanceof StoreUnavailableError)) throw err;
    // The cause rides along, so a caller that serves the text below
    // local reach can tell a store-open failure from a document fault
    // and redact it the way the store check's own findings are
    // (`storeOpenFailureDetail`). The text carries the error's
    // reach-safe twin, not its raw message: the raw one names a held
    // partition's file and the leave remedy, and this refusal reaches
    // callers at remote reach through the write gates.
    throw new PermissionsDocumentError(
      `${PERMISSIONS_SETTING_LABEL}: ${err.publicMessage}; writes the permissions document governs ` +
        "are refused until then",
      { cause: err },
    );
  }
  if (store === null || !store.partitions.has("shared")) return null;
  const read = readStreamRecords(store.root, "shared", { stream: "settings" });
  if (read.unreadable.length > 0) {
    throw new PermissionsDocumentError(
      `${PERMISSIONS_SETTING_LABEL}: a shared settings shard cannot be read (${read.unreadable.map((rel) => `shared/${rel}`).join(", ")}); ` +
        "writes the permissions document governs are refused until it reads again",
    );
  }
  const fold = foldSettings(read.records);
  const state = fold.settings.get(PERMISSIONS_DOCUMENT_SETTING);
  if (state === undefined || state.removed) return null;
  if (state.winner.authority !== "human") return null;
  return typeof state.value === "string" ? state.value : null;
}

/**
 * The permissions document in force for `vault` on this machine, read
 * where this machine keeps it (see the module docblock). `path` names the
 * source: the file, or {@link PERMISSIONS_SETTING_LABEL}.
 */
export function loadPermissionsDocumentFor(
  vault: string | null,
  configPath?: string,
): {
  document: PermissionsDocument | null;
  path: string;
} {
  const text = storedPermissionsText(configPath);
  if (text !== null) {
    return {
      document: parsePermissionsDocumentText(text, PERMISSIONS_SETTING_LABEL),
      path: PERMISSIONS_SETTING_LABEL,
    };
  }
  const context = configPath !== undefined ? { vault, configPath } : { vault };
  if (vault !== null && !isStoreOnly(context)) return loadPermissionsDocument(vault);
  return { document: null, path: PERMISSIONS_SETTING_LABEL };
}
