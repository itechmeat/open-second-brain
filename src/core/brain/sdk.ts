/**
 * In-process SDK (Brain Portability & Interop suite, Unit C).
 *
 * `createBrain(vault)` returns a thin façade over the existing core
 * functions, so other tools, scripts, and agents can manage brain
 * content programmatically without the CLI or MCP layer. Every method is
 * a one-line delegation; the SDK adds no behaviour of its own and forks
 * no logic. It is the in-process analogue of the CLI/MCP surfaces, not a
 * new subsystem.
 *
 * Source-backed writes map to OSB's actual model: `ingestSource` is the
 * write (the upstream `writeStatus` analogue - OSB stamps `updated_at`
 * and rewrites idempotently rather than tracking a separate status
 * lifecycle), and `listSources`/`getSource`/`deleteSource` operate on the
 * `kind: brain-source` summary pages.
 */

import type { CreateNoteInput, CreateNoteResult } from "./notes/create-note.ts";
import { createNote } from "./notes/create-note.ts";
import type { ExportedPreferencesJson } from "./export.ts";
import { exportPreferencesJson, exportPreferencesLlmsTxt } from "./export.ts";
import {
  type BankBundle,
  type BankImportResult,
  exportBankBundle,
  importBankBundle,
} from "./portability/bundle.ts";
import {
  type GraphImportMode,
  type GraphImportResult,
  type VaultGraph,
  exportVaultGraph,
  importVaultGraph,
} from "./portability/graph.ts";
import type {
  IngestSourceInput,
  IngestSourceOptions,
  IngestSourceResult,
} from "./ingest/ingest.ts";
import { ingestSource } from "./ingest/ingest.ts";
import type { IngestedSource, IngestedSourceDetail } from "./ingest/sources-registry.ts";
import {
  deleteIngestedSource,
  getIngestedSource,
  listIngestedSources,
} from "./ingest/sources-registry.ts";

export interface BrainSdk {
  /** The vault every method is bound to. */
  readonly vault: string;

  // Whole-vault bank export/import (Unit A).
  exportBank(): BankBundle;
  importBank(
    bundle: Parameters<typeof importBankBundle>[1],
    opts?: { mode?: GraphImportMode },
  ): BankImportResult;

  // Page link-graph export/import.
  exportGraph(): VaultGraph;
  importGraph(
    graph: { nodes?: ReadonlyArray<unknown> },
    opts?: { mode?: GraphImportMode },
  ): GraphImportResult;

  // Preference export.
  exportPreferencesJson(): ExportedPreferencesJson;
  exportPreferencesLlmsTxt(): string;

  // Source-backed writes + reads.
  ingestSource(input: IngestSourceInput, opts: IngestSourceOptions): IngestSourceResult;
  listSources(): ReadonlyArray<IngestedSource>;
  getSource(id: string): IngestedSourceDetail | null;
  deleteSource(id: string): boolean;

  // Note authoring.
  createNote(input: CreateNoteInput): CreateNoteResult;
}

/**
 * Build an in-process Brain façade bound to one vault. Each method
 * delegates to the corresponding core function.
 */
export function createBrain(vault: string): BrainSdk {
  return {
    vault,

    exportBank: () => exportBankBundle(vault),
    importBank: (bundle, opts) => importBankBundle(vault, bundle, opts ?? {}),

    exportGraph: () => exportVaultGraph(vault),
    importGraph: (graph, opts) => importVaultGraph(vault, graph, opts ?? {}),

    exportPreferencesJson: () => exportPreferencesJson(vault),
    exportPreferencesLlmsTxt: () => exportPreferencesLlmsTxt(vault),

    ingestSource: (input, opts) => ingestSource(vault, input, opts),
    listSources: () => listIngestedSources(vault),
    getSource: (id) => getIngestedSource(vault, id),
    deleteSource: (id) => deleteIngestedSource(vault, id),

    createNote: (input) => createNote(vault, input),
  };
}
