/**
 * The seeded take and the hash-order dev/counted split behind the
 * preregistered decision-model evaluation (cycle 20261020, card t_4e1681b3).
 *
 * A take is a committed fixture of labeled items whose ids the spec
 * freezes into a membership receipt at preregistration time. The split
 * rule is fixed and pure: rank the ids by `sha256Hex(seed + ":" + id)`
 * (ties by id), the first `ceil(devFraction * n)` are dev, the rest
 * counted. Dev is the only split threshold selection may look at; the
 * counted split alone produces the promotion number.
 *
 * `verifyEvalTake` is the runner-side guard: the fixture the spec names
 * must still hold exactly the receipted ids in exactly the receipted
 * split and hash to exactly the receipted content hash, or the run is a
 * named preregistration error rather than a quietly re-scoped claim.
 *
 * The committed fixtures live under `tests/fixtures/decision-model/` in
 * the bench-fixture spirit: repo-local JSON, gold labels from a closed
 * vocabulary (`relevant` / `useful` booleans), validated fail-fast.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../../integrity/digest.ts";
import type { DecisionModelUse } from "../contract.ts";
import { DECISION_EVAL_DEV_FRACTION, type DecisionEvalSpec } from "../eval-spec.ts";

/** Repo root, for resolving the spec's repo-relative fixture references. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

// ----- fixture documents ------------------------------------------------------

export interface EvalRerankItem {
  readonly id: string;
  /** Exactly one candidate is relevant: the top-1 verdict is crisp. */
  readonly kind: "rerank";
  readonly query: string;
  readonly candidates: ReadonlyArray<{
    readonly title: string;
    readonly text: string;
    readonly relevant: boolean;
  }>;
}

export interface EvalRecallItem {
  readonly id: string;
  readonly kind: "recall_inject";
  readonly prompt: string;
  /** At least one note is useful: regret (a useful note dropped) is measurable. */
  readonly notes: ReadonlyArray<{
    readonly title: string;
    readonly text: string;
    readonly useful: boolean;
  }>;
}

export type DecisionEvalItem = EvalRerankItem | EvalRecallItem;

export interface DecisionEvalFixture {
  readonly use: DecisionModelUse;
  readonly description?: string;
  readonly items: ReadonlyArray<DecisionEvalItem>;
}

export interface LoadedEvalFixture {
  readonly fixture: DecisionEvalFixture;
  /** sha256 of the canonical fixture document - the spec's fixture_hash. */
  readonly contentHash: string;
}

interface ParsedRerankCandidate {
  title: string;
  text: string;
  relevant: boolean;
}

interface ParsedRecallNote {
  title: string;
  text: string;
  useful: boolean;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("eval fixture: expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`eval fixture: ${what} must be a non-empty string`);
  }
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Error(`eval fixture: ${what} must be a boolean`);
  return value;
}

function parseRerankItem(raw: unknown): EvalRerankItem {
  const record = asObject(raw);
  const id = nonEmpty(record["id"], "item id");
  const query = nonEmpty(record["query"], `item ${id} query`);
  const candidatesRaw = record["candidates"];
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
    throw new Error(`eval fixture: item ${id} needs a non-empty candidates array`);
  }
  const candidates: ParsedRerankCandidate[] = candidatesRaw.map((c) => {
    const cand = asObject(c);
    return {
      title: nonEmpty(cand["title"], `candidate title in ${id}`),
      text: nonEmpty(cand["text"], `candidate text in ${id}`),
      relevant: bool(cand["relevant"], `candidate relevant in ${id}`),
    };
  });
  if (!candidates.some((c) => c.relevant === true)) {
    throw new Error(
      `eval fixture: item ${id} has no relevant candidate; the top-1 verdict needs one`,
    );
  }
  return { id, kind: "rerank", query, candidates: Object.freeze(candidates) };
}

function parseRecallItem(raw: unknown): EvalRecallItem {
  const record = asObject(raw);
  const id = nonEmpty(record["id"], "item id");
  const prompt = nonEmpty(record["prompt"], `item ${id} prompt`);
  const notesRaw = record["notes"];
  if (!Array.isArray(notesRaw) || notesRaw.length === 0) {
    throw new Error(`eval fixture: item ${id} needs a non-empty notes array`);
  }
  const notes: ParsedRecallNote[] = notesRaw.map((n) => {
    const note = asObject(n);
    return {
      title: nonEmpty(note["title"], `note title in ${id}`),
      text: nonEmpty(note["text"], `note text in ${id}`),
      useful: bool(note["useful"], `note useful in ${id}`),
    };
  });
  if (!notes.some((n) => n.useful === true)) {
    throw new Error(`eval fixture: item ${id} has no useful note; the regret verdict needs one`);
  }
  return { id, kind: "recall_inject", prompt, notes: Object.freeze(notes) };
}

