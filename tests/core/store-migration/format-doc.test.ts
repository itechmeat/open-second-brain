/**
 * FORMAT.md documents the record kinds and ledger names the migration
 * writes, so the public format cannot fall behind the migration.
 */
import { describe, expect, test } from "bun:test";

import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import { LANE_RECORD_KINDS, STANDING_RULE_LANE } from "../../../src/core/store/lane-records.ts";
import { MIGRATION_LEDGERS } from "../../../src/core/store-migration/destinations.ts";
import {
  LEGACY_DEVICE_FIELD,
  MIGRATED_FIELD,
  MIGRATION_RECORD_KINDS,
} from "../../../src/core/store-migration/migration-records.ts";

const doc = shippedFormatDoc();
const bullet = (name: string): RegExp => new RegExp(`^- \`${name}\`:`, "m");

describe("FORMAT.md for the migration", () => {
  test.each([...LANE_RECORD_KINDS])("documents the lane kind %s", (kind) => {
    expect(doc).toMatch(bullet(kind));
  });

  test.each(Object.values(MIGRATION_LEDGERS))("documents the migration ledger %s", (name) => {
    expect(doc).toContain(`\`${name}\``);
  });

  test.each([...MIGRATION_RECORD_KINDS])("documents the migration kind %s", (kind) => {
    expect(doc).toMatch(bullet(kind));
  });

  test("documents the migrated mark and the legacy device of imported records", () => {
    expect(doc).toContain(`\`${MIGRATED_FIELD}\``);
    expect(doc).toContain(`\`${LEGACY_DEVICE_FIELD}\``);
  });

  test("names the standing-rule lane", () => {
    expect(doc).toContain(`\`${STANDING_RULE_LANE}\``);
  });
});
