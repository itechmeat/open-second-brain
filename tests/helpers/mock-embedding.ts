/**
 * Deterministic in-process embedding provider for indexer tests.
 *
 * Vectors are derived from sha256 of the input text: every 4 bytes of
 * the digest become one signed float in [-1, 1], padded/truncated to
 * the requested dimension, then unit-normalised. Two equal inputs
 * always produce the same vector — so assertions on chunk identity
 * stay stable across runs.
 */

import { createHash } from "node:crypto";

import type { EmbeddingProvider } from "../../src/core/search/embeddings/contract.ts";

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model: string;
  readonly dimension: number;
  callCount = 0;

  constructor(opts?: { model?: string; dimension?: number }) {
    this.model = opts?.model ?? "mock-embed";
    this.dimension = opts?.dimension ?? 8;
  }

  embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    this.callCount++;
    return Promise.resolve(texts.map((t) => this.vectorFor(t)));
  }

  async ping(): Promise<{ ok: true; dimension: number }> {
    return { ok: true, dimension: this.dimension };
  }

  private vectorFor(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    let acc = createHash("sha256").update(text).digest();
    let bytes: number[] = Array.from(acc);
    while (bytes.length < this.dimension * 2) {
      acc = createHash("sha256").update(acc).digest();
      bytes = bytes.concat(Array.from(acc));
    }
    for (let i = 0; i < this.dimension; i++) {
      const b1 = bytes[i * 2] ?? 0;
      const b2 = bytes[i * 2 + 1] ?? 0;
      v[i] = (b1 - 128) / 128 + ((b2 - 128) / 128) * 0.5;
    }
    let s = 0;
    for (const x of v) s += x * x;
    const norm = Math.sqrt(s);
    if (norm === 0) return v;
    return v.map((x) => x / norm);
  }
}
