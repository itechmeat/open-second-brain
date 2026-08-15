/**
 * Whole-vault (bank) export/import (Brain Portability & Interop suite,
 * Unit A).
 *
 * `exportBankBundle` composes the existing exporters - preferences
 * (`collectExportRows`), the page link-graph (`exportVaultGraph`), the
 * page interchange contract (`projectPageContracts`), and the read-only
 * sources dashboard (`aggregateSources`) - into one schema-versioned
 * envelope for backup, cross-instance migration, or downstream-tool
 * ingest. It forks no serialisation path; it only assembles.
 *
 * `importBankBundle` reconstructs the two sections that round-trip: the
 * page graph, delegated to `importVaultGraph` under a conflict mode, and
 * the preferences, delegated to `restorePreferences` and through it to
 * `writePreferenceTxn` - the single chokepoint that owns the confidence
 * band, the trial window, the revision counter and the audit trail.
 * Preferences are not restored DESPITE that lifecycle but THROUGH it;
 * the alternative this module refused from the start - a raw write that
 * flattens the lifecycle - is still refused.
 *
 * The remaining sections are carried for fidelity and NOT restored: the
 * page contract is a read projection and the sources dashboard is
 * derived, so both are recomputed from the vault rather than written
 * into it. The result object names each of them, and names the exported
 * preference fields a write cannot reconstruct, so the bundle can never
 * be read as a full round-trip of material it did not reconstruct.
 *
 * `BANK_BUNDLE_SCHEMA_VERSION` stays `"1"`. Restoring preferences is
 * additive on both sides: an envelope written before the restore existed
 * carries rows without the trial window, and those rows are refused
 * per-entry with a named reason rather than by refusing the envelope.
 * Bumping the version would turn every existing bundle into a hard
 * refusal for material this reader already handles honestly.
 *
 * The same per-entry rule covers the other thing an older bundle can
 * carry: the redactor's placeholder in a field that names the record. The
 * export boundary now refuses to emit one, but a bundle already on disk
 * can hold it, and a placeholder is a constant - two records that lost a
 * name land on one. Both halves refuse those records and restore the rest:
 * preferences through `redacted_identifier` in `preferences.failed[]`, page
 * nodes through `graph.rejected[]`.
 */

import { collectExportRows, type ExportedPreferenceRow } from "../export.ts";
import { isoSecond } from "../time.ts";
import { vaultDisplayName } from "../templates.ts";
import {
  exportVaultGraph,
  importVaultGraph,
  type GraphImportMode,
  type GraphImportResult,
  type VaultGraph,
} from "./graph.ts";
import { projectPageContracts, type PageContract } from "./page-contract.ts";
import { restorePreferences, type PreferenceRestoreResult } from "./preference-restore.ts";
import { aggregateSources, type SourcesReport } from "./sources.ts";

export const BANK_BUNDLE_SCHEMA_VERSION = "1";

export interface BankBundle {
  readonly schema: string;
  /** Snapshot timestamp (ISO second). Not part of the content sections. */
  readonly generated_at: string;
  readonly vault_basename: string;
  readonly preferences: ReadonlyArray<ExportedPreferenceRow>;
  readonly graph: VaultGraph;
  readonly pages: ReadonlyArray<PageContract>;
  readonly sources: SourcesReport;
}

/**
 * Export a whole-vault bank bundle. The content sections are
 * deterministic (each underlying exporter sorts); only `generated_at`
 * varies between runs. Pure and read-only on the vault.
 */
export function exportBankBundle(vault: string): BankBundle {
  return {
    schema: BANK_BUNDLE_SCHEMA_VERSION,
    generated_at: isoSecond(),
    vault_basename: vaultDisplayName(vault),
    preferences: collectExportRows(vault),
    graph: exportVaultGraph(vault),
    pages: projectPageContracts(vault),
    sources: aggregateSources(vault),
  };
}

/** Raised when a whole-bundle invariant fails (e.g. an unknown schema). */
export class BankImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankImportError";
  }
}

export interface BankImportResult {
  readonly schema: string;
  /** Page-graph reconstruction outcome (delegated to importVaultGraph). */
  readonly graph: GraphImportResult;
  /**
   * Preference reconstruction outcome (delegated to the audited
   * transaction): what was carried, what landed, what was refused and
   * why, and which exported fields a write cannot reconstruct.
   */
  readonly preferences: PreferenceRestoreResult;
  /** Page-contract records present in the bundle but not restored (a read projection). */
  readonly pagesCarried: number;
  /** Whether the bundle carried a sources dashboard (derived; not restored). */
  readonly sourcesCarried: boolean;
}

/** Rows the preferences section carries; see the call site for the rule. */
function preferenceSection(section: unknown): ReadonlyArray<unknown> {
  if (section === undefined || section === null) return [];
  return Array.isArray(section) ? section : [section];
}

/** Loosely-typed bundle input - untrusted JSON, validated here. */
interface BankBundleInput {
  readonly schema?: unknown;
  readonly graph?: { readonly nodes?: ReadonlyArray<unknown> };
  readonly preferences?: unknown;
  readonly pages?: unknown;
  readonly sources?: unknown;
}

/**
 * Import a bank bundle: reconstruct the page graph and the preferences,
 * and report what else the bundle carried. An unsupported schema fails
 * loudly with a {@link BankImportError}; a malformed individual graph
 * node or preference row is rejected per-entry and the run continues.
 *
 * `mode` governs the PAGE graph only. Preferences are governed by their
 * revision: a bundle behind the vault, or divergent at the same
 * revision, is refused per-row. Wiring the graph's conflict mode into
 * the preference restore would add a way to discard carried rules while
 * still reporting a successful import, which is the failure this unit
 * exists to remove.
 */
export function importBankBundle(
  vault: string,
  bundle: BankBundleInput,
  opts: { mode?: GraphImportMode; agent?: string } = {},
): BankImportResult {
  if (bundle === null || typeof bundle !== "object") {
    throw new BankImportError("invalid bank bundle payload: expected an object");
  }
  if (bundle.schema !== BANK_BUNDLE_SCHEMA_VERSION) {
    throw new BankImportError(
      `unsupported bank bundle schema: expected ${BANK_BUNDLE_SCHEMA_VERSION}, got ${String(bundle.schema)}`,
    );
  }

  const graphInput = bundle.graph ?? { nodes: [] };
  const graph = importVaultGraph(vault, graphInput, { mode: opts.mode ?? "skip" });
  // An absent section carried nothing. A present section that is not an
  // array carried SOMETHING unreadable, so it travels as a single row and
  // is refused by the row guard - reporting it as zero carried rows would
  // be the same silent drop this unit removes.
  const preferenceRows = preferenceSection(bundle.preferences);
  const preferences = restorePreferences(
    vault,
    preferenceRows,
    opts.agent !== undefined ? { agent: opts.agent } : {},
  );

  return {
    schema: BANK_BUNDLE_SCHEMA_VERSION,
    graph,
    preferences,
    pagesCarried: Array.isArray(bundle.pages) ? bundle.pages.length : 0,
    sourcesCarried: bundle.sources !== undefined && bundle.sources !== null,
  };
}
