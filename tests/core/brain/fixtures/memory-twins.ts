/**
 * The one memory fixture of the store-only readers (task 2.10). Twin
 * fixtures for the memory readers: one unswitched
 * machine and one switched machine, each built by the same real writers
 * from the same input. The unswitched machine keeps the legacy `Brain/`
 * pages (and dual-writes); the switched machine writes store records
 * only, so its `Brain/` holds no signal, preference or retired page.
 *
 * Both run with the dual-write flag on: on the switched machine that
 * changes nothing for the memory writers (they are store-only), and it
 * lets the operational log, still written by its legacy writer until the
 * log package lands, reach the store as well, so log readers have the
 * same events on both sides.
 *
 * {@link withMemoryFixture} builds one machine at a time from the same
 * writers, with the dual write off, for tests that need a switched machine
 * with no records, or an unswitched one that switches afterwards.
 */
import { existsSync, readFileSync } from "node:fs";

import {
  formatFrontmatter,
  parseFrontmatter,
  parseFrontmatterText,
  writeFrontmatterAtomic,
} from "../../../../src/core/vault.ts";
import { computeContentHash } from "../../../../src/core/brain/content-hash.ts";
import {
  existingPreferencePageText,
  writePreferencePageText,
} from "../../../../src/core/brain/preference-page-write.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { regenerateActive } from "../../../../src/core/brain/active.ts";
import { regenerateLessons } from "../../../../src/core/brain/lessons.ts";
import { applyDreamPlan } from "../../../../src/core/brain/dream-apply.ts";
import { emptyPlan } from "../../../../src/core/brain/dream-plan.ts";
import { appendApplyEvidence } from "../../../../src/core/brain/apply-evidence.ts";
import { writePinnedContext } from "../../../../src/core/brain/pinned.ts";
import { loadBrainConfig } from "../../../../src/core/brain/policy.ts";
import { moveToRetired, writePreference } from "../../../../src/core/brain/preference.ts";
import { preferencePath } from "../../../../src/core/brain/paths.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { deviceMintTag } from "../../../../src/core/brain/record-name.ts";
import { isStoreOnly } from "../../../../src/core/store/store-only.ts";
import { retireSignal } from "../../../../src/core/brain/signal-retire.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice as switchDeviceAt } from "../store-only/fixtures.ts";

/** Which machine a single-machine fixture ({@link withMemoryFixture}) builds. */
export type MemoryMode = "legacy" | "switched";

/** The prose of the imported preference's body. */
export const IMPORTED_PROSE =
  "Keep the pelican module tidy. Why: reviews of the pelican code went faster.";

/** Ids the memory twins (`makeMemoryTwins`, through `writeOperatorRecords`) write. */
export const FIXTURE_IDS = Object.freeze({
  tabs: "sig-2026-11-06-tabs",
  spaces: "sig-2026-11-06-spaces",
  consumed: "sig-2026-11-06-consumed",
  archived: "sig-2026-11-06-archived",
  prefTabs: "pref-tabs",
  prefNaming: "pref-naming",
  prefNotes: "pref-notes",
  prefImported: "pref-imported",
  retired: "ret-gone",
});

/**
 * Active preferences the fixture holds: tabs, tabs-too, spaces and drafty,
 * plus naming, notes, imported and drifted.
 */
export const FIXTURE_ACTIVE_PREFERENCES = 8;

/** The instant every writer of the fixture is told it is. */
export const FIXTURE_NOW = new Date("2026-11-06T12:00:00Z");

/** Ids the single-machine memory fixture (`withMemoryFixture`) writes. */
export const FIXTURE = Object.freeze({
  confirmed: "pref-tabs",
  quarantine: "pref-spaces",
  unconfirmed: "pref-drafty",
  retired: "pref-oldrule",
  activeSignals: ["sig-2026-11-05-tabs", "sig-2026-11-05-lint"],
  consumedSignal: "sig-2026-11-04-consume",
  retiredSignal: "sig-2026-11-04-gone",
  pinned: "Ship the store-only readers first.",
});

/** Record this device's switch, so the machine is store-only from here on. */
export function switchDevice(env: StoreEnv): void {
  switchDeviceAt(env.storeRoot);
}

const signal = (date: string, slug: string, principle: string) => ({
  topic: slug,
  signal: "positive" as const,
  agent: "claude",
  principle,
  created_at: `${date}T10:00:00Z`,
  date,
  slug,
  tags: ["coding"],
});

