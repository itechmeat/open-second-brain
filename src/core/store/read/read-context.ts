/**
 * Where a read facade reads from (design D14, task 2.10): the store on a
 * store-only machine (`../store-only.ts`), the legacy tree of the vault on
 * an unswitched one. Every facade under this directory asks here once per
 * call, so a reader switched to a facade follows the machine's switch
 * with no code of its own.
 *
 * A store-only machine with no readable store reads as empty: the facade
 * answers "the store holds nothing", and the writers on the same machine
 * fail with the store's reason and remedy (`../store-write.ts`).
 */

import { storeOnlyMode, type StoreOnlyOptions } from "../store-only.ts";
import type { StoreInspection } from "../store-open.ts";
import { configuredStore } from "./store-entities.ts";

/** What a facade reads for. */
export interface ReadContext {
  /** The vault: a path, `null` for none, or absent to resolve the configured one. */
  readonly vault?: string | null;
  /** The machine config the vault, the device id and the store root come from. */
  readonly configPath?: string;
  /** Store-only predicate options (the switch-record reader). */
  readonly storeOnly?: StoreOnlyOptions;
}

/** The source one facade call reads. */
export type ReadSource =
  | { readonly kind: "store"; readonly store: StoreInspection | null }
  | { readonly kind: "legacy"; readonly vault: string };

/** Decide the source of one facade call. */
export function readSource(context: ReadContext = {}): ReadSource {
  const mode = storeOnlyMode(
    {
      ...(context.vault !== undefined ? { vault: context.vault } : {}),
      ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
    },
    context.storeOnly,
  );
  // Not store-only means a legacy tree exists, so a vault does.
  if (!mode.storeOnly && mode.vault !== null) return { kind: "legacy", vault: mode.vault };
  return { kind: "store", store: configuredStore(context.configPath) };
}
