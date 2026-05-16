# Brain Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deterministic full-text search over the vault with optional semantic layer, exposed via CLI (`o2b search`) and MCP (`brain_search`).

**Architecture:** New isolated module `src/core/search/` owns walker, chunker, SQLite store (single SQL boundary), FTS query, links, ranker, embedding providers. CLI and MCP consume a resolved config plus the public API. Keyword search is always available; semantic search loads `sqlite-vec` and any OpenAI-compatible `/v1/embeddings` provider when configured.

**Tech Stack:** TypeScript on Bun, `bun:sqlite` (FTS5 built-in), `sqlite-vec` extension (optional), `proper-lockfile`, OpenAI-compatible HTTP embeddings.

**Source of truth for behaviour:** [`docs/plans/2026-05-16-brain-search-design.md`](./2026-05-16-brain-search-design.md). Every task here implements a slice of that spec — if a conflict appears, the spec wins and the plan must be updated.

---

## Plan-wide conventions

These apply to every task; do not re-state them per step.

- **Imports.** Production code uses `node:`-prefixed Node builtins (`node:fs`, `node:path`) and `bun:sqlite`. Tests use `import { test, expect, describe, beforeEach, afterEach } from "bun:test"`. Path: always `.ts` extensions in imports (project convention, `allowImportingTsExtensions: true`).
- **Result shape.** Every public-API return value is `Object.freeze`-d at the call site that produces it. This mirrors `src/core/brain/query.ts`.
- **Errors.** All user-facing errors from this module are instances of `SearchError` (defined in Task 1). Non-`SearchError` exceptions bubble up as-is — do not wrap them.
- **No git from this plan.** The user does git work themselves. Each task ends with **Pause for review (no commit)** instead of `git add`/`git commit`. The reviewer either runs `bun test` themselves to confirm green, or relies on the in-task `bun test ...` output.
- **No bait fallbacks.** "Silent semantic downgrade" is allowed only on the implicit code path (config-default semantic). On the explicit code path (CLI `--semantic`, MCP `semantic: true`) the implementation MUST throw `SearchError` and let CLI/MCP translate to the right exit code.
- **Atomic writes** for any file touched outside SQLite go through `src/core/fs-atomic.ts:atomicWriteFileSync`. SQLite files are mutated through prepared statements inside `BEGIN`/`COMMIT`; the temp-file rename pattern is reserved for `o2b search reindex` (Task 24).
- **Verification.** Every task ends with `bun test tests/path/to/file.test.ts` and an expected pass count. If the suite has > 10 tests, expect `(pass N)` exactly. CI green is `bun test` across the repo — confirmed at the end of each Phase.

## File map

Create:

```
src/core/search/types.ts            — SearchError, BrainSearchResult, IndexStats, IndexStatusSnapshot, IndexCheckReport, SearchOutcome, ResolvedSearchConfig, SearchOptions
src/core/search/paths.ts            — resolveIndexPath(config) → string
src/core/search/schema.ts           — DDL, MIGRATIONS[], applyV1
src/core/search/store.ts            — Store class wrapping bun:sqlite (only SQL home)
src/core/search/walker.ts           — walkVault(config) async-iterates *.md paths
src/core/search/chunker.ts          — chunkMarkdown(text) → BlockChunk[]
src/core/search/links.ts            — extractLinks(content) → ExtractedLink[]
src/core/search/fts.ts              — runFtsQuery(store, query, opts) → FtsHit[]
src/core/search/ranker.ts           — mergeResults(kw, sem, opts) → BrainSearchResult[]
src/core/search/indexer.ts          — indexVault(config, opts), reindexVault, etc.
src/core/search/embeddings/provider.ts        — EmbeddingProvider interface + makeProvider()
src/core/search/embeddings/null-provider.ts   — NullProvider
src/core/search/embeddings/openai-compat.ts   — OpenAICompatProvider
src/core/search/index.ts            — Public re-export surface for CLI + MCP
src/cli/search.ts                   — `o2b search` verb dispatcher
src/mcp/search-tools.ts             — brain_search MCP tool + search status enrichment
tests/helpers/search-fixtures.ts    — createTempVault(name, files), writeMd helper
tests/helpers/mock-embedding.ts     — MockEmbeddingProvider (deterministic sha256 vectors)
tests/helpers/fake-http.ts          — startFakeOpenAi() returns {url, close, setResponse}
tests/core/search/types.test.ts
tests/core/search/paths.test.ts
tests/core/search/config.test.ts
tests/core/search/schema.test.ts
tests/core/search/store.test.ts
tests/core/search/store.vec.test.ts
tests/core/search/walker.test.ts
tests/core/search/chunker.test.ts
tests/core/search/links.test.ts
tests/core/search/fts.test.ts
tests/core/search/ranker.test.ts
tests/core/search/indexer.test.ts
tests/core/search/indexer.embeddings.test.ts
tests/core/search/embeddings.test.ts
tests/core/search/search.test.ts
tests/cli/search.test.ts
tests/mcp/search.test.ts
```

