/**
 * Read facade for captured signals (design D14, task 2.10): the signal
 * fold on a store-only machine, the signal pages on an unswitched one, in
 * the shape of the `signal` record body (FORMAT.md, "The other kinds"):
 * the signal id, its vault-relative path, whether it was staged for
 * approval, its frontmatter and its raw text, plus its lifecycle state.
 *
 * States (`../fold-signals.ts`): `active` (the inbox), `staged` (waiting
 * for write approval), `consumed` (the dream pass used it), `archived`
 * (it left the contradiction window unused), `retired`, `expired` and
 * `rejected`. The legacy side reads them from the folders a signal moves
 * through: `Brain/inbox/` is active, `Brain/pending/` staged,
 * `inbox/processed/` consumed, `inbox/archived/` archived and the
 * `sig-*` pages of `Brain/retired/` retired. The store side reads the
 * `signal-state` records. Two limits of the legacy side: it has no folder
 * for `expired` (an expiry moves no page) and none for `rejected` (a
 * rejected signal sits in `retired/` and reads as retired). `path` is
 * where the page is in its state on both sides.
 *
 * By default only the live states (active and staged) are returned, as
 * before; `states` widens the read.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_INBOX_REL,
  BRAIN_PENDING_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
} from "../../brain/path-constants.ts";
import { parseFrontmatterText } from "../../vault.ts";
import { LIVE_SIGNAL_STATES, type SignalLifecycle } from "../fold-signals.ts";
import { isPrivatePageFile } from "../private-page.ts";
import { readSource, type ReadContext } from "./read-context.ts";
import { readEntitiesOf } from "./store-entities.ts";

/** One captured signal as the facade returns it. */
export interface SignalEntry {
  readonly id: string;
  /** Vault-relative path of the signal page, `/`-separated. */
  readonly path: string;
  readonly staged: boolean;
  /** Where the signal is in its lifecycle. */
  readonly state: SignalLifecycle;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly raw: string | null;
  readonly private: boolean;
}

const SIGNAL_PREFIX = "sig-";
const PAGE_EXT = ".md";
/** The body section the signal writer puts the raw text under. */
const RAW_HEADING = "## Raw";

function rawOf(body: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === RAW_HEADING);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const text = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return text === "" ? null : text;
}

/** Options of {@link readSignals}. */
export interface ReadSignalsOptions {
  /** The lifecycle states to return (default: active and staged). */
  readonly states?: ReadonlySet<SignalLifecycle> | "all";
}

/**
 * The legacy folder each lifecycle state lives in, least advanced first:
 * a page found in two folders (a move cut off between its copy and its
 * delete) is the signal in the later one.
 */
const LEGACY_FOLDERS: ReadonlyArray<{ rel: string; state: SignalLifecycle }> = Object.freeze([
  { rel: BRAIN_PENDING_REL, state: "staged" },
  { rel: BRAIN_INBOX_REL, state: "active" },
  { rel: BRAIN_PROCESSED_REL, state: "consumed" },
  { rel: BRAIN_ARCHIVED_SIGNALS_REL, state: "archived" },
  { rel: BRAIN_RETIRED_REL, state: "retired" },
]);

/**
 * The folder a lifecycle state puts a signal page in, as the legacy movers
 * do (a rejected signal goes to `retired/`); `undefined` for a state that
 * moves no page (`expired`).
 */
export function signalStateFolder(state: SignalLifecycle): string | undefined {
  if (state === "rejected") return BRAIN_RETIRED_REL;
  return LEGACY_FOLDERS.find((folder) => folder.state === state)?.rel;
}

/**
 * Where a signal captured at `capture` sits in `state`: the state's folder
 * under the capture's file name, or the capture path when the state moves
 * no page or the page is already in that folder.
 */
export function signalPagePath(capture: string, state: SignalLifecycle): string {
  const folder = signalStateFolder(state);
  const slash = capture.lastIndexOf("/");
  if (folder === undefined || capture.slice(0, slash) === folder) return capture;
  return `${folder}/${capture.slice(slash + 1)}`;
}

function legacyIn(vault: string, rel: string, state: SignalLifecycle): SignalEntry[] {
  const staged = state === "staged";
  const dir = join(vault, ...rel.split("/"));
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(SIGNAL_PREFIX) && e.name.endsWith(PAGE_EXT))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: SignalEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const [frontmatter, body] = parseFrontmatterText(text);
    const id =
      typeof frontmatter["id"] === "string" ? frontmatter["id"] : name.slice(0, -PAGE_EXT.length);
    out.push({
      id,
      path: `${rel}/${name}`,
      staged,
      state,
      frontmatter: { ...frontmatter },
      raw: rawOf(body),
      private: isPrivatePageFile(path),
    });
  }
  return out;
}

function byId(a: SignalEntry, b: SignalEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function wanted(options: ReadSignalsOptions): (state: SignalLifecycle) => boolean {
  const states = options.states ?? LIVE_SIGNAL_STATES;
  return states === "all" ? () => true : (state) => states.has(state);
}

/** The captured signals in the requested states (default: active and staged), sorted by id. */
export function readSignals(
  context: ReadContext = {},
  options: ReadSignalsOptions = {},
): SignalEntry[] {
  const keep = wanted(options);
  const source = readSource(context);
  if (source.kind === "legacy") {
    // Every folder is read, so a page left in two of them is one signal,
    // in the later folder, whichever states were asked for.
    const byIdLatest = new Map<string, SignalEntry>();
    for (const folder of LEGACY_FOLDERS) {
      for (const entry of legacyIn(source.vault, folder.rel, folder.state)) {
        byIdLatest.set(entry.id, entry);
      }
    }
    return [...byIdLatest.values()].filter((entry) => keep(entry.state)).toSorted(byId);
  }
  if (source.store === null) return [];
  const out: SignalEntry[] = [];
  for (const [id, signal] of readEntitiesOf(source.store).signals) {
    if (!keep(signal.state)) continue;
    const body = signal.record.body;
    out.push({
      id,
      // Where the page is now, as on the legacy side, not where it was captured.
      path: typeof body["path"] === "string" ? signalPagePath(body["path"], signal.state) : "",
      staged: signal.state === "staged",
      state: signal.state,
      frontmatter: { ...signal.frontmatter },
      raw: typeof body["raw"] === "string" ? body["raw"] : null,
      private: signal.private,
    });
  }
  return out.toSorted(byId);
}
