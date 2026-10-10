/**
 * Write-approval lane toggle resolver (write-side trust, Task 6).
 *
 * One leaf module owns every `write_approval.*` key so the gates that
 * consume them cannot drift apart. There are three review lanes -
 * `signals` (the writeSignal chokepoint), `notes` (note creates) and
 * `ingest` (the ingest summary page) - and one master key. Resolution
 * order per lane: the lane's own key, then the master
 * `write_approval.enabled`, then off. The env twin wins over the config
 * value per key, exactly as every other flat-key resolver in this
 * project. The signals lane declares no key of its own: the master key
 * IS the signals key, which is what keeps the pre-existing toggle's
 * meaning ("stage everything") unchanged.
 *
 * A lane key present with any non-empty value decides for that lane -
 * `true` turns the lane on, anything else holds it off even when the
 * master is on - so an operator can gate bulk ingest without gating
 * interactive feedback. Absent falls through to the master; an empty
 * env value counts as unset.
 *
 * This module imports only the config reader. `signal.ts` consumes it
 * BELOW the pending module (pending imports signal, so signal cannot
 * import pending), and the disposition layer in `pending-lanes.ts`
 * builds on the same resolver.
 */

import { discoverConfig } from "../config.ts";

/** Config key / env twin for the master write-approval toggle (default off). */
export const WRITE_APPROVAL_ENABLED_CONFIG_KEY = "write_approval.enabled";
export const WRITE_APPROVAL_ENABLED_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED";

/** Config key / env twin for the notes lane. Absent falls back to the master. */
export const WRITE_APPROVAL_NOTES_CONFIG_KEY = "write_approval.notes";
export const WRITE_APPROVAL_NOTES_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED";

/** Config key / env twin for the ingest lane. Absent falls back to the master. */
export const WRITE_APPROVAL_INGEST_CONFIG_KEY = "write_approval.ingest";
export const WRITE_APPROVAL_INGEST_ENV_KEY = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED";

/**
 * The lanes a write can be reviewed through. A closed vocabulary: the
 * lane name is both the config-key selector and the `Brain/pending/`
 * subdirectory a staged document lands in.
 */
export const REVIEW_LANE = Object.freeze({
  signals: "signals",
  notes: "notes",
  ingest: "ingest",
} as const);

/** Review-lane union. */
export type ReviewLane = (typeof REVIEW_LANE)[keyof typeof REVIEW_LANE];

/** Every review lane, in registry order. */
export const REVIEW_LANES: ReadonlyArray<ReviewLane> = Object.freeze([
  REVIEW_LANE.signals,
  REVIEW_LANE.notes,
  REVIEW_LANE.ingest,
]);

/** Narrow an unvalidated config or argument value to a {@link ReviewLane}. */
export function isReviewLane(value: unknown): value is ReviewLane {
  return typeof value === "string" && (REVIEW_LANES as ReadonlyArray<string>).includes(value);
}

/** The config key and env twin that decide one lane. */
const LANE_KEYS: Readonly<Record<ReviewLane, { readonly config: string; readonly env: string }>> =
  Object.freeze({
    [REVIEW_LANE.signals]: {
      config: WRITE_APPROVAL_ENABLED_CONFIG_KEY,
      env: WRITE_APPROVAL_ENABLED_ENV_KEY,
    },
    [REVIEW_LANE.notes]: {
      config: WRITE_APPROVAL_NOTES_CONFIG_KEY,
      env: WRITE_APPROVAL_NOTES_ENV_KEY,
    },
    [REVIEW_LANE.ingest]: {
      config: WRITE_APPROVAL_INGEST_CONFIG_KEY,
      env: WRITE_APPROVAL_INGEST_ENV_KEY,
    },
  });

/**
 * Read one toggle's raw value with the shared precedence: a non-empty env
 * value wins; otherwise the config value when it is a non-empty string.
 * `undefined` means the key is unset and the next link in the resolution
 * chain decides.
 */
function rawToggleValue(
  keys: { readonly config: string; readonly env: string },
  data: Readonly<Record<string, unknown>>,
): string | undefined {
  const env = process.env[keys.env];
  if (env !== undefined && env !== "") return env;
  const raw = data[keys.config];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The repo's one spelling of "on" for a flat toggle key. */
function isTrue(raw: string): boolean {
  return raw.trim().toLowerCase() === "true";
}

/**
 * Resolve the write-approval toggle for one review lane.
 *
 * Lane key, then master `write_approval.enabled`, then off - with the
 * env twin winning per key. Default OFF everywhere: absent keys and an
 * absent config file keep every direct-to-lane write path byte-identical.
 */
export function resolveWriteApprovalLane(lane: ReviewLane, configPath?: string): boolean {
  const data = discoverConfig(configPath).data;
  if (lane !== REVIEW_LANE.signals) {
    const laneRaw = rawToggleValue(LANE_KEYS[lane], data);
    if (laneRaw !== undefined) return isTrue(laneRaw);
  }
  const masterRaw = rawToggleValue(LANE_KEYS[REVIEW_LANE.signals], data);
  return masterRaw !== undefined && isTrue(masterRaw);
}