Modify:

```
src/core/config.ts        — extend SECRET_KEY_PARTS list to include 'embedding_api_key' explicitly (belt-and-braces); add config keys to discovery types if needed.
src/core/init.ts          — print semantic-instructions block after vault bootstrap (Task 52).
src/cli/main.ts           — register 'search' verb in dispatcher (Task 30).
src/mcp/tools.ts          — register brain_search + extend second_brain_status payload (Tasks 32, 33).
package.json              — add `sqlite-vec` to optionalDependencies; bump version 0.9.1 → 0.10.0 (Task 53).
pyproject.toml            — bump version 0.9.1 → 0.10.0 via `bun run sync-version` (Task 53).
CHANGELOG.md              — `## 0.10.0` entry (Task 53).
```

---

## Phase 1 — Foundation

Three small modules that everything else depends on. No SQLite yet.

### Task 1: Types and SearchError

**Files:**
- Create: `src/core/search/types.ts`
- Test: `tests/core/search/types.test.ts`

- [ ] **Step 1: Write the failing test for SearchError shape**

`tests/core/search/types.test.ts`:

```ts
import { test, expect } from "bun:test";
import { SearchError } from "../../../src/core/search/types.ts";

test("SearchError carries a typed code", () => {
  const err = new SearchError("INDEX_MISSING", "no index at /tmp/x");
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("SearchError");
  expect(err.code).toBe("INDEX_MISSING");
  expect(err.message).toBe("no index at /tmp/x");
});