/** Parse and validate a fixture document. Throws named errors. */
export function parseDecisionEvalFixture(
  raw: unknown,
  expectedUse: DecisionModelUse,
): DecisionEvalFixture {
  const record = asObject(raw);
  const use = nonEmpty(record["use"], "use");
  if (use !== expectedUse) {
    throw new Error(`eval fixture: use '${use}' does not match the spec's use '${expectedUse}'`);
  }
  const itemsRaw = record["items"];
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new Error("eval fixture: items must be a non-empty array");
  }
  const seen = new Set<string>();
  const items = itemsRaw.map((item) => {
    const parsed =
      expectedUse === "rerank"
        ? parseRerankItem(item)
        : expectedUse === "recall_inject"
          ? parseRecallItem(item)
          : null;
    if (parsed === null) {
      throw new Error(`eval fixture: no committed fixture grammar for use '${expectedUse}'`);
    }
    if (seen.has(parsed.id)) {
      throw new Error(`eval fixture: item id '${parsed.id}' appears more than once`);
    }
    seen.add(parsed.id);
    return parsed;
  });
  const description = record["description"];
  return Object.freeze({
    use: expectedUse,
    ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
    items: Object.freeze(items),
  });
}

/**
 * Resolve the spec's fixture reference: absolute paths as is, everything
 * else against the package root - the only relative spelling the
 * registry uses, and the one the installed package ships. There is no
 * working-directory fallback: a look-alike file at ./tests/fixtures/...
 * must never be hashed into a preregistration claim, and a fixture the
 * package does not carry is a named read error.
 */
export function resolveEvalFixturePath(ref: string): string {
  if (isAbsolute(ref)) return ref;
  return join(PACKAGE_ROOT, ref);
}

/** Load the spec's fixture file and hash its canonical document. */
export function loadDecisionEvalFixture(ref: string, use: DecisionModelUse): LoadedEvalFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolveEvalFixturePath(ref), "utf8"));
  } catch (err) {
    throw new Error(`eval fixture: cannot read '${ref}': ${(err as Error).message}`);
  }
  return {
    fixture: parseDecisionEvalFixture(raw, use),
    contentHash: sha256Hex(canonicalJson(raw)),
  };
}

// ----- the hash-order split -----------------------------------------------------

export interface EvalTakeSplit {
  /** Dev ids, sorted lexicographically. Threshold selection may see these only. */
  readonly dev: ReadonlyArray<string>;
  /** Counted ids, sorted lexicographically. These alone produce the metric. */
  readonly counted: ReadonlyArray<string>;
}

/**
 * The preregistered split: rank ids by `sha256Hex(seed + ":" + id)` (ties
 * by id), the first `ceil(0.3 n)` are dev, the rest counted. Pure and
 * reorder-stable; both lists come back sorted lexicographically so a
 * receipt compares equal regardless of derivation order.
 */
export function hashOrderSplit(seed: string, ids: ReadonlyArray<string>): EvalTakeSplit {
  const ranked = ids
    .map((id) => ({ id, h: sha256Hex(`${seed}:${id}`) }))
    .toSorted((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.id.localeCompare(b.id)));
  const devCount = Math.ceil(ids.length * DECISION_EVAL_DEV_FRACTION);
  return {
    dev: ranked
      .slice(0, devCount)
      .map((e) => e.id)
      .toSorted(),
    counted: ranked
      .slice(devCount)
      .map((e) => e.id)
      .toSorted(),
  };
}

/**
 * The runner-side preregistration guard: the loaded fixture must hold
 * exactly the receipted ids in exactly the receipted split, and its
 * content must still hash to the spec's frozen fixture hash. Any
 * mismatch is a named error - the spec was edited after grades were
 * seen, or the fixture moved under it, and neither may quietly re-scope
 * the claim.
 */
export function verifyEvalTake(
  spec: Pick<DecisionEvalSpec, "seed" | "receipt" | "fixture_hash">,
  fixture: DecisionEvalFixture,
  contentHash: string,
): void {
  if (contentHash !== spec.fixture_hash) {
    throw new Error(
      `eval preregistration mismatch: fixture content hash ${contentHash.slice(0, 12)}… ` +
        `does not match the spec's frozen ${spec.fixture_hash.slice(0, 12)}…; ` +
        "the fixture changed after the spec was committed",
    );
  }
  const ids = fixture.items.map((item) => item.id);
  const derived = hashOrderSplit(spec.seed, ids);
  const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  if (!same(derived.dev, spec.receipt.dev) || !same(derived.counted, spec.receipt.counted)) {
    throw new Error(
      "eval preregistration mismatch: the fixture's take membership does not match the " +
        "spec's frozen receipt; the take changed after the spec was committed",
    );
  }
}
