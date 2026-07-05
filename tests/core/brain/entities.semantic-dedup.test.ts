/**
 * Semantic (embedding cosine) entity dedup
 * (semantic-retrieval-precision, parent t_47fd9523).
 *
 * A proposal-only pass that surfaces lexical variants of the same
 * real-world entity ("Google LLC" vs "Google Inc") as alias-merge
 * CANDIDATES, complementing the deterministic `entityIdentityKey`. It
 * NEVER rewrites the identity key or any entity file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { buildEntityIndex } from "../../../src/core/brain/entities/index-builder.ts";
import { entityIdentityKey } from "../../../src/core/brain/entities/canonical.ts";
import {
  detectEntityAliasCandidates,
  entityLexicalAliasCandidates,
  entityEvolutionChain,
  deriveIdentityType,
  ENTITY_DEDUP_EMBEDDING_THRESHOLD,
} from "../../../src/core/brain/entities/semantic-dedup.ts";
import type { EmbeddingProvider } from "../../../src/core/search/embeddings/provider.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-02T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-entity-dedup-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-entity-dedup-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seed(category: string, name: string, aliases?: string[]): void {
  upsertEntity(vault, {
    category,
    name,
    ...(aliases ? { aliases } : {}),
    agent: "test-agent",
    now: NOW,
  });
}

/** Provider that maps specific names to fixed unit vectors. */
function fixedVectorProvider(vectors: Readonly<Record<string, number[]>>): EmbeddingProvider {
  return {
    name: "fixed",
    model: "fixed-test",
    dimension: 3,
    embed: (texts) => Promise.resolve(texts.map((t) => vectors[t] ?? [0, 0, 1])),
    ping: () => Promise.resolve({ ok: true as const, dimension: 3 }),
  };
}

describe("detectEntityAliasCandidates - embedding layer", () => {
  test("surfaces lexical variants as an embedding candidate; never rewrites the key", async () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");

    const before = buildEntityIndex(vault);
    const keyLlc = entityIdentityKey("org", "Google LLC");
    const keyInc = entityIdentityKey("org", "Google Inc");
    const raw = before.entities.map((e) => readFileSync(e.path, "utf8"));

    const provider = fixedVectorProvider({
      "Google LLC": [1, 0, 0],
      "Google Inc": [0.999, 0.0447, 0],
    });
    const result = await detectEntityAliasCandidates(vault, { provider });

    expect(result.method).toBe("embedding");
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.method).toBe("embedding");
    expect(c.category).toBe("org");
    expect([c.name_a, c.name_b].toSorted()).toEqual(["Google Inc", "Google LLC"]);
    expect(c.similarity).toBeGreaterThanOrEqual(ENTITY_DEDUP_EMBEDDING_THRESHOLD);

    // Proposal-only: the deterministic keys and every entity file are unchanged.
    expect(entityIdentityKey("org", "Google LLC")).toBe(keyLlc);
    expect(entityIdentityKey("org", "Google Inc")).toBe(keyInc);
    const after = buildEntityIndex(vault);
    expect(after.entities.map((e) => readFileSync(e.path, "utf8"))).toEqual(raw);
  });

  test("distinct entities below the threshold are not surfaced", async () => {
    seed("org", "Google LLC");
    seed("org", "Amazon Inc");
    const provider = fixedVectorProvider({
      "Google LLC": [1, 0, 0],
      "Amazon Inc": [0, 1, 0],
    });
    const result = await detectEntityAliasCandidates(vault, { provider });
    expect(result.method).toBe("embedding");
    expect(result.candidates).toHaveLength(0);
  });

  test("does not pair entities in different categories", async () => {
    seed("org", "Mercury");
    seed("people", "Mercury Jones");
    const provider = fixedVectorProvider({
      Mercury: [1, 0, 0],
      "Mercury Jones": [1, 0, 0],
    });
    const result = await detectEntityAliasCandidates(vault, { provider });
    expect(result.candidates).toHaveLength(0);
  });

  test("does not re-nominate a pair already linked by an alias", async () => {
    seed("org", "Google LLC", ["Google Inc"]);
    seed("org", "Google Inc"); // resolves to the same entity via alias — one file only
    const provider = fixedVectorProvider({ "Google LLC": [1, 0, 0] });
    const result = await detectEntityAliasCandidates(vault, { provider });
    expect(result.candidates).toHaveLength(0);
  });

  test("candidate emission is deterministic across two runs", async () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");
    seed("org", "Google Incorporated");
    const provider = fixedVectorProvider({
      "Google LLC": [1, 0, 0],
      "Google Inc": [0.999, 0.0447, 0],
      "Google Incorporated": [0.998, 0.0632, 0],
    });
    const a = await detectEntityAliasCandidates(vault, { provider });
    const b = await detectEntityAliasCandidates(vault, { provider });
    expect(a).toEqual(b);
    // Stable order by (category, a, b) — field-wise, not joined-string.
    const keys = a.candidates.map((c) => [c.category, c.a, c.b]);
    const sorted = keys.toSorted(
      (x, y) =>
        x[0]!.localeCompare(y[0]!) || x[1]!.localeCompare(y[1]!) || x[2]!.localeCompare(y[2]!),
    );
    expect(keys).toEqual(sorted);
  });
});