const pref = (
  slug: string,
  status: "confirmed" | "quarantine" | "unconfirmed",
  extra: Record<string, unknown> = {},
) => ({
  slug,
  topic: slug,
  principle: `Principle of ${slug}`,
  created_at: "2026-10-01T00:00:00Z",
  unconfirmed_until: "2026-10-31T00:00:00Z",
  status,
  // Evidence names a page every machine holds: on a switched machine a
  // reference the folds cannot resolve makes the record private.
  evidenced_by: [`[[notes/origin-${slug}]]`],
  ...(status === "confirmed" ? { confirmed_at: "2026-10-02T00:00:00Z" } : {}),
  ...extra,
});

/** Run the fixture's writers against `env`. */
export function writeMemoryFixture(env: StoreEnv): void {
  const vault = env.vault;
  writePreference(vault, pref("tabs", "confirmed", { scope: "coding" }), { authority: "agent" });
  // A near duplicate of `tabs` (same topic and scope), for the merge detector.
  writePreference(
    vault,
    pref("tabs-too", "confirmed", {
      topic: "tabs",
      scope: "coding",
      principle: "Principle of tabs too",
    }),
    { authority: "agent" },
  );
  writePreference(vault, pref("spaces", "quarantine"), { authority: "agent" });
  writePreference(vault, pref("drafty", "unconfirmed"), { authority: "agent" });
  writePreference(vault, pref("oldrule", "confirmed"), { authority: "agent" });
  moveToRetired(vault, preferencePath(vault, "oldrule"), "stale-no-evidence", {
    now: FIXTURE_NOW,
    retired_by: "[[Brain/log/2026-11-06]]",
    authority: "agent",
  });
  for (const at of ["2026-11-05T09:00:00Z", "2026-11-05T11:00:00Z"]) {
    appendApplyEvidence(
      vault,
      { pref_id: FIXTURE.confirmed, artifact: "[[notes/a]]", agent: "claude", result: "applied" },
      { now: new Date(at) },
    );
  }
  appendApplyEvidence(
    vault,
    { pref_id: FIXTURE.quarantine, artifact: "[[notes/b]]", agent: "claude", result: "violated" },
    { now: new Date("2026-11-05T12:00:00Z") },
  );
  writeSignal(vault, signal("2026-11-05", "tabs", "Use tabs for indentation"));
  writeSignal(vault, signal("2026-11-05", "lint", "Run the linter before a commit"));
  const consume = writeSignal(vault, signal("2026-11-04", "consume", "Prefer small PRs"));
  const gone = writeSignal(vault, signal("2026-11-04", "gone", "Old advice"));
  retireSignal(vault, gone.id, { reason: "superseded", agent: "claude", now: FIXTURE_NOW });
  const plan = emptyPlan();
  plan.signalsToMove.set(consume.id, {
    id: consume.id,
    date: "2026-11-04",
    slug: "consume",
    path: consume.path,
  });
  applyDreamPlan({
    vault,
    cfg: loadBrainConfig(vault),
    now: FIXTURE_NOW,
    plan,
    refresh: { confirmed: new Set(), updated: new Map(), bandDrops: [], outcomeRegressions: [] },
    agentName: "claude",
    wikilinkToRun: "[[Brain/log/2026-11-06]]",
    healEnrichEnabled: false,
    workrun: null,
  });
  writeOperatorRecords(vault);
  writePinnedContext(vault, FIXTURE.pinned);
  stampLegacyCounters(vault);
  // What the dream pass ends with: the compiled digests, written to the
  // vault on an unswitched machine and to the device-local cache once
  // switched.
  regenerateActive(vault, { now: FIXTURE_NOW });
  regenerateLessons(vault, { now: FIXTURE_NOW });
}

/**
 * The counters a dream pass writes onto an unswitched machine's pages
 * (the fold derives them from evidence as it arrives), stamped here so
 * both twins show the same counts without running a whole pass.
 */
function stampLegacyCounters(vault: string): void {
  for (const [slug, applied, violated] of [
    ["tabs", 2, 0],
    ["spaces", 0, 1],
  ] as const) {
    const path = preferencePath(vault, slug);
    if (!existsSync(path)) continue;
    const [meta, body] = parseFrontmatter(path);
    writeFrontmatterAtomic(
      path,
      { ...meta, _applied_count: applied, _violated_count: violated },
      body,
      { overwrite: true },
    );
  }
}

