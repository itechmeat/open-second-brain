/**
 * Verification delta (v0.10.16).
 *
 * Independent verification layer that compares a dream-pass summary
 * against the current vault state and classifies each cited
 * preference id into one of four states:
 *
 *   - `confirmed`        - preference exists on disk and the dream
 *                          claim matches state (applied_count > 0
 *                          where applicable).
 *   - `drift`            - preference exists, status matches the
 *                          dream claim, but applied_count is zero
 *                          ("claimed applied but no artifact ever
 *                          recorded").
 *   - `regression`       - the preference cited as confirmed is now
 *                          present in `Brain/retired/` (moved out
 *                          after the dream claim).
 *   - `missing_evidence` - the dream cites a `pref-*` id with no
 *                          corresponding file on disk.
 *
 * The function is pure read-only: it never mutates the vault. It
 * defers all file parsing to the existing `parsePreference` /
 * `parseRetired` helpers, so any parse error surfaces as a single
 * `missing_evidence` entry (the artifact is unreachable from this
 * read path).
 */

import { existsSync } from "node:fs";

import type { DreamRunSummary } from "../dream.ts";
import { preferencePath, retiredPath } from "../paths.ts";
import { parsePreference } from "../preference.ts";

export type VerificationDeltaState =
  | "confirmed"
  | "drift"
  | "regression"
  | "missing_evidence";

export interface VerificationDeltaEntry {
  /** `pref-*` id from the dream summary. */
  readonly id: string;
  readonly state: VerificationDeltaState;
  /** Vault-relative path of the artifact that triggered the verdict (when present). */
  readonly path?: string;
  /** Optional one-line context for the operator. */
  readonly note?: string;
}

export interface VerificationDeltaSummaryCounts {
  readonly confirmed: number;
  readonly drift: number;
  readonly regression: number;
  readonly missing_evidence: number;
}

export interface VerificationDeltaResult {
  readonly entries: ReadonlyArray<VerificationDeltaEntry>;
  readonly summary: VerificationDeltaSummaryCounts;
}

export function computeVerificationDelta(
  vault: string,
  dream: DreamRunSummary,
): VerificationDeltaResult {
  const entries: VerificationDeltaEntry[] = [];

  for (const id of dream.confirmed) {
    entries.push(classifyConfirmedClaim(vault, id));
  }

  // `new_unconfirmed` entries are treated like a freshly-claimed
  // preference: existence is enough; the applied_count is not yet
  // expected to be non-zero.
  for (const id of dream.new_unconfirmed) {
    entries.push(classifyUnconfirmedClaim(vault, id));
  }

  // Retired entries: dream said "I just retired this". Verify the
  // retired file exists.
  for (const rec of dream.retired) {
    entries.push(classifyRetiredClaim(vault, rec.id));
  }

  const summary: VerificationDeltaSummaryCounts = {
    confirmed: countBy(entries, "confirmed"),
    drift: countBy(entries, "drift"),
    regression: countBy(entries, "regression"),
    missing_evidence: countBy(entries, "missing_evidence"),
  };

  return Object.freeze({
    entries: Object.freeze(entries),
    summary: Object.freeze(summary),
  });
}

function classifyConfirmedClaim(vault: string, id: string): VerificationDeltaEntry {
  const slug = stripPrefPrefix(id);
  if (slug === null) {
    return Object.freeze({ id, state: "missing_evidence", note: "unrecognised id prefix" });
  }
  const prefPath = preferencePath(vault, slug);
  if (existsSync(prefPath)) {
    try {
      const pref = parsePreference(prefPath);
      if (pref.applied_count > 0) {
        return Object.freeze({ id, state: "confirmed", path: prefPath });
      }
      return Object.freeze({
        id,
        state: "drift",
        path: prefPath,
        note: "claimed confirmed but applied_count is zero",
      });
    } catch (err) {
      return Object.freeze({
        id,
        state: "missing_evidence",
        path: prefPath,
        note: `parse error: ${(err as Error).message}`,
      });
    }
  }
  // Not under preferences/: check whether it moved to retired/.
  const retPath = retiredPath(vault, slug);
  if (existsSync(retPath)) {
    return Object.freeze({
      id,
      state: "regression",
      path: retPath,
      note: "dream claimed confirmed but preference is now retired",
    });
  }
  return Object.freeze({ id, state: "missing_evidence" });
}

function classifyUnconfirmedClaim(vault: string, id: string): VerificationDeltaEntry {
  const slug = stripPrefPrefix(id);
  if (slug === null) {
    return Object.freeze({ id, state: "missing_evidence", note: "unrecognised id prefix" });
  }
  const prefPath = preferencePath(vault, slug);
  if (existsSync(prefPath)) {
    return Object.freeze({ id, state: "confirmed", path: prefPath });
  }
  const retPath = retiredPath(vault, slug);
  if (existsSync(retPath)) {
    return Object.freeze({
      id,
      state: "regression",
      path: retPath,
      note: "dream claimed unconfirmed but preference is already retired",
    });
  }
  return Object.freeze({ id, state: "missing_evidence" });
}

function classifyRetiredClaim(vault: string, id: string): VerificationDeltaEntry {
  const slug = stripRetPrefix(id);
  if (slug === null) {
    return Object.freeze({ id, state: "missing_evidence", note: "unrecognised id prefix" });
  }
  const retPath = retiredPath(vault, slug);
  if (existsSync(retPath)) {
    return Object.freeze({ id, state: "confirmed", path: retPath });
  }
  return Object.freeze({
    id,
    state: "missing_evidence",
    note: "dream claimed retired but no file under retired/",
  });
}

function stripPrefPrefix(id: string): string | null {
  if (id.startsWith("pref-")) return id.slice("pref-".length);
  return null;
}

function stripRetPrefix(id: string): string | null {
  if (id.startsWith("ret-")) return id.slice("ret-".length);
  return null;
}

function countBy(
  entries: ReadonlyArray<VerificationDeltaEntry>,
  state: VerificationDeltaState,
): number {
  let n = 0;
  for (const e of entries) {
    if (e.state === state) n += 1;
  }
  return n;
}