describe("detectEntityAliasCandidates - lexical fallback", () => {
  test("no provider → lexical fallback, clearly labeled method:lexical", async () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");
    const result = await detectEntityAliasCandidates(vault, {
      provider: null,
      lexicalThreshold: 0.3,
    });
    expect(result.method).toBe("lexical");
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.every((c) => c.method === "lexical")).toBe(true);
  });

  test("provider that throws falls back to lexical, never throws", async () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");
    const boom: EmbeddingProvider = {
      name: "boom",
      model: "boom",
      dimension: 3,
      embed: () => Promise.reject(new Error("provider down")),
      ping: () => Promise.resolve({ ok: false as const, reason: "down" }),
    };
    const result = await detectEntityAliasCandidates(vault, {
      provider: boom,
      lexicalThreshold: 0.3,
    });
    expect(result.method).toBe("lexical");
  });

  test("unconfigured vault (provider undefined) resolves to null → lexical, no throw", async () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");
    // No embedding provider configured for this vault: real resolution
    // returns null and the pass degrades to the deterministic layer.
    const result = await detectEntityAliasCandidates(vault, { lexicalThreshold: 0.3 });
    expect(result.method).toBe("lexical");
  });

  test("entityLexicalAliasCandidates is synchronous and pure-read", () => {
    seed("org", "Google LLC");
    seed("org", "Google Inc");
    const before = buildEntityIndex(vault).entities.map((e) => readFileSync(e.path, "utf8"));
    const candidates = entityLexicalAliasCandidates(vault, { threshold: 0.3 });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const after = buildEntityIndex(vault).entities.map((e) => readFileSync(e.path, "utf8"));
    expect(after).toEqual(before);
  });
});

describe("identity_type + evolution-chain helpers", () => {
  test("identity_type is absent by default", () => {
    seed("org", "Google LLC");
    const entity = buildEntityIndex(vault).entities[0]!;
    expect(deriveIdentityType(entity)).toBeUndefined();
  });

  test("identity_type derives from a frontmatter/structural signal", () => {
    seed("org", "Google LLC");
    const entity = buildEntityIndex(vault).entities[0]!;
    // Append the structural identity_type frontmatter key by hand.
    const raw = readFileSync(entity.path, "utf8");
    const withType = raw.replace(/^name: .*$/m, (m) => `${m}\nidentity_type: org`);
    atomicWriteFileSync(entity.path, withType);
    const reloaded = buildEntityIndex(vault).entities[0]!;
    expect(deriveIdentityType(reloaded)).toBe("org");
  });

  test("evolution chain is the canonical name followed by its aliases", () => {
    seed("org", "Google LLC", ["Google Inc", "Google"]);
    const entity = buildEntityIndex(vault).entities[0]!;
    expect(entityEvolutionChain(entity)).toEqual(["Google LLC", "Google Inc", "Google"]);
  });
});
