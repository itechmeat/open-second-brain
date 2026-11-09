/**
 * Census of the migration map (task 2.1): every row of `STATE_SURFACES`
 * has exactly one mapping, no mapping names a surface that does not exist,
 * and every mapping states a destination the store format knows.
 */
import { describe, expect, test } from "bun:test";

import { STATE_SURFACE_ID, STATE_SURFACE_IDS } from "../../../src/core/state/surfaces.ts";
import { DUAL_WRITE_RECORD_KINDS, FOLD_RECORD_KINDS } from "../../../src/core/store/constants.ts";
import { DUAL_WRITE_LEDGERS } from "../../../src/core/store/dual-write-records.ts";
import { LANE_RECORD_KINDS } from "../../../src/core/store/lane-records.ts";
import {
  DESTINATION_KIND,
  DESTINATION_KINDS,
  MIGRATION_LEDGERS,
} from "../../../src/core/store-migration/destinations.ts";
import { LEGACY_LANES } from "../../../src/core/store-migration/lane-map.ts";
import { SURFACE_MAP } from "../../../src/core/store-migration/surface-map.ts";

const ALL = [
  ...Object.entries(SURFACE_MAP).map(([id, mapping]) => ({ id, mapping })),
  ...LEGACY_LANES.map((lane) => ({ id: lane.id, mapping: lane.mapping })),
];

describe("migration surface map", () => {
  test("every STATE_SURFACES row has a mapping", () => {
    const missing = STATE_SURFACE_IDS.filter((id) => !(id in SURFACE_MAP));
    expect(missing).toEqual([]);
  });

  test("no mapping names a surface that does not exist", () => {
    const known = new Set<string>(STATE_SURFACE_IDS);
    const unknown = Object.keys(SURFACE_MAP).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  test("lane ids are unique and never shadow a surface id", () => {
    const ids = LEGACY_LANES.map((lane) => lane.id);
    expect(new Set(ids).size).toBe(ids.length);
    const surfaces = new Set<string>(STATE_SURFACE_IDS);
    expect(ids.filter((id) => surfaces.has(id))).toEqual([]);
  });

  test.each(ALL)("$id maps to one known destination with a written reason", ({ mapping }) => {
    const destination = mapping.destination;
    expect(DESTINATION_KINDS).toContain(destination.to);
    if (destination.to === DESTINATION_KIND.stream) {
      expect([
        ...DUAL_WRITE_RECORD_KINDS,
        ...FOLD_RECORD_KINDS,
        ...LANE_RECORD_KINDS,
      ] as string[]).toContain(destination.kind);
      expect(destination.rule.trim()).not.toBe("");
      if (destination.ledger !== null) {
        const ledgers = [...Object.values(DUAL_WRITE_LEDGERS), ...Object.values(MIGRATION_LEDGERS)];
        expect(ledgers as ReadonlyArray<string>).toContain(destination.ledger);
      }
    } else {
      expect(destination.reason.trim()).not.toBe("");
    }
  });

  test("secrets, keys, attestations and checkpoints get an explicit backup", () => {
    for (const id of [
      STATE_SURFACE_ID.secretCustody,
      STATE_SURFACE_ID.attestationKeys,
      STATE_SURFACE_ID.attestations,
      STATE_SURFACE_ID.ingestCheckpoints,
      STATE_SURFACE_ID.sessionImportCheckpoints,
    ]) {
      expect(SURFACE_MAP[id].destination.to).toBe(DESTINATION_KIND.backup);
    }
  });

  test("memory-bearing vault content is never dropped", () => {
    expect(SURFACE_MAP[STATE_SURFACE_ID.brainLog].destination.to).toBe(DESTINATION_KIND.stream);
    expect(SURFACE_MAP[STATE_SURFACE_ID.prefAudit].destination.to).toBe(DESTINATION_KIND.stream);
    expect(SURFACE_MAP[STATE_SURFACE_ID.continuityLedger].destination.to).toBe(
      DESTINATION_KIND.stream,
    );
  });
});
