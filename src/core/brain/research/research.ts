/**
 * Parameterized research pipeline (Knowledge Provenance suite).
 *
 * Turns N sources plus an agent-run synthesis into one dated, cited report
 * page in the vault. Each finding cites the source(s) that flagged it, so the
 * report is auditable back to its inputs and becomes a first-class recall
 * input itself.
 *
 * Provider-agnostic: the agent pulls the sources and writes the findings; OSB
 * runs no model. OSB owns the deterministic half - validating that every
 * finding cites at least one of the consulted sources (no uncited claims),
 * stamping provenance, and writing the report page idempotently (one
 * date+title maps to one report, rewritten in place).
 *
 * The citation constraint is the point: a finding with no source, or a finding
 * citing a source that was not consulted, is rejected rather than written as
 * an unprovenanced claim.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { FrontmatterMap } from "../../types.ts";
import { canonicalNotePath } from "../../path-safety.ts";
import { slugify, writeFrontmatterAtomic } from "../../vault.ts";
import { isoDate, isoSecond } from "../time.ts";
import { reportPagePath } from "../paths.ts";
import { renderProvenanceSection, type Provenance } from "../provenance/provenance.ts";
import {
  ExternalFetchError,
  createFetchTransport,
  createMemoryResponseCache,
  type ExternalFetchTransport,
  type KeyedFetchConfig,
  type ResponseCache,
} from "./external-fetch.ts";
import { BRAVE_API_KEY_ENV, BRAVE_PROVIDER_NAME, createBraveProvider } from "./providers/brave.ts";
import {
  TAVILY_API_KEY_ENV,
  TAVILY_PROVIDER_NAME,
  createTavilyProvider,
} from "./providers/tavily.ts";
import type { ProviderSearchResult, ResearchProvider } from "./providers/provider.ts";

export { BRAVE_API_KEY_ENV, BRAVE_PROVIDER_NAME, TAVILY_API_KEY_ENV, TAVILY_PROVIDER_NAME };
export type { ProviderSearchResult, ResearchProvider };

/** Frontmatter `kind:` marker of a research report page. */
export const BRAIN_REPORT_KIND = "brain-report";

/** One finding plus the sources that flagged it. */
export interface ResearchFinding {
  readonly statement: string;
  /** Source identifiers (a subset of the consulted sources) that flagged this. */
  readonly sources: readonly string[];
}

export interface ResearchReportInput {
  readonly title: string;
  readonly findings: readonly ResearchFinding[];
  /** Every source consulted for the report. */
  readonly sources: readonly string[];
}

export interface ResearchReportOptions {
  readonly agent: string;
  readonly now: Date;
}

export interface ResearchReportResult {
  /** Vault-relative path of the report page. */
  readonly reportPath: string;
  readonly created: boolean;
  readonly findingCount: number;
}

/** A research report failed validation; nothing was written. */
export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchValidationError";
  }
}

/** Wrap a bare source identifier in a wikilink; leave an existing one as-is. */
function asWikilink(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith("[[") ? trimmed : `[[${canonicalNotePath(trimmed)}]]`;
}

function validate(input: ResearchReportInput): void {
  if (input.title.trim().length === 0) {
    throw new ResearchValidationError("report title must not be empty");
  }
  if (input.sources.length === 0) {
    throw new ResearchValidationError("a report must consult at least one source");
  }
  if (input.findings.length === 0) {
    throw new ResearchValidationError("a report must contain at least one finding");
  }
  const consulted = new Set(input.sources.map((s) => s.trim()));
  for (const [i, finding] of input.findings.entries()) {
    if (finding.statement.trim().length === 0) {
      throw new ResearchValidationError(`finding[${i}] statement must not be empty`);
    }
    if (finding.sources.length === 0) {
      throw new ResearchValidationError(
        `finding[${i}] must cite at least one source (no uncited claims)`,
      );
    }
    for (const src of finding.sources) {
      if (!consulted.has(src.trim())) {
        throw new ResearchValidationError(
          `finding[${i}] cites a source not in the consulted set: ${JSON.stringify(src)}`,
        );
      }
    }
  }
}

/**
 * Write a dated, cited research report. Validates the citation contract first
 * (throwing {@link ResearchValidationError} with no write on failure), then
 * writes the report page idempotently on the date+title path.
 */
export function writeResearchReport(
  vault: string,
  input: ResearchReportInput,
  opts: ResearchReportOptions,
): ResearchReportResult {
  validate(input);

  const date = isoDate(opts.now);
  const stamp = isoSecond(opts.now);
  const absPath = reportPagePath(vault, date, slugify(input.title));

  const findingLines = input.findings.map((f) => {
    const cites = f.sources.map(asWikilink).join(", ");
    return `- ${f.statement.trim()} (cites: ${cites})`;
  });
  const provenance: Provenance = {
    level: "stated",
    sources: input.sources.map(asWikilink),
    premises: [],
  };

  const body = [
    `# ${input.title.trim()}`,
    ["## Findings", "", ...findingLines].join("\n"),
    renderProvenanceSection(provenance),
  ].join("\n\n");

  const meta: FrontmatterMap = {
    kind: BRAIN_REPORT_KIND,
    title: input.title.trim(),
    report_date: date,
    provenance: provenance.level,
    source_count: input.sources.length,
    created_at: stamp,
    updated_at: stamp,
    tags: ["brain", "brain/report"],
  };

  mkdirSync(dirname(absPath), { recursive: true });
  // Idempotent on date+title: a re-run rewrites the same report page in place.
  // existsSync drives the `created` flag; an overwrite write then surfaces a
  // real I/O error directly instead of a catch masking it as a re-run.
  const created = !existsSync(absPath);
  writeFrontmatterAtomic(absPath, meta, body, { overwrite: true });

  return {
    reportPath: canonicalNotePath(relative(vault, absPath)),
    created,
    findingCount: input.findings.length,
  };
}

