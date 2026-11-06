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

  test("follows the documentation style rules", () => {
    expect(doc).toContain("Open Second Brain");
    const prose = doc.replaceAll(/<!--.*?-->/g, "");
    expect(/\bOSB\b/.test(prose)).toBe(false);
    expect(prose.includes("!")).toBe(false);
    expect(prose.includes("—")).toBe(false);
  });
});
