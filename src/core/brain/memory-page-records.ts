/**
 * The store's memory records parsed by the page parsers (task 2.10): the
 * pages `memory-pages.ts` rebuilds from the folds, handed to
 * `parsePreferenceMeta`, `parseRetiredMeta` and `parseSignalPage`, with
 * the pages a parser refused listed beside the records. Apart from the
 * page views because the parsers live in the writers (`preference.ts`,
 * `signal.ts`), which the page views must not import.
 */

import { LIVE_SIGNAL_STATES, type SignalLifecycle } from "../store/fold-signals.ts";
import type { ReadContext } from "../store/read/read-context.ts";
import { storeRecordPages, type MemoryPageKind, type StoreMemoryPage } from "./memory-pages.ts";
import { parsePreferenceMeta, parseRetiredMeta } from "./preference.ts";
import { parseSignalPage } from "./signal.ts";
import type { BrainPreference, BrainRetired, BrainSignal } from "./types.ts";

/** A page that failed its kind's parser. */
export interface MemoryPageFailure {
  readonly page: StoreMemoryPage;
  readonly error: unknown;
}

/** Parsed records of one kind, plus the pages their parser refused. */
export interface ParsedMemoryPages<T> {
  readonly records: ReadonlyArray<{ readonly path: string; readonly page: StoreMemoryPage } & T>;
  readonly failures: ReadonlyArray<MemoryPageFailure>;
}

function parsed<T>(
  pages: ReadonlyArray<StoreMemoryPage>,
  parse: (page: StoreMemoryPage) => T,
): ParsedMemoryPages<T> {
  const records: Array<{ path: string; page: StoreMemoryPage } & T> = [];
  const failures: MemoryPageFailure[] = [];
  for (const page of pages) {
    try {
      records.push({ path: page.path, page, ...parse(page) });
    } catch (error) {
      failures.push({ page, error });
    }
  }
  return { records, failures };
}

const PREFERENCE_KIND: ReadonlySet<MemoryPageKind> = new Set(["preference"]);
const RETIRED_KIND: ReadonlySet<MemoryPageKind> = new Set(["retired"]);
const SIGNAL_KIND: ReadonlySet<MemoryPageKind> = new Set(["signal"]);

/** The store's active preferences, parsed by the page parser. */
export function storePreferenceRecords(
  vault: string | null,
  context: ReadContext = {},
): ParsedMemoryPages<{ readonly pref: BrainPreference }> {
  return parsed(storeRecordPages(vault, { ...context, kinds: PREFERENCE_KIND }), (page) => ({
    pref: parsePreferenceMeta(page.meta, page.path),
  }));
}

/** The store's retired preferences, parsed by the retired page parser. */
export function storeRetiredRecords(
  vault: string | null,
  context: ReadContext = {},
): ParsedMemoryPages<{ readonly retired: BrainRetired }> {
  return parsed(storeRecordPages(vault, { ...context, kinds: RETIRED_KIND }), (page) => ({
    retired: parseRetiredMeta(page.meta, page.path),
  }));
}

/** The store's signals in `states` (default: active and staged), parsed by the signal parser. */
export function storeSignalRecords(
  vault: string | null,
  states: ReadonlySet<SignalLifecycle> | "all" = LIVE_SIGNAL_STATES,
  context: ReadContext = {},
): ParsedMemoryPages<{ readonly signal: BrainSignal }> {
  return parsed(
    storeRecordPages(vault, { ...context, kinds: SIGNAL_KIND, signalStates: states }),
    // The page the fold rebuilt is already the parsed page: no second
    // render and parse round trip.
    (page) => {
      const [meta, body] = page.read();
      return { signal: parseSignalPage(meta, body, page.path) };
    },
  );
}
