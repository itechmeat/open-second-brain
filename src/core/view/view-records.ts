/**
 * The store records of the render protocol (design D7, task 2.8): render
 * records with their merge base, replaced page versions, ingested human
 * edits, the idle heartbeat and the device-local render intents.
 *
 *  - `view-render` `{ page, sum, base, bytes }` (`log`, `shared`): the page
 *    now holds the bytes whose sha256 is `sum`; `base` names the blob that
 *    keeps that text and the key of each line, the base of the next
 *    three-way merge. Written only after the page is in place.
 *  - `view-replaced` `{ page, sum, blob, bytes, reason }` (`log`): bytes of
 *    a page that were not the writer's own render (a human edit, a racing
 *    edit, a conflict copy, a foreign file), kept as a blob so
 *    `o2b view recover` can list them.
 *  - `view-pass` `{ written: 0 }` (`log`, `shared`): an idle pass, at most
 *    once a day, so doctor can tell a quiet writer from a silent one.
 *
 * An ingest is one writer operation: its privacy is judged once over the
 * whole edited text (the `<private>` region test, and the page references
 * of the vault when one is configured), it runs inside that verdict's
 * operation scope, and its replaced version and every human record it
 * writes land in that one partition. A private ingest on a machine without
 * the private partition is refused before anything is written.
 *
 * A render intent (device-local, never synced) is written right before a
 * page is put in place and removed after its render record: when the
 * process dies in between, the next pass finds the page holding the
 * intent's bytes and writes the missing record, so the writer's own render
 * is never mistaken for a human edit.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../integrity/digest.ts";
import { appendRecord, PartitionUnavailableError } from "../store/appender.ts";
import { writeBlob } from "../store/blobs.ts";
import { STORE_TMP_DIR, type StorePartition } from "../store/constants.ts";
import { canonicalBodyText, compareRecords, type StoreRecord } from "../store/envelope.ts";
import { callerInput, opaqueFields, operationPrivacy } from "../store/operation-privacy.ts";
import { withOperationPrivacy } from "../store/operation-scope.ts";
import { textCarriesPrivateRegion } from "../store/private-region.ts";
import { parseHlc } from "../store/hlc.ts";
import { readBlobBody } from "../store/reader.ts";
import type { StoreHandle } from "../store/store-open.ts";
import { partitionDir } from "../store/store-paths.ts";
import {
  VIEW_INTENT_DIR,
  VIEW_PASS_INTERVAL_MS,
  VIEW_PASS_KIND,
  VIEW_RENDER_KIND,
  VIEW_REPLACED_KIND,
  VIEW_STATE_DIR,
} from "./constants.ts";
import type { EditRecord } from "./corrections.ts";
import { allRecords, type ViewCatchUp } from "./catch-up.ts";

/** The merge base a render record names. */
export interface RenderBase {
  readonly text: string;
  readonly keys: ReadonlyArray<string | null>;
}

/** Why a page version was kept. */
export type ReplacedReason = "edit" | "race" | "conflict-copy" | "foreign";

/** Where a record was found. */
export interface PlacedRecord {
  readonly record: StoreRecord;
  readonly partition: StorePartition;
}