function operatorSignal(slug: string, kind: "positive" | "negative", scope?: string) {
  return {
    topic: slug,
    signal: kind,
    agent: "claude",
    principle: `Principle of ${slug}`,
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug,
    schema_type: "feedback",
    ...(scope !== undefined ? { scope } : {}),
  };
}

function operatorPreference(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-30T00:00:00Z",
    status: "unconfirmed" as "unconfirmed" | "confirmed",
    evidenced_by: [] as string[],
    schema_type: "preference",
    ...extra,
  };
}

/**
 * The records the operator readers' parity needs beyond the ones above: an
 * archived signal, a writer's guidance, an imported page with prose (a hub
 * linking five preferences, an unlinked mention), a drifted content hash
 * and a second retired preference.
 */
function writeOperatorRecords(vault: string): void {
  writeSignal(vault, operatorSignal("tabs", "positive", "coding"));
  const spaces = writeSignal(vault, operatorSignal("spaces", "negative", "writing"));
  const consumed = writeSignal(vault, operatorSignal("consumed", "positive"));
  const archived = writeSignal(vault, operatorSignal("archived", "negative"));
  const plan = emptyPlan();
  plan.signalsToMove.set(consumed.id, {
    id: consumed.id,
    date: "2026-11-06",
    slug: "consumed",
    path: consumed.path,
  });
  plan.signalsToArchive.set(archived.id, { id: archived.id, path: archived.path });
  applyDreamPlan({
    vault,
    cfg: loadBrainConfig(vault),
    now: FIXTURE_NOW,
    plan,
    refresh: { confirmed: new Set(), updated: new Map(), bandDrops: [], outcomeRegressions: [] },
    agentName: "claude",
    wikilinkToRun: "[[Brain/log/2026-11-06]]",
    healEnrichEnabled: false,
    workrun: null,
  });
  writePreference(vault, operatorPreference("naming", { scope: "writing" }), {
    authority: "agent",
  });
  // Prose the fields do not render: a writer's guidance, and an imported
  // page whose body carries its memory text and a link.
  writePreference(
    vault,
    {
      ...operatorPreference("notes"),
      howToApply: "Prefer short words when naming the flamingo helpers.",
    },
    { authority: "agent" },
  );
  writePreference(vault, operatorPreference("imported"), { authority: "agent" });
  const existing = existingPreferencePageText(vault, "imported", (path) =>
    readFileSync(path, "utf8"),
  );
  if (existing === null) throw new Error("fixture: imported preference missing");
  const [meta] = parseFrontmatterText(existing);
  writePreferencePageText(
    vault,
    "imported",
    formatFrontmatter(
      meta,
      `${IMPORTED_PROSE} See pref-naming for the words.\n\n` +
        "Related: [[pref-tabs]], [[pref-naming]], [[pref-notes]], [[pref-gone]], [[pref-missing]].\n\n" +
        `## Origin\n\nImported from [[${spaces.id}]].`,
    ),
  );
  // A confirmed preference whose stored content hash no longer matches
  // its principle: the remediation's re-stamp target.
  writePreference(
    vault,
    operatorPreference("drifted", {
      status: "confirmed",
      confirmed_at: "2026-11-02T00:00:00Z",
      content_hash: computeContentHash("an earlier principle", undefined),
    }),
    { authority: "agent" },
  );
  writePreference(vault, operatorPreference("gone"), { authority: "agent" });
  moveToRetired(vault, preferencePath(vault, "gone"), "stale-no-evidence", {
    now: FIXTURE_NOW,
    retired_by: "[[Brain/log/2026-11-06]]",
    authority: "agent",
  });
}

/** The twin machines, written by the same writers. */
export interface MemoryTwins {
  readonly legacy: StoreEnv;
  readonly switched: StoreEnv;
  cleanup(): void;
}

/**
 * Build the unswitched machine first and the switched one second: the
 * environment the store fixture sets is the last one built, so a reader
 * called after this resolves the switched machine's config unless it is
 * pointed at the other with {@link useEnv}.
 */
