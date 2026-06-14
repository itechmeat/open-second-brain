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
 * `importBankBundle` reconstructs the part that round-trips: the page
 * graph, delegated to `importVaultGraph` under a conflict mode. The
 * other sections are carried in the bundle for fidelity but are NOT
 * silently "restored": preferences have a delicate confidence/audit
 * lifecycle, the page contract is a read projection, and the sources
 * dashboard is derived. The result object reports each carried section
 * explicitly so the bundle can never be read as a full round-trip of
 * material it did not reconstruct.
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
  /** Preferences present in the bundle but not restored (lifecycle-sensitive). */
  readonly preferencesCarried: number;
  /** Page-contract records present in the bundle but not restored (a read projection). */
  readonly pagesCarried: number;
  /** Whether the bundle carried a sources dashboard (derived; not restored). */
  readonly sourcesCarried: boolean;
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
 * Import a bank bundle: reconstruct the page graph and report what else
 * the bundle carried. An unsupported schema fails loudly with a
 * {@link BankImportError}; a malformed individual graph node is rejected
 * per-entry by `importVaultGraph` and the run continues.
 */
export function importBankBundle(
  vault: string,
  bundle: BankBundleInput,
  opts: { mode?: GraphImportMode } = {},
): BankImportResult {
  if (bundle.schema !== BANK_BUNDLE_SCHEMA_VERSION) {
    throw new BankImportError(
      `unsupported bank bundle schema: expected ${BANK_BUNDLE_SCHEMA_VERSION}, got ${String(bundle.schema)}`,
    );
  }

  const graphInput = bundle.graph ?? { nodes: [] };
  const graph = importVaultGraph(vault, graphInput, { mode: opts.mode ?? "skip" });

  return {
    schema: BANK_BUNDLE_SCHEMA_VERSION,
    graph,
    preferencesCarried: Array.isArray(bundle.preferences) ? bundle.preferences.length : 0,
    pagesCarried: Array.isArray(bundle.pages) ? bundle.pages.length : 0,
    sourcesCarried: bundle.sources !== undefined && bundle.sources !== null,
  };
}
