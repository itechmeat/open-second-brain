/**
 * Shared plumbing of the advisory decision-model uses (issue #213, Parts
 * 5 and 6: `dedup`, `tension`, `labels`).
 *
 * An advisory use annotates a proposal the deterministic code already
 * made with a verdict and its probabilities. It never writes to the
 * vault, never hides a proposal and never blocks an answer: on any
 * failure its field is simply absent.
 *
 * This module only resolves the configuration for a vault and a side of
 * a pair from a page on disk; the request itself goes through
 * `runDecision`.
 */

import { readFileSync } from "node:fs";

import { discoverConfig } from "../config.ts";
import { pageVisibility } from "../graph/visibility.ts";
import { privateRegionTexts } from "../redactor.ts";
import { parseFrontmatter } from "../vault.ts";
import {
  decisionModelModeFor,
  resolveDecisionModelConfig,
  type ResolvedDecisionModelConfig,
} from "./config.ts";
import type { DecisionModelUse, DecisionProvider } from "./contract.ts";

/** Injection points shared by every advisory use (tests pass a fake). */
export interface AdvisoryDecisionOptions {
  /** A resolved config; defaults to the operator config for the vault. */
  readonly config?: ResolvedDecisionModelConfig | null;
  /** The operator config file the caller was started against. */
  readonly configPath?: string | null;
  readonly provider?: DecisionProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The decision config for `vault`, never throwing: an unreadable config
 * file is treated as no config (the use stays off).
 */
export function advisoryDecisionConfig(
  vault: string,
  opts: AdvisoryDecisionOptions,
): ResolvedDecisionModelConfig | null {
  if (opts.config !== undefined) return opts.config;
  try {
    const data = discoverConfig(opts.configPath ?? undefined).data;
    return resolveDecisionModelConfig({
      config: data,
      vault,
      ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
  } catch {
    return null;
  }
}

/** Whether `use` would run at all under `cfg` (anything but `off`). */
export function advisoryUseActive(
  cfg: ResolvedDecisionModelConfig | null,
  use: DecisionModelUse,
): boolean {
  return decisionModelModeFor(cfg, use) !== "off";
}

/** Privacy facts about the page one side of a pair comes from. */
export interface PageEgressFacts {
  /** Visibility tokens, or null when the page could not be read. */
  readonly visibility: ReadonlyArray<string> | null;
  /** The page's own `<private>` regions, or null when unreadable. */
  readonly privateRegions: ReadonlyArray<string> | null;
}

const UNREADABLE: PageEgressFacts = Object.freeze({ visibility: null, privateRegions: null });

/**
 * Visibility and private regions of the page at `absPath`. Anything that
 * cannot be read resolves to null facts, which the state builder never
 * sends.
 */
export function pageEgressFacts(absPath: string | null): PageEgressFacts {
  if (absPath === null) return UNREADABLE;
  try {
    const [meta] = parseFrontmatter(absPath);
    const text = readFileSync(absPath, "utf8");
    return { visibility: pageVisibility(meta), privateRegions: privateRegionTexts(text) };
  } catch {
    return UNREADABLE;
  }
}
