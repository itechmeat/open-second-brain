import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { BRAIN_ROOT_REL } from "./paths.ts";
import { assertVaultIdentityForWrite } from "./vault-identity.ts";

export interface HostMemoryPromotionEntry {
  readonly pref_id: string;
  readonly sha256: string;
  readonly promoted_at: string;
}

export interface HostMemoryPromotionsManifest {
  readonly version: 1;
  readonly promotions: Readonly<Record<string, HostMemoryPromotionEntry>>;
}

/**
 * What a load observed about the sidecar. `corrupt` is true when the file
 * exists but could not be read as the manifest shape - truncated mid-run,
 * hand-edited to a non-object, an array where the map belongs. The load
 * still hands back the empty shape (the promotion planner needs SOMETHING
 * to plan against), but the flag rides along so a dry run can say the
 * plan was computed blind and an apply can refuse rather than save the
 * empty set over a file that was mostly recoverable.
 */
export interface LoadedPromotionsManifest extends HostMemoryPromotionsManifest {
  readonly corrupt: boolean;
}

function manifestPath(vault: string): string {
  return join(vault, BRAIN_ROOT_REL, ".imports", "host-memory-promotions.json");
}

/**
 * Load the promotion-history sidecar for continuity host-memory writes.
 * Treats a missing file as "empty manifest" - first-time promotions rely
 * on this. Type-validates the parsed `promotions` field defensively: a
 * malformed file (hand-edited to non-object, truncated, etc.) returns the
 * empty shape rather than propagating an unknown blob into the rest of
 * the promotion pipeline, with `corrupt` set so the verb can surface the
 * state instead of silently planning against a history it lost.
 *
 * Structure mirrors `claude-memory-manifest.ts` (the import-history
 * sidecar) deliberately: both sidecars answer "which source rows already
 * landed as which preference, under which content hash", so a promotion
 * plans CREATE/UPDATE/RECREATE/SKIP_UNCHANGED/CONFLICT with the same
 * semantics an import plans them. The manifest KEY is the continuity
 * record id, which - unlike a memory file basename - is unique per row
 * by construction.
 */
export function loadPromotionsManifest(vault: string): LoadedPromotionsManifest {
  const p = manifestPath(vault);
  if (!existsSync(p)) return { version: 1, promotions: {}, corrupt: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { version: 1, promotions: {}, corrupt: true };
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof (raw as { promotions?: unknown }).promotions !== "object" ||
    (raw as { promotions?: unknown }).promotions === null ||
    Array.isArray((raw as { promotions?: unknown }).promotions)
  ) {
    return { version: 1, promotions: {}, corrupt: true };
  }
  return {
    version: 1,
    promotions: (raw as { promotions: Record<string, HostMemoryPromotionEntry> }).promotions,
    corrupt: false,
  };
}

export function savePromotionsManifest(vault: string, m: HostMemoryPromotionsManifest): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const p = manifestPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(m, null, 2) + "\n");
}
