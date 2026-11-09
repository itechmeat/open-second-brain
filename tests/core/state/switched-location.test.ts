/**
 * Every state surface states where it lives once this machine is switched
 * to the brain store (task 2.10, design D14), and that statement agrees
 * with the migration map (`store-migration/surface-map.ts`): a surface the
 * migration turns into records lives in the store; one it moves, backs up
 * or drops lives in the device-local state, or beside the search index.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";

import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import {
  inventoryStateSurfaces,
  renderStateInventory,
  STATE_SURFACE_ID,
  STATE_SURFACES,
  STATE_SWITCHED,
  type StateSurfaceId,
  type StateSwitched,
} from "../../../src/core/state/surfaces.ts";
import { DESTINATION_KIND } from "../../../src/core/store-migration/destinations.ts";
import { SURFACE_MAP } from "../../../src/core/store-migration/surface-map.ts";

afterEach(() => forgetMachineStateCache());

/** The search index and the files that follow it. */
const INDEX_SURFACES: ReadonlySet<StateSurfaceId> = new Set([
  STATE_SURFACE_ID.searchIndex,
  STATE_SURFACE_ID.searchWriterLock,
  STATE_SURFACE_ID.searchSessionFocus,
  STATE_SURFACE_ID.freshenState,
]);

/**
 * Surfaces whose live location differs from the migration's destination,
 * each with the reason.
 */
const DEVIATIONS: ReadonlyMap<StateSurfaceId, string> = new Map([
  [
    STATE_SURFACE_ID.writeImages,
    "the migration imports existing write images as blobs; the live undo buffer of note " +
      "writes stays in the device-local state until the note tools read blobs back",
  ],
]);

function expected(id: StateSurfaceId): StateSwitched {
  if (INDEX_SURFACES.has(id)) return STATE_SWITCHED.index;
  const to = SURFACE_MAP[id].destination.to;
  return to === DESTINATION_KIND.stream || to === DESTINATION_KIND.blob
    ? STATE_SWITCHED.store
    : STATE_SWITCHED.deviceLocal;
}

describe("switched location", () => {
  test("every surface agrees with the migration map, deviations named", () => {
    const disagree = STATE_SURFACES.filter(
      (s) => s.switched !== expected(s.id) && !DEVIATIONS.has(s.id),
    ).map((s) => `${s.id}: ${s.switched} vs ${expected(s.id)}`);
    expect(disagree).toEqual([]);
    for (const id of DEVIATIONS.keys()) {
      expect(STATE_SURFACES.find((s) => s.id === id)?.switched).not.toBe(expected(id));
    }
  });

  test("a device-local surface is measured under the state root when one is named", () => {
    const vault = join("/v", "vault");
    const root = join("/state", "migration", "local");
    const inventory = inventoryStateSurfaces({
      vault,
      env: {},
      config: {},
      stateRoot: root,
      statAt: () => undefined,
    });
    for (const row of inventory.surfaces) {
      const surface = STATE_SURFACES.find((s) => s.id === row.id)!;
      const vaultPath = surface.derive(vault, null);
      if (row.switched === STATE_SWITCHED.deviceLocal) {
        expect(row.path).toBe(join(root, relative(vault, vaultPath)));
      } else {
        expect(row.path).toBe(vaultPath);
      }
    }
  });

  test("an unswitched machine is measured in the vault, and the rendering names the move", () => {
    const vault = join("/v", "vault");
    const inventory = inventoryStateSurfaces({
      vault,
      env: {},
      config: {},
      stateRoot: null,
      statAt: () => undefined,
    });
    expect(inventory.surfaces.every((r) => r.path.startsWith(vault))).toBe(true);
    expect(renderStateInventory(inventory)).toContain(
      "once switched to the brain store: in this machine's device-local state",
    );
  });
});
