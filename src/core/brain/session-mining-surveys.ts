/**
 * Pending mining surveys: what a plan put in front of a model, remembered
 * until the commit that answers it.
 *
 * The documented mining flow is plan, answer, commit - and the commit is
 * not required to relay the plan's `surveyed_turns_hash`. A commit that
 * relays nothing used to hash the session's turns as they stood at COMMIT
 * time, so an import landing between the plan and the commit made a
 * zero-yield commit tombstone turns no model had seen. This store closes
 * that gap without asking the caller for anything: every plan that hands
 * out a mining envelope records the hash of the material it offered, and
 * the commit consumes the record. A zero-yield commit without a relay
 * writes its tombstone only when exactly one distinct material was
 * surveyed since the last commit and the session still holds it.
 *
 * Kept apart from the mining ledger on purpose. The ledger fails closed
 * because a silent reset would unsuppress every barren session; a lost
 * survey can only withhold one tombstone (the session stays minable), so
 * the two have different failure economics and different owners - plans
 * write here, commits write there.
 *
 * A corrupt or unknown-schema file still refuses by name rather than
 * reading as empty: an empty read could make a session with two pending
 * surveys look like it had one, which is exactly the ambiguity the store
 * exists to detect.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { DERIVED_STORE_DIR } from "./path-constants.ts";
import { acquireLockSyncWithRetry, ingestLockRemedy } from "./sync-lockfile.ts";
import { isoSecond } from "./time.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

/** Only survey-store schema this build understands. */
export const SESSION_MINING_SURVEYS_SCHEMA_VERSION = 1 as const;

const SESSION_MINING_SURVEYS_FILE = "session-mining-surveys.json";

/**
 * Distinct hashes kept per session. Past two the answer is already
 * "ambiguous", so the cap only bounds the file; keeping the newest few
 * keeps the record honest about there being several.
 */
export const MAX_SURVEYED_HASHES_PER_SESSION = 8;

/** Sessions kept; the oldest surveys beyond this are dropped at write time. */
export const MAX_SURVEYED_SESSIONS = 512;

/** The remedy every file-level refusal names. */
const CORRUPT_SURVEYS_REMEDY =
  "; to recover, move the file aside or delete it - only pending plan surveys are lost, so " +
  "the next barren commit of an affected session records no tombstone until it is planned again";

/** Absolute path of the pending-survey store for a vault. */
export function sessionMiningSurveysPath(vault: string): string {
  return join(vault, DERIVED_STORE_DIR, SESSION_MINING_SURVEYS_FILE);
}

interface SurveyRow {
  readonly hashes: ReadonlyArray<string>;
  readonly surveyedAt: string;
}

function readSurveys(vault: string): Record<string, SurveyRow> {
  const path = sessionMiningSurveysPath(vault);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `session mining surveys file is corrupted JSON: ${path}${CORRUPT_SURVEYS_REMEDY}`,
      {
        cause: e,
      },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `session mining surveys file is not an object: ${path}${CORRUPT_SURVEYS_REMEDY}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["schema_version"] !== SESSION_MINING_SURVEYS_SCHEMA_VERSION) {
    throw new Error(
      `session mining surveys schema_version ${String(obj["schema_version"])} not supported ` +
        `(expected ${SESSION_MINING_SURVEYS_SCHEMA_VERSION}): ${path}${CORRUPT_SURVEYS_REMEDY}`,
    );
  }
  const raw = obj["surveys"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `session mining surveys container is not an object: ${path}${CORRUPT_SURVEYS_REMEDY}`,
    );
  }
  const out: Record<string, SurveyRow> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const hashes = row["hashes"];
    if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && h.length > 0)) {
      // A damaged row is kept as "several surveys" rather than dropped: a
      // dropped row would read as "no survey", and the commit would then
      // name the absence - but a row reduced to one hash could wrongly
      // attest a single survey. Two placeholder hashes force ambiguity.
      out[key] = { hashes: ["<unreadable>", "<unreadable-2>"], surveyedAt: "" };
      continue;
    }
    const surveyedAt = row["surveyedAt"];
    out[key] = {
      hashes: hashes as string[],
      surveyedAt: typeof surveyedAt === "string" ? surveyedAt : "",
    };
  }
  return out;
}

function writeSurveys(vault: string, surveys: Record<string, SurveyRow>): void {
  const path = sessionMiningSurveysPath(vault);
  const sorted: Record<string, SurveyRow> = {};
  for (const key of Object.keys(surveys).toSorted()) sorted[key] = surveys[key]!;
  const next =
    JSON.stringify(
      { schema_version: SESSION_MINING_SURVEYS_SCHEMA_VERSION, surveys: sorted },
      null,
      2,
    ) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === next) return;
  atomicWriteFileSync(path, next);
}

/**
 * Record that a plan offered `hash` for `sessionId`. A hash already pending
 * for the session is not added twice, so re-planning unchanged material
 * keeps the survey unambiguous.
 */
export function recordMiningSurvey(
  vault: string,
  sessionId: string,
  hash: string,
  now: Date = new Date(),
): void {
  assertVaultIdentityForWrite(vault);
  const path = sessionMiningSurveysPath(vault);
  const key = sessionId.trim();
  const handle = acquireLockSyncWithRetry(path, undefined, { remedy: ingestLockRemedy });
  try {
    const surveys = readSurveys(vault);
    const prior = surveys[key]?.hashes ?? [];
    const hashes = [...prior.filter((h) => h !== hash), hash].slice(
      -MAX_SURVEYED_HASHES_PER_SESSION,
    );
    surveys[key] = { hashes, surveyedAt: isoSecond(now) };
    const keys = Object.keys(surveys);
    if (keys.length > MAX_SURVEYED_SESSIONS) {
      const oldestFirst = keys.toSorted((a, b) =>
        surveys[a]!.surveyedAt === surveys[b]!.surveyedAt
          ? a.localeCompare(b)
          : surveys[a]!.surveyedAt < surveys[b]!.surveyedAt
            ? -1
            : 1,
      );
      for (const drop of oldestFirst.slice(0, keys.length - MAX_SURVEYED_SESSIONS)) {
        if (drop !== key) delete surveys[drop];
      }
    }
    writeSurveys(vault, surveys);
  } finally {
    handle.release();
  }
}

/**
 * Read and remove the pending surveys of one session: the distinct hashes
 * plans offered since its last commit, oldest first, or `[]` when none was
 * recorded. Throws on a corrupt or unknown-schema store.
 */
export function consumeMiningSurvey(vault: string, sessionId: string): ReadonlyArray<string> {
  const path = sessionMiningSurveysPath(vault);
  if (!existsSync(path)) return [];
  assertVaultIdentityForWrite(vault);
  const key = sessionId.trim();
  const handle = acquireLockSyncWithRetry(path, undefined, { remedy: ingestLockRemedy });
  try {
    const surveys = readSurveys(vault);
    const row = surveys[key];
    if (row === undefined) return [];
    delete surveys[key];
    writeSurveys(vault, surveys);
    return row.hashes;
  } finally {
    handle.release();
  }
}
