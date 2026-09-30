/**
 * The embeddings-health check (t_f99250aa).
 *
 * The signals it consolidates already existed - the pending-vector census
 * with its unrecorded-is-not-zero contract, the index counts including
 * `staleEmbeddings`, the provider facts `o2b search check` owns - but
 * nothing looked at them together where an operator looks. What this file
 * pins is the check's own judgements: which states become a warning, which
 * reach the uncertain stream, which are silence, and that a failed read is
 * never reported as a healthy index.
 *
 * The index probe is injected, following `makeEmbeddingSunsetCheck`: the
 * facts are data the check reads rather than logic it owns, so every
 * verdict is reachable from a test without building a real index.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  EMBEDDINGS_BACKLOG_CODE,
  EMBEDDINGS_CENSUS_UNRECORDED_CODE,
  EMBEDDINGS_HEALTH_UNMEASURED_CODE,
  embeddingsHealthCheck,
  makeEmbeddingsHealthCheck,
  type EmbeddingsHealthProbe,
  type EmbeddingsHealthProbeSnapshot,
} from "../../../../src/core/brain/doctor/embeddings-health-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import type { PendingVectorCensus } from "../../../../src/core/search/types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-embed-health-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-embed-health-cfg-"));
  configPath = join(configHome, "config.yaml");
  bootstrapBrain(vault);
  configure("vendor-x/embed-v1", "8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Semantic search on, an openai-compatible endpoint, `model` at `dim`. */
function configure(model: string, dimension: string): void {
  writeFileSync(
    configPath,
    [
      `vault: ${vault}`,
      `search_semantic_enabled: "true"`,
      `embedding_provider: "openai-compat"`,
      `embedding_base_url: "https://example.invalid/v1"`,
      `embedding_model: "${model}"`,
      `embedding_dimension: "${dimension}"`,
    ].join("\n") + "\n",
  );
}

function measured(pending: number, chunks: number): PendingVectorCensus {
  return { verdict: "measured", pending, chunks };
}

/** A fully embedded, current, recently indexed index - the healthy shape. */
function snapshot(
  overrides: Partial<EmbeddingsHealthProbeSnapshot> = {},
): EmbeddingsHealthProbeSnapshot {
  return {
    census: measured(0, 10),
    staleEmbeddings: 0,
    lastIndexedAt: new Date(NOW.getTime() - MS_PER_DAY).toISOString(),
    ...overrides,
  };
}

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(
  probe: EmbeddingsHealthProbe = () => snapshot(),
  now: Date = NOW,
  configOverride: string | null = null,
): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  makeEmbeddingsHealthCheck(probe).run(
    { vault, now, configPath: configOverride ?? configPath } as unknown as DoctorCheckContext,
    { issues, uncertain },
  );
  return { issues, uncertain };
}

function backlog(result: RunResult): ReadonlyArray<DoctorIssue> {
  return result.issues.filter((i) => i.code === EMBEDDINGS_BACKLOG_CODE);
}

