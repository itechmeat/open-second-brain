/**
 * The vocabulary of the legacy-to-store migration map (task 2.1, design
 * D11 step 4): where one legacy surface goes, and how its items are laid
 * out on disk so the migration can find and count them.
 *
 * Every surface goes to exactly one destination:
 *
 *  - `stream`: each legacy item becomes one store record, built by the
 *    phase 1 dual-write record builders (`store/dual-write-records.ts`) and
 *    placed in its partition by the phase 1 privacy rules
 *    (`store/operation-privacy.ts`, `store/reference-privacy.ts`). There is
 *    no second record shape: a mapping's `record` function returns the
 *    same {@link DualWriteRecord} a live dual write of that item returns.
 *  - `blob`: the legacy bytes become content-addressed blobs.
 *  - `device-local`: moved into the device-local state directory of the
 *    machine that migrates, never synced.
 *  - `backup`: non-rebuildable state (secrets, keys, attestations,
 *    checkpoints, lockfiles): copied to an explicit backup that is verified
 *    by a test restore, then kept in device-local state.
 *  - `drop`: derived or transient state that is not carried over. Every
 *    drop names why losing it costs nothing the store needs.
 *
 * This module holds types and vocabularies only. The tables are in
 * `surface-map.ts` (one row per `STATE_SURFACES` row) and `lane-map.ts`
 * (the `Brain/` lanes outside that catalogue).
 */

import type { LedgerShardGrammar } from "../brain/ledger-shards.ts";
import type { StoreStream } from "../store/constants.ts";
import type { DualWriteRecord } from "../store/dual-write.ts";
import type { RowPartition } from "../store/dual-write-records.ts";

/** The destination kinds, in the order the report groups them. */
export const DESTINATION_KIND = Object.freeze({
  stream: "stream",
  blob: "blob",
  deviceLocal: "device-local",
  backup: "backup",
  drop: "drop",
  /** Kept as files in the user's vault, moved out of the legacy tree (accepted skills). */
  vaultFiles: "vault-files",
} as const);

export type DestinationKind = (typeof DESTINATION_KIND)[keyof typeof DESTINATION_KIND];

export const DESTINATION_KINDS: ReadonlyArray<DestinationKind> = Object.freeze(
  Object.values(DESTINATION_KIND),
);

/**
 * Ledger names the migration introduces for append-only legacy surfaces
 * that have no dual write in format version 1. They reuse the `ledger-row`
 * record shape; FORMAT.md lists them once the real migration writes them.
 */
export const MIGRATION_LEDGERS = Object.freeze({
  captureDecisions: "capture-decisions",
  searchFeedback: "search-feedback",
  searchReinforce: "search-reinforce",
} as const);

/** One legacy item, as the scanner hands it to a stream mapping. */
export type LegacyItem =
  | {
      /** One line of an append-only JSONL file, already parsed. */
      readonly shape: "line";
      readonly path: string;
      readonly line: number;
      readonly row: unknown;
      /** The device id in the shard's name; empty for a legacy un-sharded file. */
      readonly device: string;
    }
  | {
      /** One file that holds one JSON value. */
      readonly shape: "json-file";
      readonly path: string;
      readonly value: unknown;
    }
  | {
      /** One Markdown page with frontmatter. */
      readonly shape: "page";
      readonly path: string;
      readonly frontmatter: Readonly<Record<string, unknown>>;
      readonly body: string;
    }
  | {
      /** One whole text file (pinned context). */
      readonly shape: "text";
      readonly path: string;
      readonly text: string;
    }
  | {
      /**
       * One entry of a record lane: a page (its frontmatter as `fields`,
       * its body as `text`), a JSON file (its object as `fields`), or any
       * text file (its content as `text`).
       */
      readonly shape: "entry";
      readonly path: string;
      readonly lane: string;
      readonly entry: string;
      readonly fields: Readonly<Record<string, unknown>>;
      readonly text: string;
    };

/**
 * Where a surface's items are on disk. `dir` and `path` are absolute.
 *
 *  - `jsonl`: per-device shards `<base>[.<device>].jsonl` matching
 *    `grammar` in `dir`, or in each direct subdirectory of `dir` when
 *    `subdirs` is set (one directory per preference, per repository).
 *  - `json-files`: one JSON value per `.json` file in `dir`.
 *  - `pages`: Markdown pages (`.md`) in `dir`.
 *  - `text`: one text file.
 *  - `entries`: the entries of a record lane, every `.md` and `.json`
 *    file below `root` (or every file, with `anyFile`), at any depth. With
 *    a fixed `lane` they all belong to it; with `lane: null` each belongs
 *    to the lane named by its top folder under `root` (a page directly in
 *    `root` to the lane `brain`), hidden folders excluded. Files another
 *    locator in `exclude` claims are not entries of this one.
 *  - `tree`: a file or a directory, counted as files and bytes. The shape
 *    of every surface that does not become records. With a `grammar`,
 *    only the matching files directly in the directory `path`.
 */
