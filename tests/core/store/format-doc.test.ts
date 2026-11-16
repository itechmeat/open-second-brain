/**
 * The shipped FORMAT.md names every envelope field, stream, partition and
 * store-level record kind the code defines, and every other store name a
 * reader of the files meets, so the public format cannot fall behind the code.
 */
import { describe, expect, test } from "bun:test";

import {
  AUTHORITIES,
  AUTHORITY_FIELD,
  BLOB_REF_BYTES_KEY,
  BLOB_REF_KEY,
  BLOB_TEMP_PREFIX,
  DUAL_WRITE_RECORD_KINDS,
  ENVELOPE_FIELDS,
  FOLD_RECORD_KINDS,
  PREFERENCE_COUNTER_FIELDS,
  SETTING_KEYS,
  STATE_DIGEST_FOLDS,
  STORE_BLOBS_DIR,
  STORE_FORMAT_FILE,
  STORE_FORMAT_VERSION,
  STORE_IDENTITY_FILE,
  STORE_BODY_MAX_DEPTH,
  STORE_LINE_CAP_BYTES,
  STORE_PARTITIONS,
  STORE_RECORD_KINDS,
  STORE_STREAMS,
} from "../../../src/core/store/constants.ts";
import { DUAL_WRITE_LEDGERS } from "../../../src/core/store/dual-write-records.ts";
import { formatDocVersion, shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import {
  IF_DECIDED_BY_FIELD,
  KEYED_LIST_SETTINGS,
} from "../../../src/core/store/fold-setting-lists.ts";
import {
  SCHEMA_DECIDED_RECORDS_FIELD,
  SCHEMA_IMPORT_BASELINE_ACTION,
  SCHEMA_MUTATION_AUDIT_ACTION,
  SCHEMA_MUTATION_AUDIT_DIR,
} from "../../../src/core/brain/schema-integrity.ts";
import { SCHEMA_PACK_FIELDS } from "../../../src/core/brain/schema-pack-store.ts";

const doc = shippedFormatDoc();

/** A definition bullet for `name`: `- \`<name>\`:` at the start of a line, the name matched literally. */
const bullet = (name: string): RegExp =>
  new RegExp(`^- \`${name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`:`, "m");

/** Names written as inline code, the way the document spells every format term. */
const codeSpans = new Set([...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!));

describe("FORMAT.md", () => {
  test.each([...ENVELOPE_FIELDS])("documents the envelope field %s", (field) => {
    expect(codeSpans.has(field)).toBe(true);
    expect(doc).toMatch(bullet(field));
  });

  test.each([...STORE_STREAMS])("documents the stream %s", (stream) => {
    expect(doc).toMatch(bullet(stream));
  });

  test.each([...STORE_PARTITIONS])("documents the partition %s", (partition) => {
    expect(doc).toMatch(bullet(partition));
  });

  test.each([...STORE_RECORD_KINDS])("documents the store record kind %s", (kind) => {
    expect(doc).toMatch(bullet(kind));
  });

  test.each([...DUAL_WRITE_RECORD_KINDS])("documents the dual-write record kind %s", (kind) => {
    expect(doc).toMatch(bullet(kind));
  });

  test.each(Object.values(DUAL_WRITE_LEDGERS))("documents the dual-write ledger %s", (name) => {
    expect(doc).toContain(`\`${name}\``);
  });

  test("tells readers and sync setups to ignore dot-prefixed blob temp files", () => {
    expect(doc).toContain(`\`${BLOB_TEMP_PREFIX}\``);
  });

  test.each([...FOLD_RECORD_KINDS])("documents the fold and digest record kind %s", (kind) => {
    expect(doc).toMatch(bullet(kind));
  });

  test.each([...AUTHORITIES])("documents the authority %s", (authority) => {
    expect(doc).toMatch(bullet(authority));
  });

  test.each([...SETTING_KEYS])("documents the setting key %s", (key) => {
    expect(doc).toMatch(bullet(key));
  });

  test("names the authority field, the derived counters and the digested folds", () => {
    expect(codeSpans.has(AUTHORITY_FIELD)).toBe(true);
    for (const name of [...PREFERENCE_COUNTER_FIELDS, ...STATE_DIGEST_FOLDS]) {
      expect(codeSpans.has(name)).toBe(true);
    }
  });

  test("names the files, the blob reference keys and the line cap", () => {
    for (const name of [STORE_FORMAT_FILE, STORE_IDENTITY_FILE, BLOB_REF_KEY, BLOB_REF_BYTES_KEY]) {
      expect(doc).toContain(name);
    }
    expect(doc).toContain(`${STORE_BLOBS_DIR}/<sha256[0:2]>/<sha256>`);
    expect(doc).toContain(String(STORE_LINE_CAP_BYTES));
    expect(doc).toContain(`at most ${STORE_BODY_MAX_DEPTH} levels deep`);
  });

  test("declares the format version the code writes", () => {
    expect(formatDocVersion(doc)).toBe(STORE_FORMAT_VERSION);
    expect(doc).toContain(`Format version: ${STORE_FORMAT_VERSION}`);
  });

  test("states which keys are list settings and how an entry's register is named", () => {
    expect(doc).toContain(
      "a `setting-entry` record for any other key is not applied, so a key that holds one value stays one register",
    );
    for (const key of KEYED_LIST_SETTINGS) expect(codeSpans.has(key)).toBe(true);
    expect(doc).toContain("NFC-normalised");
  });

  test("names the schema attestation rows the code writes", () => {
    for (const name of [
      SCHEMA_MUTATION_AUDIT_ACTION,
      SCHEMA_IMPORT_BASELINE_ACTION,
      SCHEMA_DECIDED_RECORDS_FIELD,
      SCHEMA_MUTATION_AUDIT_DIR,
      "adopted",
      "adopted_by",
    ]) {
      expect(codeSpans.has(name)).toBe(true);
    }
  });

  test("binds each attested record to its content and names the fields the pack reads", () => {
    expect(codeSpans.has("<id>:<sha256>")).toBe(true);
    expect(doc).toContain("the sha256 of the record's canonical JSON");
    for (const field of SCHEMA_PACK_FIELDS) expect(codeSpans.has(field)).toBe(true);
    expect(doc).toContain("each side of a `name=value` line normalised on its own");
  });

  test("rejects a whole-list value of a list setting that is no list, and reads the schema once", () => {
    expect(doc).toContain(
      "A `setting-set` of a list setting whose value is not a list of one-line strings, numbers or booleans is not applied",
    );
    expect(doc).not.toContain("a `setting-set` of any other value and a `setting-unset` offer");
    expect(doc).toContain("from one read of the `settings` stream");
  });

  test("drops a link constraint pair whose endpoint is undeclared", () => {
    expect(doc).toContain(
      "a link constraint pair whose source or target the vocabulary does not hold, and the constraints of an undeclared link type or of one left with no pair",
    );
  });

  test("dual-writes the tombstone of a lane page an unswitched machine removes or moves", () => {
    expect(doc).toContain(
      "writes it beside a removed or moved legacy page whose entry the store holds",
    );
  });

  test("a deciding record no row attests is a finding even when the pack digests as recorded", () => {
    expect(doc).toContain("even when the pack matches the newest row's digest");
    expect(doc).toContain("still decides the entry's slot when the removal is written");
  });

  test("a lane move replaces a shared destination with a private one by its tombstone first", () => {
    expect(doc).toContain("a move that replaces a shared entry with a private one");
    expect(doc).toContain("A move onto the entry it moves writes nothing");
    expect(doc).toContain("built from the page as it is on disk after the move");
  });

  test("a repair's removal is conditional on the record it judged, and compound keys split like the parser", () => {
    expect(codeSpans.has(IF_DECIDED_BY_FIELD)).toBe(true);
    expect(doc).toContain("applies only while the record it names decides the entry's slot");
    expect(doc).toContain("a compound `type.field` name is split at its first `.`");
  });

  test("a moved lane page that is a link is not read, and a folder is never moved into itself", () => {
    expect(doc).toContain("never read through a symbolic link");
    expect(doc).toContain("that of a destination entry the rename overwrote");
    expect(doc).toContain(
      "A folder is never moved into its own subfolder, nor into a folder that holds it",
    );
    expect(doc).toContain(
      "a record in `private` whose body blob has not arrived, quarantined on this machine or not",
    );
  });

  test("if_decided_by is ignored on other kinds, and a key that names no entry is removed", () => {
    expect(doc).toContain("on a `setting-set` or `setting-unset` it is ignored");
    expect(doc).toContain("name no entry at all once the conditional removals");
  });

  test("a move keeps a private destination private, stays in the lanes, and replaces an overwritten entry", () => {
    expect(doc).toContain(
      "A move lands in `private` when the entry it replaces at its destination is private",
    );
    expect(doc).toContain(
      "to a path that is no lane entry (outside `Brain/`, or not in a lane folder) is refused",
    );
    expect(doc).toContain("so the store never keeps the content the rename replaced");
  });

  test("describes no earlier release that misreads setting-entry", () => {
    expect(doc).not.toContain("from before `setting-entry`");
    expect(doc).toContain("Format version 1 includes `setting-entry` from the first release");
  });

  test("follows the documentation style rules", () => {
    expect(doc).toContain("Open Second Brain");
    const prose = doc.replaceAll(/<!--.*?-->/g, "");
    expect(/\bOSB\b/.test(prose)).toBe(false);
    expect(prose.includes("!")).toBe(false);
    expect(prose.includes("—")).toBe(false);
  });
});