describe("a fully embedded index is silent", () => {
  test("pending zero, stale zero, no issue on either stream", () => {
    const result = run();
    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("semantic search switched off says nothing - there is no index to be sick", () => {
    writeFileSync(configPath, `vault: ${vault}\nsearch_semantic_enabled: "false"\n`);
    let probed = 0;
    const result = run(() => {
      probed++;
      return snapshot();
    });
    expect(probed).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });
});

describe("a backlog is one warning naming both counts and both commands", () => {
  test("pending vectors warn with the backfill command", () => {
    const result = run(() => snapshot({ census: measured(3, 10) }));
    const issues = backlog(result);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("3");
    expect(issues[0]!.message).toContain("o2b search vector-backfill");
  });

  test("stale vectors warn with the provider check command", () => {
    const result = run(() => snapshot({ staleEmbeddings: 4 }));
    const issues = backlog(result);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("4");
    expect(issues[0]!.message).toContain("o2b search check");
  });

  test("both conditions at once stay one finding", () => {
    const result = run(() => snapshot({ census: measured(2, 10), staleEmbeddings: 5 }));
    expect(backlog(result).length).toBe(1);
  });

  test("the index age rides the message and the clock is injected", () => {
    const thirtyDays = new Date(NOW.getTime() - 30 * MS_PER_DAY).toISOString();
    const pending = measured(2, 10);
    const early = run(() => snapshot({ census: pending, lastIndexedAt: thirtyDays }), NOW);
    const later = run(
      () => snapshot({ census: pending, lastIndexedAt: thirtyDays }),
      new Date(NOW.getTime() + 10 * MS_PER_DAY),
    );
    expect(backlog(early)[0]!.message).toContain("30");
    // The same index a clock further on reads as older: the age is computed
    // against the context's clock, never one the check read for itself.
    expect(backlog(later)[0]!.message).toContain("40");
  });
});

describe("an unrecorded census is uncertain, never healthy", () => {
  test("the census reason reaches the uncertain stream verbatim", () => {
    const result = run(() =>
      snapshot({ census: { verdict: "unrecorded", reason: "no search index at /gone/index.db" } }),
    );
    expect(result.issues).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === EMBEDDINGS_CENSUS_UNRECORDED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("no search index at /gone/index.db");
  });

  test("an unrecorded census never shares the silence of a healthy one", () => {
    const healthy = run();
    const unrecorded = run(() =>
      snapshot({ census: { verdict: "unrecorded", reason: "no search index at /gone/index.db" } }),
    );
    expect(healthy.issues).toEqual([]);
    expect(healthy.uncertain).toEqual([]);
    expect(unrecorded.uncertain.length).toBeGreaterThan(0);
  });
});

describe("a half-read index is not a healthy one", () => {
  test("a measured census beside an unreadable count is uncertain, not silence", () => {
    // The census opened the file; the count half could not be read. Zero
    // stale is exactly the answer that reads as healthy, so a null count
    // may never collapse into it.
    const result = run(() => snapshot({ staleEmbeddings: null }));
    expect(result.issues).toEqual([]);
    expect(result.uncertain.some((e) => e.code === EMBEDDINGS_HEALTH_UNMEASURED_CODE)).toBe(true);
  });
});

describe("a throwing probe degrades to uncertain", () => {
  test("the throw is caught and reported, never propagated", () => {
    const result = run(() => {
      throw new Error("disk on fire");
    });
    expect(result.issues).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === EMBEDDINGS_HEALTH_UNMEASURED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("disk on fire");
  });

  test("the registered check is failSoft", () => {
    expect(embeddingsHealthCheck.failSoft).toBe(true);
  });
});

describe("a search configuration that will not resolve is uncertain", () => {
  test("a config file that fails to load reaches the uncertain stream", () => {
    // A path naming a directory: `discoverConfig` refuses it, which is the
    // cheapest way to make the resolver throw without mocking a module.
    const result = run(undefined, NOW, join(configHome));
    expect(result.issues).toEqual([]);
    expect(result.uncertain.some((e) => e.code === EMBEDDINGS_HEALTH_UNMEASURED_CODE)).toBe(true);
  });
});

describe("the probe reads the index the context names", () => {
  test("ctx.dbPath is the index probed and the path every finding names", () => {
    const seen: string[] = [];
    const issues: DoctorIssue[] = [];
    const uncertain: DoctorUncertainEntry[] = [];
    makeEmbeddingsHealthCheck((dbPath) => {
      seen.push(dbPath);
      return snapshot({ staleEmbeddings: 2 });
    }).run(
      {
        vault,
        now: NOW,
        configPath,
        dbPath: "/elsewhere/index.db",
      } as unknown as DoctorCheckContext,
      { issues, uncertain },
    );
    expect(seen).toEqual(["/elsewhere/index.db"]);
    expect(backlog({ issues, uncertain })[0]!.path).toBe("/elsewhere/index.db");
  });

  test("the probe is handed the configured embedding pair, dimension unset included", () => {
    writeFileSync(
      configPath,
      [
        `vault: ${vault}`,
        `search_semantic_enabled: "true"`,
        `embedding_provider: "openai-compat"`,
        `embedding_base_url: "https://example.invalid/v1"`,
        `embedding_model: "vendor-x/embed-v2"`,
      ].join("\n") + "\n",
    );
    const seen: unknown[] = [];
    run((_dbPath, semantic) => {
      seen.push({ model: semantic.model, dimension: semantic.dimension });
      return snapshot();
    });
    expect(seen).toEqual([{ model: "vendor-x/embed-v2", dimension: null }]);
  });
});

describe("no embedding model to compare against is uncertain, never healthy", () => {
  test("a remote provider with no configured model is unmeasured", () => {
    writeFileSync(
      configPath,
      [
        `vault: ${vault}`,
        `search_semantic_enabled: "true"`,
        `embedding_provider: "openai-compat"`,
        `embedding_base_url: "https://example.invalid/v1"`,
      ].join("\n") + "\n",
    );
    const result = run(() => snapshot());
    expect(result.issues).toEqual([]);
    expect(result.uncertain.some((e) => e.code === EMBEDDINGS_HEALTH_UNMEASURED_CODE)).toBe(true);
  });
});

describe("the check runs from runDoctor itself", () => {
  test("a semantic-enabled vault with no index reports its unrecorded census", () => {
    const result = runDoctor(vault, { now: NOW, configPath });
    expect((result.uncertain ?? []).some((e) => e.code === EMBEDDINGS_CENSUS_UNRECORDED_CODE)).toBe(
      true,
    );
  });
});

describe("every code is classified exactly once", () => {
  test("the warning code carries a registered command", () => {
    expect(DIAGNOSTIC_SIGNALS.has(EMBEDDINGS_BACKLOG_CODE)).toBe(true);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(EMBEDDINGS_BACKLOG_CODE)).toBe(false);
  });

  test("both uncertain codes carry a written reason instead", () => {
    for (const code of [EMBEDDINGS_CENSUS_UNRECORDED_CODE, EMBEDDINGS_HEALTH_UNMEASURED_CODE]) {
      expect(`${code} excluded: ${DOCTOR_EXIT_EXCLUSIONS.has(code)}`).toBe(
        `${code} excluded: true`,
      );
      expect(`${code} registered: ${DIAGNOSTIC_SIGNALS.has(code)}`).toBe(
        `${code} registered: false`,
      );
    }
  });
});
