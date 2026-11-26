/**
 * The default target of a panel and the old name it may have under.
 *
 * A panel on a topic opened on a day is written to
 * `Brain/decisions/panels/panel-<day>-<slug>.md`, the slug keeping letters
 * of any script. An older release used the Latin-only slug, so a panel of
 * the same topic and day may already sit under that name (or be committed
 * there by a session that release opened). One panel per topic and day
 * holds across both names: a same-topic panel under the other default
 * name refuses the write. A candidate is read only when it resolves inside
 * the vault, so a link that leads elsewhere is never read and never
 * decides the target.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";

import { ensureInsideVault } from "../../path-safety.ts";
import { listLaneFiles, lanePageExists, parseLanePage } from "../../store/lane-pages.ts";
import { legacySlugForms, titleIdentity, titleKeySlug } from "../../vault.ts";

const PANELS_REL = "Brain/decisions/panels";
const PANEL_NAME_RE = /^Brain\/decisions\/panels\/panel-(\d{4}-\d{2}-\d{2})-[^/]+\.md$/u;

/**
 * The default names of a panel on `topic` opened on `day`: the fresh one,
 * and the Latin-only names an older release gave it, one per form the
 * topic can have been typed in (NFC, NFD, other spaces), the fresh name
 * left out (none for an ASCII topic).
 */
export function panelDefaultNames(
  topic: string,
  day: string,
): { fresh: string; legacy: readonly string[] } {
  const name = (slug: string): string => `${PANELS_REL}/panel-${day}-${slug}.md`;
  const fresh = name(titleKeySlug(topic));
  const legacy = legacySlugForms(topic)
    .map(name)
    .filter((candidate) => candidate !== fresh);
  return { fresh, legacy };
}

/** The legacy default name of `topic` and `day` a same-topic panel already holds, or null. */
export function heldLegacyPanelName(vault: string, topic: string, day: string): string | null {
  const dir = join(vault, PANELS_REL);
  const prefix = `panel-${day}-`;
  // The lane's listing, not the disk folder: a store-only machine holds the
  // day's panels as records, with no file there.
  const stored = listLaneFiles(vault, dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => `${PANELS_REL}/${name}`)
    .find((rel) => sameTopicPanelAt(vault, rel, topic));
  return stored ?? null;
}

/**
 * True when the panel note at vault-relative `rel` exists inside the vault
 * and was written for `topic` (its stored topic has the same
 * {@link titleIdentity}). A name that resolves outside the vault is not
 * read and answers false.
 */
export function sameTopicPanelAt(vault: string, rel: string, topic: string): boolean {
  const absolute = join(vault, rel);
  if (!lanePageExists(vault, absolute)) return false;
  // A name on the vault's disk is read only when it resolves inside the
  // vault: a link leading elsewhere is never read and holds no topic.
  let onDisk = true;
  try {
    lstatSync(absolute);
  } catch {
    onDisk = false;
  }
  if (onDisk) {
    try {
      ensureInsideVault(absolute, vault);
    } catch {
      return false;
    }
  }
  let stored: unknown;
  try {
    stored = parseLanePage(vault, absolute)[0]["topic"];
  } catch {
    return false;
  }
  return typeof stored === "string" && titleIdentity(stored) === titleIdentity(topic);
}

/**
 * Another default name of a panel session's target when a same-topic
 * panel is already there, or null. Only a target that is one of the
 * default names for the session's topic and day is checked: an explicit
 * target elsewhere keeps its own collision rule.
 */
export function heldPanelDefaultName(
  vault: string,
  topic: string | null,
  targetPath: string,
): string | null {
  if (topic === null) return null;
  const day = PANEL_NAME_RE.exec(targetPath)?.[1];
  if (day === undefined) return null;
  const { fresh, legacy } = panelDefaultNames(topic, day);
  const names = [fresh, ...legacy];
  if (!names.includes(targetPath)) return null;
  const dir = join(vault, PANELS_REL);
  const prefix = `panel-${day}-`;
  return (
    listLaneFiles(vault, dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => `${PANELS_REL}/${name}`)
      .find((rel) => rel !== targetPath && sameTopicPanelAt(vault, rel, topic)) ??
    names.find((rel) => rel !== targetPath && sameTopicPanelAt(vault, rel, topic)) ??
    null
  );
}