export type Locator =
  | {
      readonly shape: "jsonl";
      readonly dir: string;
      readonly grammar: LedgerShardGrammar;
      readonly subdirs?: true;
    }
  | { readonly shape: "json-files"; readonly dir: string }
  | { readonly shape: "pages"; readonly dir: string }
  | { readonly shape: "text"; readonly path: string }
  | {
      readonly shape: "entries";
      readonly root: string;
      readonly lane: string | null;
      readonly anyFile?: true;
      readonly exclude?: ReadonlyArray<Locator>;
    }
  | { readonly shape: "tree"; readonly path: string; readonly grammar?: LedgerShardGrammar };

/**
 * Builds the store records of one legacy item (one record, or several in
 * one partition, as a human-authored preference with derived fields
 * gives); throws when the item has the wrong shape.
 */
export type RecordFromItem = (
  vault: string,
  item: LegacyItem,
) => DualWriteRecord | ReadonlyArray<DualWriteRecord> | null;

/** A surface whose items become records. */
export interface StreamDestination {
  readonly to: typeof DESTINATION_KIND.stream;
  readonly stream: StoreStream;
  /** The ledger name, for the `ledgers` stream. */
  readonly ledger: string | null;
  readonly kind: string;
  /** The partition rule, as its record builder applies it. */
  readonly partition: RowPartition | "by-item";
  /** One sentence on how an item's partition is judged. */
  readonly rule: string;
  readonly record: RecordFromItem;
}

/**
 * A surface whose bytes become blobs: each file is one record of `kind`
 * whose body holds the file's text, which the appender spills into a
 * content-addressed blob when it is larger than a line.
 */
export interface BlobDestination {
  readonly to: typeof DESTINATION_KIND.blob;
  readonly partition: RowPartition;
  readonly reason: string;
  readonly kind: string;
  readonly record: RecordFromItem;
}

/** A destination whose items become records. */
export type RecordDestination = StreamDestination | BlobDestination;

/** Whether a destination's items become records. */
export function makesRecords(destination: Destination): destination is RecordDestination {
  return destination.to === DESTINATION_KIND.stream || destination.to === DESTINATION_KIND.blob;
}

/** A surface that is not turned into records. */
export interface PlainDestination {
  readonly to:
    | typeof DESTINATION_KIND.deviceLocal
    | typeof DESTINATION_KIND.backup
    | typeof DESTINATION_KIND.drop
    | typeof DESTINATION_KIND.vaultFiles;
  readonly reason: string;
}

export type Destination = StreamDestination | BlobDestination | PlainDestination;

/** One mapped legacy surface. */
export interface SurfaceMapping {
  readonly destination: Destination;
  /**
   * Where its items are. `primary` is the surface's own location (the
   * `STATE_SURFACES` derivation, or the lane's root). The default, when a
   * mapping gives none, is one `tree` locator at `primary`.
   */
  readonly locate?: (vault: string, primary: string) => ReadonlyArray<Locator>;
  /**
   * The files are recreated by the search index or a rebuild (an index,
   * a cache, a generated page). Removing the legacy tree does not keep
   * them in its archive.
   */
  readonly rebuildable?: true;
}

/** `mapping`, marked as recreated by the index or a rebuild. */
export function rebuildable(mapping: SurfaceMapping): SurfaceMapping {
  return { ...mapping, rebuildable: true };
}

/** A plain destination, written once per row of the tables. */
export function plain(to: PlainDestination["to"], reason: string): SurfaceMapping {
  return { destination: { to, reason } };
}

/** The destination as one line of the report. */
export function describeDestination(destination: Destination): string {
  switch (destination.to) {
    case DESTINATION_KIND.stream: {
      const stream =
        destination.ledger === null
          ? destination.stream
          : `${destination.stream}/${destination.ledger}`;
      return `stream ${stream} (${destination.kind}), partition ${destination.partition}: ${destination.rule}`;
    }
    case DESTINATION_KIND.blob:
      return `blob (${destination.kind}), partition ${destination.partition}: ${destination.reason}`;
    default:
      return `${destination.to}: ${destination.reason}`;
  }
}