// ----- Provider pool wiring (R1, t_1dcbf352) --------------------------------
//
// The pool is additive: it holds a provider only when that provider's key env
// is set. A keyless deployment builds an EMPTY pool and the rest of the
// research surface (writeResearchReport) is untouched, so a vault that never
// configures a key behaves byte-identically to before this feature.

/** Resolved provider keys, read from the environment (or an injected map). */
export interface ResearchPoolEnv {
  readonly braveApiKey: string | null;
  readonly tavilyApiKey: string | null;
}

/** Read the provider key envs. An injected map keeps this deterministic in tests. */
export function resolveResearchPoolEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResearchPoolEnv {
  const brave = env[BRAVE_API_KEY_ENV]?.trim();
  const tavily = env[TAVILY_API_KEY_ENV]?.trim();
  return {
    braveApiKey: brave !== undefined && brave.length > 0 ? brave : null,
    tavilyApiKey: tavily !== undefined && tavily.length > 0 ? tavily : null,
  };
}

export interface BuildResearchPoolOptions {
  /** Transport seam; defaults to the real fetch transport for production use. */
  readonly transport?: ExternalFetchTransport;
  /** Shared response cache keyed by normalized request; one is created if absent. */
  readonly cache?: ResponseCache;
}

/** The set of enabled providers, plus an explicit empty-state signal. */
export interface ResearchPool {
  readonly providers: readonly ResearchProvider[];
  /** Names of enabled providers, in wiring order. */
  readonly enabledNames: readonly string[];
  /** True when no provider key was configured. */
  isEmpty(): boolean;
}

/** One provider result with its origin provider name. */
export interface PooledResult extends ProviderSearchResult {
  readonly provider: string;
}

/** A typed provider failure carried in a pool report (never invented content). */
export interface ProviderError {
  readonly provider: string;
  readonly kind: ExternalFetchError["kind"];
  readonly message: string;
}

/** The outcome of running the pool for one query: results plus typed errors. */
export interface ResearchPoolReport {
  readonly results: readonly PooledResult[];
  readonly errors: readonly ProviderError[];
}

/**
 * Build the provider pool from resolved keys. Each provider joins only when its
 * key is present; with no keys the pool is empty and {@link ResearchPool.isEmpty}
 * returns true.
 */
export function buildResearchPool(
  env: ResearchPoolEnv,
  opts: BuildResearchPoolOptions = {},
): ResearchPool {
  const transport = opts.transport ?? createFetchTransport();
  const cache = opts.cache ?? createMemoryResponseCache();
  const providers: ResearchProvider[] = [];

  if (env.braveApiKey !== null) {
    const config: KeyedFetchConfig = { apiKey: env.braveApiKey, transport, cache };
    providers.push(createBraveProvider(config));
  }
  if (env.tavilyApiKey !== null) {
    const config: KeyedFetchConfig = { apiKey: env.tavilyApiKey, transport, cache };
    providers.push(createTavilyProvider(config));
  }

  const enabledNames = providers.map((provider) => provider.name);
  return {
    providers: Object.freeze(providers),
    enabledNames: Object.freeze(enabledNames),
    isEmpty: () => providers.length === 0,
  };
}

/**
 * Run every pooled provider for a query, aggregating results and typed errors.
 * A provider that throws an {@link ExternalFetchError} contributes an error
 * entry, not content; any other throw is rethrown (it is a real defect).
 */
export async function runResearchPool(
  pool: ResearchPool,
  query: string,
): Promise<ResearchPoolReport> {
  const settled = await Promise.all(
    pool.providers.map(
      async (provider): Promise<{ results: PooledResult[]; error: ProviderError | null }> => {
        try {
          const results = await provider.search(query);
          return {
            results: results.map((result) => ({ ...result, provider: provider.name })),
            error: null,
          };
        } catch (err) {
          if (err instanceof ExternalFetchError) {
            return {
              results: [],
              error: { provider: provider.name, kind: err.kind, message: err.message },
            };
          }
          throw err;
        }
      },
    ),
  );

  const results: PooledResult[] = [];
  const errors: ProviderError[] = [];
  for (const outcome of settled) {
    results.push(...outcome.results);
    if (outcome.error !== null) errors.push(outcome.error);
  }
  return { results: Object.freeze(results), errors: Object.freeze(errors) };
}
