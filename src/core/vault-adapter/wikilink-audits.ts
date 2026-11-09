/**
 * The wikilink audits the vault adapter owns (design D14 item 8): the
 * features that read wikilinks across vault pages, which exist only when
 * a vault does. Each entry point calls `requireVaultAdapter` with its
 * name from here, so the refusal text names the feature the same way on
 * every surface.
 */

/** Names of the wikilink audits, as their refusals print them. */
export const WIKILINK_AUDIT = Object.freeze({
  mocAudit: "the map-of-content audit",
  unlinkedMentions: "the unlinked-mentions audit",
  aliasIndex: "the wikilink alias index",
  conceptCluster: "the concept cluster",
  brokenBacklinks: "the broken-backlink check",
});

export type WikilinkAudit = (typeof WIKILINK_AUDIT)[keyof typeof WIKILINK_AUDIT];