export function makeMemoryTwins(prefix: string): MemoryTwins {
  const legacy = makeStoreEnv(`${prefix}legacy-`, { dualWrite: true });
  let switched: StoreEnv | undefined;
  try {
    writeMemoryFixture(legacy);
  } catch (err) {
    legacy.cleanup();
    throw err;
  }
  const legacyEnvVars = captureEnv();
  try {
    switched = makeStoreEnv(`${prefix}switched-`, { dualWrite: true });
    switchDevice(switched);
    writeMemoryFixture(switched);
  } catch (err) {
    switched?.cleanup();
    legacy.cleanup();
    throw err;
  }
  const switchedEnvVars = captureEnv();
  envOf.set(legacy, legacyEnvVars);
  envOf.set(switched, switchedEnvVars);
  const built = switched;
  return {
    legacy,
    switched: built,
    cleanup: () => {
      built.cleanup();
      legacy.cleanup();
    },
  };
}

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
] as const;

const envOf = new WeakMap<StoreEnv, Map<string, string | undefined>>();

function captureEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

/** Point the process environment at one twin before calling a reader. */
export function useEnv(env: StoreEnv): void {
  const vars = envOf.get(env);
  if (vars === undefined) throw new Error("not a twin of makeMemoryTwins");
  for (const [key, value] of vars) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Run `read` against each twin, returning both answers. */
export function onBoth<T>(
  twins: MemoryTwins,
  read: (env: StoreEnv) => T,
): { legacy: T; switched: T } {
  useEnv(twins.legacy);
  const legacy = read(twins.legacy);
  useEnv(twins.switched);
  const switched = read(twins.switched);
  return { legacy, switched };
}

/**
 * `value` with every occurrence of the twin's vault path replaced by
 * `<vault>` and its store root by `<store>`, so answers of the two twins
 * compare equal when they name the same pages.
 */
function esc(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

export function normalized(value: unknown, env: StoreEnv): unknown {
  const text = JSON.stringify(value, (_key, v) =>
    v instanceof Set ? [...v].toSorted() : v instanceof Map ? [...v.entries()] : v,
  );
  if (text === undefined) return value;
  return JSON.parse(
    withoutMintTag(
      text.split(esc(env.vault)).join("<vault>").split(esc(env.storeRoot)).join("<store>"),
    ),
  );
}

/**
 * A signal id of {@link FIXTURE_IDS} as the machine at `vault` minted it:
 * with the device's mint tag once switched (`deviceMintTag`), as written
 * on an unswitched machine.
 */
export function mintedId(vault: string, id: string): string {
  const tag = deviceMintTag();
  return tag !== null && id.startsWith("sig-") && isStoreOnly({ vault }) ? `${id}-${tag}` : id;
}

/**
 * `text` without this device's mint tag: a switched machine adds it to
 * the ids it mints (`deviceMintTag`), an unswitched one does not, and the
 * twins compare the records, not the tag.
 */
function withoutMintTag(text: string): string {
  const tag = deviceMintTag();
  return tag === null ? text : text.split(`-${tag}`).join("");
}

/**
 * Build the fixture in `mode`, run `body` against it, tear it down and
 * return the body's answer with the vault path replaced by `<vault>`, so
 * answers from the two modes compare equal.
 */
export function withMemoryFixture<T>(
  mode: MemoryMode,
  body: (env: StoreEnv) => T,
  options: { readonly seed?: boolean } = {},
): T {
  const env = makeStoreEnv(`osb-wp2b-${mode}-`, { dualWrite: false });
  try {
    if (mode === "switched") switchDevice(env);
    if (options.seed ?? true) writeMemoryFixture(env);
    const answer = body(env);
    return normalise(answer, env.vault) as T;
  } finally {
    env.cleanup();
  }
}

/** {@link withMemoryFixture} for a body that awaits. */
export async function withMemoryFixtureAsync<T>(
  mode: MemoryMode,
  body: (env: StoreEnv) => Promise<T>,
  options: { readonly seed?: boolean } = {},
): Promise<T> {
  const env = makeStoreEnv(`osb-wp2b-${mode}-`, { dualWrite: false });
  try {
    if (mode === "switched") switchDevice(env);
    if (options.seed ?? true) writeMemoryFixture(env);
    return normalise(await body(env), env.vault) as T;
  } finally {
    env.cleanup();
  }
}

function normalise(value: unknown, vault: string): unknown {
  if (typeof value === "string") {
    return withoutMintTag(value.split(vault).join("<vault>").replace(/\\/g, "/"));
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, vault));
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [normalise(k, vault), normalise(v, vault)]));
  }
  if (value instanceof Set) return new Set([...value].map((v) => normalise(v, vault)));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v, vault)]));
  }
  return value;
}