export function bytesSum(bytes: Buffer | string): string {
  return sha256Hex(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
}

function located(read: ViewCatchUp, kind: string, page: string): PlacedRecord[] {
  const out: PlacedRecord[] = [];
  for (const [partition, records] of read.records) {
    for (const record of records) {
      if (record.kind === kind && record.body["page"] === page) out.push({ record, partition });
    }
  }
  return out.toSorted((a, b) => compareRecords(a.record, b.record));
}

/** The latest render record of `page`, on any device. */
export function lastRender(read: ViewCatchUp, page: string): PlacedRecord | null {
  return located(read, VIEW_RENDER_KIND, page).at(-1) ?? null;
}

/** Checksums of every text the writer rendered into `page`: never a human edit. */
export function ownSums(read: ViewCatchUp, page: string): Set<string> {
  return new Set(located(read, VIEW_RENDER_KIND, page).map((p) => p.record.body["sum"] as string));
}

/** Versions of `page` already ingested since its last render: checksum to the partition they went to. */
export function ingestedSinceLastRender(
  read: ViewCatchUp,
  page: string,
): Map<string, StorePartition> {
  const last = lastRender(read, page);
  return new Map(
    located(read, VIEW_REPLACED_KIND, page)
      .filter((v) => last === null || compareRecords(v.record, last.record) > 0)
      .map((v) => [v.record.body["sum"] as string, v.partition] as const),
  );
}

/** The replaced versions of `page`, oldest first. */
export function replacedVersions(read: ViewCatchUp, page: string): PlacedRecord[] {
  return located(read, VIEW_REPLACED_KIND, page);
}

/** The merge base of a render record; `null` while its blob has not arrived. */
export function loadBase(store: StoreHandle, render: PlacedRecord): RenderBase | null {
  const blob = render.record.body["base"];
  if (typeof blob !== "string") return null;
  const read = readBlobBody(partitionDir(store.root, render.partition), blob);
  if (read.status !== "ok") return null;
  const { text, keys } = read.body;
  if (typeof text !== "string" || !Array.isArray(keys)) return null;
  return { text, keys: keys.map((k) => (typeof k === "string" ? k : null)) };
}

/** The text of a replaced version; `null` while its blob has not arrived. */
export function loadReplaced(store: StoreHandle, version: PlacedRecord): string | null {
  const blob = version.record.body["blob"];
  if (typeof blob !== "string") return null;
  const read = readBlobBody(partitionDir(store.root, version.partition), blob);
  return read.status === "ok" && typeof read.body["text"] === "string" ? read.body["text"] : null;
}

function tempDir(store: StoreHandle): { tempDir: string } {
  return { tempDir: join(store.deviceStateDir, STORE_TMP_DIR) };
}

export interface RecordOptions {
  readonly agent: string;
  readonly now?: () => number;
  /** The vault whose page references the privacy verdict resolves (none: regions only). */
  readonly vault: string | null;
}

/** Whether an edited text must stay out of `shared`. */
export function editIsPrivate(text: string, vault: string | null): boolean {
  if (vault === null) return textCarriesPrivateRegion(text);
  return operationPrivacy(vault, { content: [callerInput({ text }, opaqueFields())] })();
}

/**
 * Keep `text` as a replaced version of `page` and write the human records
 * `edits` derived from it, all in the one partition of the operation's
 * verdict. Throws {@link PartitionUnavailableError} for a private edit on a
 * machine without the private partition, before anything is written.
 */
export function ingestVersion(
  store: StoreHandle,
  page: string,
  text: string,
  reason: ReplacedReason,
  edits: ReadonlyArray<EditRecord>,
  options: RecordOptions,
): { readonly partition: StorePartition; readonly records: number } {
  const isPrivate = editIsPrivate(text, options.vault);
  const partition: StorePartition = isPrivate ? "private" : "shared";
  if (!store.partitions.has(partition)) throw new PartitionUnavailableError(partition, store.root);
  const now = options.now !== undefined ? { now: options.now } : {};
  return withOperationPrivacy(isPrivate, () => {
    const blob = writeBlob(
      partitionDir(store.root, partition),
      canonicalBodyText({ page, text }),
      tempDir(store),
    );
    appendRecord(
      store,
      {
        partition,
        stream: "log",
        kind: VIEW_REPLACED_KIND,
        agent: options.agent,
        body: { page, sum: bytesSum(text), blob: blob.sha, bytes: Buffer.byteLength(text), reason },
      },
      now,
    );
    for (const edit of edits) {
      appendRecord(
        store,
        { partition, stream: edit.stream, kind: edit.kind, agent: options.agent, body: edit.body },
        now,
      );
    }
    return { partition, records: edits.length };
  });
}

/** Store the merge base of a render and return its blob sha. */
export function writeBase(store: StoreHandle, page: string, base: RenderBase): string {
  return writeBlob(
    partitionDir(store.root, "shared"),
    canonicalBodyText({ page, text: base.text, keys: [...base.keys] }),
    tempDir(store),
  ).sha;
}

/** Record that `page` now holds the bytes of `intent`, rendered over its base blob. */
export function writeRender(
  store: StoreHandle,
  intent: RenderIntent,
  options: RecordOptions,
): StoreRecord {
  return appendRecord(
    store,
    {
      partition: "shared",
      stream: "log",
      kind: VIEW_RENDER_KIND,
      agent: options.agent,
      body: { page: intent.page, sum: intent.sum, base: intent.base, bytes: intent.bytes },
    },
    options.now !== undefined ? { now: options.now } : {},
  ).record;
}

/** Write a `view-pass` when this device has published nothing in the view for a day. */
export function heartbeat(store: StoreHandle, read: ViewCatchUp, options: RecordOptions): boolean {
  const nowMs = (options.now ?? Date.now)();
  const last = allRecords(read).findLast(
    (r) => r.device === store.device && (r.kind === VIEW_PASS_KIND || r.kind === VIEW_RENDER_KIND),
  );
  if (last !== undefined && nowMs - parseHlc(last.hlc)!.physical < VIEW_PASS_INTERVAL_MS) {
    return false;
  }
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "log",
      kind: VIEW_PASS_KIND,
      agent: options.agent,
      body: { written: 0 },
    },
    options.now !== undefined ? { now: options.now } : {},
  );
  return true;
}

/** A page about to be put in place, kept device-local until its render record is written. */
export interface RenderIntent {
  readonly page: string;
  readonly sum: string;
  readonly base: string;
  readonly bytes: number;
}

function intentDir(store: StoreHandle): string {
  return join(store.deviceStateDir, VIEW_STATE_DIR, VIEW_INTENT_DIR);
}

function intentPath(store: StoreHandle, page: string): string {
  return join(intentDir(store), `${sha256Hex(page).slice(0, 32)}.json`);
}

export function writeIntent(store: StoreHandle, intent: RenderIntent): void {
  mkdirSync(intentDir(store), { recursive: true });
  writeFileSync(intentPath(store, intent.page), `${JSON.stringify(intent)}\n`);
}

export function clearIntent(store: StoreHandle, page: string): void {
  try {
    unlinkSync(intentPath(store, page));
  } catch {
    // none
  }
}

/** Intents a dead pass left behind. */
export function pendingIntents(store: StoreHandle): RenderIntent[] {
  const dir = intentDir(store);
  if (!existsSync(dir)) return [];
  const out: RenderIntent[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<RenderIntent>;
      if (
        typeof parsed.page === "string" &&
        typeof parsed.sum === "string" &&
        typeof parsed.base === "string" &&
        typeof parsed.bytes === "number"
      ) {
        out.push(parsed as RenderIntent);
        continue;
      }
    } catch {
      // unreadable: dropped below
    }
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Already gone (another pass), held open, or not a file: left for a
      // later pass; a stray entry never stops the render.
    }
  }
  return out;
}