test("SearchError preserves stack trace", () => {
  const err = new SearchError("INVALID_INPUT", "bad");
  expect(err.stack).toContain("SearchError");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search/types.test.ts`
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 3: Implement types.ts**

`src/core/search/types.ts`:

```ts
/**
 * Public types for `src/core/search/*`. Plain data — no behaviour, no I/O.
 *
 * Anchored in docs/plans/2026-05-16-brain-search-design.md §12, §14.
 */

export const SEARCH_ERROR_CODES = [
  "INDEX_MISSING",
  "INDEX_UNREADABLE",
  "SCHEMA_MISMATCH",
  "VEC_EXTENSION_UNAVAILABLE",
  "EMBEDDING_DISABLED",
  "EMBEDDING_KEY_MISSING",
  "EMBEDDING_PROVIDER_HTTP",
  "EMBEDDING_PROVIDER_TIMEOUT",
  "EMBEDDING_DIMENSION_MISMATCH",
  "INDEX_LOCKED",
  "INVALID_INPUT",
] as const;
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

export interface BrainSearchResult {
  readonly documentId: number;
  readonly chunkId: number;
  readonly path: string;
  readonly title: string | null;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly keywordScore: number;
  readonly semanticScore: number;
  readonly linkBoost: number;
  readonly recencyBoost: number;
  readonly searchType: "keyword" | "semantic" | "hybrid";
}

export interface IndexStats {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly chunksTotal: number;
  readonly embeddingsComputed: number;
  readonly embeddingsRetries: number;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly durationMs: number;
}

export interface IndexStatusSnapshot {
  readonly indexPath: string;
  readonly exists: boolean;
  readonly schemaVersion: number | null;
  readonly documents: number;
  readonly chunks: number;
  readonly embeddings: number;
  readonly staleEmbeddings: number;
  readonly embeddingModel: string | null;
  readonly embeddingDimension: number | null;
  readonly vecExtension: "loaded" | "unavailable" | "unknown";
  readonly semanticEnabled: boolean;
  readonly embeddingKeyPresent: boolean;
  readonly lastIndexedAt: string | null;
  readonly lastFullIndexAt: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface IndexCheckReport {
  readonly vaultReadable: boolean;
  readonly indexDirWritable: boolean;
  readonly sqliteOk: boolean;
  readonly fts5Ok: boolean;
  readonly vecExtension: "loaded" | "unavailable" | "not-attempted";
  readonly embeddingKeyResolved: boolean;
  readonly providerReachable: boolean | null;   // null = not probed
  readonly providerReason: string | null;
  readonly warnings: ReadonlyArray<string>;
  readonly fatal: ReadonlyArray<string>;
}

export interface SearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly semantic?: boolean | null;
  readonly keywordOnly?: boolean;
  readonly pathPrefix?: string;
  readonly keywordWeight?: number;
  readonly semanticWeight?: number;
}

export interface SearchOutcome {
  readonly results: ReadonlyArray<BrainSearchResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly total: number;
}

export interface ResolvedEmbeddingConfig {
  readonly enabled: boolean;
  readonly provider: "openai-compat" | "disabled";
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly dimension: number | null;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
}

export interface ResolvedSearchConfig {
  readonly vault: string;
  readonly dbPath: string;
  readonly ignorePaths: ReadonlyArray<string>;
  readonly chunkSize: number;
  readonly chunkOverlap: number;
  readonly keywordWeight: number;
  readonly semanticWeight: number;
  readonly semantic: ResolvedEmbeddingConfig;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/core/search/types.test.ts`
Expected: `2 pass, 0 fail`.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (Other modules may still error if they were partially implemented in earlier work — at this point only types.ts is new.)

- [ ] **Step 6: Pause for review (no commit)**

### Task 2: paths.ts — resolveIndexPath

**Files:**
- Create: `src/core/search/paths.ts`
- Test: `tests/core/search/paths.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/core/search/paths.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolveIndexPath } from "../../../src/core/search/paths.ts";

test("default points under <vault>/.open-second-brain", () => {
  expect(resolveIndexPath("/v", null)).toBe("/v/.open-second-brain/brain.sqlite");
});

test("explicit override wins", () => {
  expect(resolveIndexPath("/v", "/tmp/custom.sqlite")).toBe("/tmp/custom.sqlite");
});

test("blank override falls back to default", () => {
  expect(resolveIndexPath("/v", "")).toBe("/v/.open-second-brain/brain.sqlite");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search/paths.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement paths.ts**

`src/core/search/paths.ts`:

```ts
/**
 * Resolve the on-disk location of the search index file.
 *
 * Default: `<vault>/.open-second-brain/brain.sqlite`. Overridable
 * through CLI `--db` or config `search_db_path`.
 */

import { join } from "node:path";

export function resolveIndexPath(vault: string, override: string | null): string {
  if (override && override.trim() !== "") return override;
  return join(vault, ".open-second-brain", "brain.sqlite");
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/core/search/paths.test.ts`
Expected: `3 pass, 0 fail`.

- [ ] **Step 5: Pause for review (no commit)**

### Task 3: resolveSearchConfig

**Files:**
- Create: `src/core/search/index.ts` (just the `resolveSearchConfig` export; will grow later)
- Test: `tests/core/search/config.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/core/search/config.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { SearchError } from "../../../src/core/search/types.ts";

let tmp: string;
let configPath: string;
let origEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_SEARCH_DB",
  "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
  "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL",
  "OPEN_SECOND_BRAIN_EMBEDDING_MODEL",
  "OPEN_SECOND_BRAIN_EMBEDDING_KEY",
  "OPEN_SECOND_BRAIN_EMBEDDING_DIM",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-cfg-"));
  configPath = join(tmp, "config.yaml");
  origEnv = {};
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("defaults are returned when config and env are empty", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.vault).toBe(tmp);
  expect(cfg.dbPath).toBe(join(tmp, ".open-second-brain", "brain.sqlite"));
  expect(cfg.chunkSize).toBe(800);
  expect(cfg.chunkOverlap).toBe(100);
  expect(cfg.keywordWeight).toBe(0.6);
  expect(cfg.semanticWeight).toBe(0.4);
  expect(cfg.semantic.enabled).toBe(false);
  expect(cfg.semantic.provider).toBe("openai-compat");
  expect(cfg.semantic.apiKey).toBeNull();
  expect(cfg.ignorePaths).toContain(".git");
  expect(cfg.ignorePaths).toContain(".open-second-brain");
});

test("env overrides config which overrides defaults", () => {
  writeFileSync(
    configPath,
    [
      `vault: "${tmp}"`,
      `search_chunk_size: "500"`,
      `search_semantic_enabled: "true"`,
      `embedding_base_url: "https://config.example/v1"`,
      `embedding_model: "config-model"`,
      `embedding_api_key: "cfg-key"`,
    ].join("\n") + "\n",
  );
  process.env["OPEN_SECOND_BRAIN_EMBEDDING_MODEL"] = "env-model";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.chunkSize).toBe(500);
  expect(cfg.semantic.enabled).toBe(true);
  expect(cfg.semantic.baseUrl).toBe("https://config.example/v1");
  expect(cfg.semantic.model).toBe("env-model"); // env wins
  expect(cfg.semantic.apiKey).toBe("cfg-key");
});

test("overrides win over both env and config", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_size: "500"\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC"] = "false";
  const cfg = resolveSearchConfig({
    vault: tmp,
    configPath,
    overrides: { keywordWeight: 0.9, semanticWeight: 0.1 },
  });
  expect(cfg.keywordWeight).toBe(0.9);
  expect(cfg.semanticWeight).toBe(0.1);
});

test("invalid numeric value throws INVALID_INPUT", () => {
  writeFileSync(configPath, `vault: "${tmp}"\nsearch_chunk_size: "not-a-number"\n`);
  let err: SearchError | null = null;
  try {
    resolveSearchConfig({ vault: tmp, configPath });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err).not.toBeNull();
  expect(err?.code).toBe("INVALID_INPUT");
  expect(err?.message).toContain("search_chunk_size");
});

test("weights summing above 1 is rejected", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_keyword_weight: "0.7"\nsearch_semantic_weight: "0.5"\n`,
  );
  expect(() => resolveSearchConfig({ vault: tmp, configPath })).toThrow(/sum.*1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search/config.test.ts`
Expected: FAIL with "Cannot find module" (resolveSearchConfig not exported yet).

- [ ] **Step 3: Implement resolveSearchConfig**

`src/core/search/index.ts`:

```ts
/**
 * Public surface for `src/core/search/*`. Currently exports the config
 * resolver only; indexer/search/status/check are added in later phases.
 */

import { discoverConfig } from "../config.ts";
import { resolveIndexPath } from "./paths.ts";
import { SearchError } from "./types.ts";
import type { ResolvedSearchConfig, ResolvedEmbeddingConfig } from "./types.ts";

const DEFAULT_IGNORE_PATHS = [
  ".git",
  "node_modules",
  ".open-second-brain",
  ".obsidian/cache",
  ".trash",
  ".stversions",
];

const DEFAULTS = {
  chunkSize: 800,
  chunkOverlap: 100,
  keywordWeight: 0.6,
  semanticWeight: 0.4,
  provider: "openai-compat" as const,
  timeoutMs: 10_000,
  concurrency: 4,
  batchSize: 32,
};

function envOrConfig(
  env: NodeJS.ProcessEnv,
  config: Record<string, string>,
  envKey: string,
  configKey: string,
): string | null {
  const e = env[envKey];
  if (e !== undefined && e !== "") return e;
  const c = config[configKey];
  if (c !== undefined && c !== "") return c;
  return null;
}

function parseInteger(raw: string | null, fallback: number, fieldName: string): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be an integer, got '${raw}'`);
  }
  return n;
}

function parseFloat01(raw: string | null, fallback: number, fieldName: string): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new SearchError("INVALID_INPUT", `${fieldName} must be a number in [0, 1], got '${raw}'`);
  }
  return n;
}

function parseBool(raw: string | null, fallback: boolean, fieldName: string): boolean {
  if (raw === null) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new SearchError("INVALID_INPUT", `${fieldName} must be 'true' or 'false', got '${raw}'`);
}

function parseProvider(raw: string | null): ResolvedEmbeddingConfig["provider"] {
  if (raw === null) return DEFAULTS.provider;
  if (raw === "openai-compat" || raw === "disabled") return raw;
  throw new SearchError("INVALID_INPUT", `embedding_provider must be 'openai-compat' or 'disabled', got '${raw}'`);
}

function parseIgnorePaths(raw: string | null): string[] {
  if (raw === null) return DEFAULT_IGNORE_PATHS;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function resolveSearchConfig(opts: {
  vault: string;
  configPath?: string;
  overrides?: Partial<ResolvedSearchConfig>;
}): ResolvedSearchConfig {
  const env = process.env;
  const config = opts.configPath
    ? discoverConfig(opts.configPath).data
    : {} as Record<string, string>;

  const dbPath = resolveIndexPath(
    opts.vault,
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_DB", "search_db_path"),
  );

  const chunkSize = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE", "search_chunk_size"),
    DEFAULTS.chunkSize,
    "search_chunk_size",
  );
  const chunkOverlap = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_CHUNK_OVERLAP", "search_chunk_overlap"),
    DEFAULTS.chunkOverlap,
    "search_chunk_overlap",
  );
  const keywordWeight = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_KW_WEIGHT", "search_keyword_weight"),
    DEFAULTS.keywordWeight,
    "search_keyword_weight",
  );
  const semanticWeight = parseFloat01(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SEM_WEIGHT", "search_semantic_weight"),
    DEFAULTS.semanticWeight,
    "search_semantic_weight",
  );
  if (keywordWeight + semanticWeight > 1.0 + 1e-9) {
    throw new SearchError(
      "INVALID_INPUT",
      `keyword_weight + semantic_weight must sum to <= 1, got ${keywordWeight} + ${semanticWeight}`,
    );
  }

  const ignorePaths = parseIgnorePaths(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_IGNORE", "search_ignore_paths"),
  );

  const semanticEnabled = parseBool(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC", "search_semantic_enabled"),
    false,
    "search_semantic_enabled",
  );
  const provider = parseProvider(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER", "embedding_provider"),
  );
  const baseUrl = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_BASE_URL", "embedding_base_url");
  const model = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_MODEL", "embedding_model");
  const apiKey = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_KEY", "embedding_api_key");
  const dimRaw = envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_DIM", "embedding_dimension");
  const dimension = dimRaw === null ? null : parseInteger(dimRaw, 0, "embedding_dimension");
  const timeoutMs = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_TIMEOUT", "embedding_timeout_ms"),
    DEFAULTS.timeoutMs,
    "embedding_timeout_ms",
  );
  const concurrency = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_CONCURRENCY", "embedding_concurrency"),
    DEFAULTS.concurrency,
    "embedding_concurrency",
  );
  const batchSize = parseInteger(
    envOrConfig(env, config, "OPEN_SECOND_BRAIN_EMBEDDING_BATCH", "embedding_batch_size"),
    DEFAULTS.batchSize,
    "embedding_batch_size",
  );

  const semantic: ResolvedEmbeddingConfig = Object.freeze({
    enabled: semanticEnabled,
    provider,
    baseUrl,
    model,
    apiKey,
    dimension,
    timeoutMs,
    concurrency,
    batchSize,
  });

  const base: ResolvedSearchConfig = Object.freeze({
    vault: opts.vault,
    dbPath,
    ignorePaths: Object.freeze([...ignorePaths]),
    chunkSize,
    chunkOverlap,
    keywordWeight,
    semanticWeight,
    semantic,
  });

  if (!opts.overrides) return base;
  return Object.freeze({
    ...base,
    ...opts.overrides,
    semantic: Object.freeze({ ...base.semantic, ...(opts.overrides.semantic ?? {}) }),
    ignorePaths: opts.overrides.ignorePaths
      ? Object.freeze([...opts.overrides.ignorePaths])
      : base.ignorePaths,
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/core/search/config.test.ts`
Expected: `5 pass, 0 fail`.

- [ ] **Step 5: Run wider typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Pause for review (no commit)**
