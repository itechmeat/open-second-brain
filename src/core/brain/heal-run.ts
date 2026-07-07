/**
 * Heal-phase enrichment runner (Brain lifecycle suite, Feature 6).
 *
 * Drives the pure {@link planHealEnrichment} primitive over the user's
 * vault pages during the dream heal phase. Opt-in only: the dream pass
 * calls this exclusively when `dream.heal_enrich_enabled` is true.
 *
 * Safety:
 *   - The Brain root (`Brain/`) is excluded - preference / signal /
 *     retired frontmatter is owned by the transactional writer and must
 *     never be rewritten here.
 *   - A page is never linked to its own title (no self-links).
 *   - Only changed pages are rewritten, via the same atomic writer the
 *     rest of the Brain layer uses.
 *
 * Deterministic: the known-title index is derived from the vault's own
 * page titles + aliases; no clock, no network, no language heuristics.
 */

import {
  EXCLUDED_DIRS,
  listVaultPages,
  parseFrontmatter,
  writeFrontmatterAtomic,
} from "../vault.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";
import { planHealEnrichmentPrepared, prepareHealPhrases } from "./heal-enrich.ts";

export interface HealRunResult {
  /** Pages scanned (outside the Brain root). */
  readonly scanned: number;
  /** Pages actually rewritten. */
  readonly enriched: number;
  /** Vault-relative-ish paths of the rewritten pages, sorted. */
  readonly pages: ReadonlyArray<string>;
}

/**
 * Run deterministic enrichment over the vault's user pages. Returns the
 * scan/enrich counts. Writes only changed pages.
 */
export function runHealEnrichment(vault: string): HealRunResult {
  // BRAIN_ROOT_REL is the Brain dir name relative to the vault (its
  // first path segment is the dir to skip). The skipDirs option REPLACES
  // the default exclusions, so the Brain root is added to the standard
  // set (.git / .obsidian / .trash / .stversions) rather than replacing
  // it - heal must never rewrite Syncthing version history, Obsidian
  // config, or the trash.
  const brainDir = BRAIN_ROOT_REL.split("/")[0] ?? "Brain";
  const pages = listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS, brainDir] });

  // Build the known title/alias index from every page once, plus a
  // per-page exclusion map so a page is never linked to its own title
  // OR its own aliases.
  const known = new Set<string>();
  const ownTokens = new Map<string, Set<string>>();
  for (const p of pages) {
    const own = new Set<string>();
    if (p.title.trim().length > 0) {
      known.add(p.title);
      own.add(p.title);
    }
    const aliases = p.metadata["aliases"];
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (typeof a === "string" && a.trim()) {
          known.add(a);
          own.add(a);
        }
      }
    }
    ownTokens.set(p.path, own);
  }

  // Sort + regex-escape the whole known set ONCE; per page we only exclude
  // that page's own few terms (see planHealEnrichmentPrepared) instead of
  // re-sorting and recompiling the K-phrase set from scratch.
  const prepared = prepareHealPhrases([...known]);

  const changed: string[] = [];
  for (const p of pages) {
    let meta;
    let body;
    try {
      [meta, body] = parseFrontmatter(p.path);
    } catch {
      // A page we cannot parse is skipped, not aborted - heal is hygiene.
      continue;
    }
    // Never link a page to its own title or aliases.
    const own = ownTokens.get(p.path) ?? new Set<string>();
    const plan = planHealEnrichmentPrepared({ frontmatter: meta, body }, prepared, own);
    if (!plan.changed) continue;

    const newMeta = plan.title !== undefined ? { ...meta, title: plan.title } : meta;
    const newBody = plan.body ?? body;
    try {
      writeFrontmatterAtomic(p.path, newMeta, newBody, {
        overwrite: true,
        vaultForRelativePath: vault,
      });
      changed.push(p.path);
    } catch {
      // Best-effort: a write failure on one page must not fail the run.
      continue;
    }
  }

  changed.sort();
  return { scanned: pages.length, enriched: changed.length, pages: changed };
}
