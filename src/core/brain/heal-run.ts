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
import { assertVaultIdentityForWrite } from "./vault-identity.ts";
import {
  OPERATION,
  progressCounter,
  withProgress,
  type ProgressCounter,
  type ProgressSink,
} from "./progress.ts";
import type { Safeguard } from "./safeguard.ts";

/** The one stage this pass has: it walks the vault's user pages. */
const HEAL_ENRICH_STAGE = "heal-enrich";

/**
 * What a caller may hand the enrichment.
 *
 * Same pair, same reason as `ScanBrainOptions`: reached through
 * `runDreamStep` this is the whole call, and it reads and rewrites every
 * user page in the vault. Inside a full pass the dream run owns the
 * counter and passes no sink, so the counter here stays inert and the
 * pass costs what it did before - but it DOES pass the safeguard, because
 * the enrichment is the same unbounded walk on either path.
 *
 * ## Exactly what the deadline bounds
 *
 * Cooperative means bounded at the boundaries the code crosses, and this
 * pass has two phases that cross none. Naming them is the honest half of
 * the contract:
 *
 *   - {@link listVaultPages} walks the whole vault and parses the
 *     frontmatter of every page in one call. It is the first thing the
 *     run does and it is NOT interruptible: the deadline is honoured on
 *     the checkpoint immediately after it returns.
 *   - {@link prepareHealPhrases} sorts and regex-escapes the entire
 *     title/alias set in one native `toSorted` plus one map, and is NOT
 *     interruptible either. The deadline is honoured on the checkpoint
 *     immediately BEFORE it - so an already-elapsed budget never pays for
 *     the build - and again on the first page of the rewrite loop.
 *
 * Everything else - both per-page loops, read and rewrite alike - is
 * checked once per page. So the guarantee is "stops within one page-read
 * plus one listing plus one phrase build", not "stops within one page";
 * `docs/mcp.md`'s `step` row says the same thing rather than claiming the
 * whole step is bounded.
 */
export interface HealRunOptions {
  /**
   * Cooperative deadline; checked once per page in each of the two
   * loops, plus once on each side of the two uninterruptible phases named
   * above.
   */
  readonly safeguard?: Safeguard;
  /** Where this pass reports, when it is the whole run. */
  readonly onProgress?: ProgressSink;
}

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
export function runHealEnrichment(vault: string, opts: HealRunOptions = {}): HealRunResult {
  const progress = progressCounter(OPERATION.dream, opts.onProgress);
  return withProgress(progress, () => healEnrichmentRun(vault, opts, progress));
}

function healEnrichmentRun(
  vault: string,
  opts: HealRunOptions,
  progress: ProgressCounter,
): HealRunResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  // BRAIN_ROOT_REL is the Brain dir name relative to the vault (its
  // first path segment is the dir to skip). The skipDirs option REPLACES
  // the default exclusions, so the Brain root is added to the standard
  // set (.git / .obsidian / .trash / .stversions) rather than replacing
  // it - heal must never rewrite Syncthing version history, Obsidian
  // config, or the trash.
  const brainDir = BRAIN_ROOT_REL.split("/")[0] ?? "Brain";
  const pages = listVaultPages(vault, { skipDirs: [...EXCLUDED_DIRS, brainDir] });
  // The stage opens with its denominator, which is why it opens HERE and
  // not before the listing: the page count is the one number a reader
  // wants and it does not exist until the walk returns. It still opens
  // BEFORE the first checkpoint, so a guard that has already elapsed
  // produces a stream that spoke and then stopped rather than silence.
  progress.start(HEAL_ENRICH_STAGE, pages.length);
  // The listing walk is itself unbounded in the vault's size and crosses
  // no per-page boundary, so the deadline is honoured once it returns -
  // otherwise a vault with nothing to enrich could never trip one. It
  // cannot be honoured DURING the walk without a safeguard parameter on
  // `listVaultPages`, which every other caller of that walker would then
  // carry; the header states the residual bound rather than implying one
  // that does not exist.
  opts.safeguard?.checkpoint();

  // Build the known title/alias index from every page once, plus a
  // per-page exclusion map so a page is never linked to its own title
  // OR its own aliases.
  const known = new Set<string>();
  const ownTokens = new Map<string, Set<string>>();
  for (const p of pages) {
    // Both loops are per page and both are unbounded in the vault's size,
    // so both honour the deadline. Only the second one ticks: one stage
    // whose counter ran to the page count twice would report a pass of
    // twice the length it has.
    opts.safeguard?.checkpoint();
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
  //
  // That "once" is a single native sort over every title and alias in the
  // vault - unbounded in the vault's size and crossing no boundary of its
  // own, exactly like the listing above. The deadline is honoured here,
  // before the build, so a guard that has already elapsed refuses to pay
  // for it; the first page of the rewrite loop honours it on the far
  // side. The build itself is not interruptible, and the header says so.
  opts.safeguard?.checkpoint();
  const prepared = prepareHealPhrases([...known]);

  const changed: string[] = [];
  for (const p of pages) {
    opts.safeguard?.checkpoint();
    progress.advance(HEAL_ENRICH_STAGE);
    // Unit F: `parseFrontmatter` cannot throw (it reads inside its own
    // try; everything after is string work), so the `catch { continue }`
    // that stood here was unreachable - a page was never actually
    // skipped by it. Dropped lines and unreadable reads are reported
    // centrally instead; see the "Why most readers keep the two-tuple
    // form" section in src/core/vault.ts. An unreadable page still
    // yields an empty map here and plans no change, so heal stays
    // hygiene: it never rewrites what it could not read.
    const [meta, body] = parseFrontmatter(p.path);
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
