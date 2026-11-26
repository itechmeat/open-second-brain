/**
 * The placement a trigger's cooldown key asks for (change
 * `lane-private-partition-reach`).
 *
 * A cooldown key is built from the ids its finding fired on, and a batch
 * sighting may adopt the key of a persisted trigger whose artifacts cover
 * its own, so a key can name a preference the record's artifact list does
 * not. The partition a record lands in is judged from its fields, where
 * the key is one opaque string; so the key's id segments are judged here,
 * and a key that names a private preference marks the record private.
 */

import { logRefsNamePrivatePage } from "../../store/reference-privacy.ts";
import { extractId } from "../temporal/period-common.ts";

/** The id segments of a cooldown key: `<kind>:<id>:<id-or-action>` gives the ids. */
export function cooldownKeyIds(key: string): string[] {
  return key.split(":").filter((segment) => extractId(segment) !== undefined);
}

/** `text` (a rendered trigger) marked private when its key names a private preference. */
export function triggerTextPlaced(vault: string, key: string, text: string): string {
  const ids = cooldownKeyIds(key);
  if (ids.length === 0 || !logRefsNamePrivatePage(vault, ids)) return text;
  if (!text.startsWith("---\n")) return text;
  return `---\nvisibility: private\n${text.slice("---\n".length)}`;
}
