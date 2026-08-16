/**
 * Search-origin enumeration (Workspace Insight Suite, t_72a22658).
 *
 * One place answers "which vaults participate in cross-vault recall":
 * the active vault first (label `local`), then registered profile
 * vaults (`profile/<name>`), then read-only recall sources
 * (`source/<alias>`), then the shared namespace (`shared`), deduped by
 * resolved path with earlier kinds winning. Labels are namespaced by kind
 * so a profile and a source can never collide, and they double as the
 * `origin:` reason prefix on search results.
 *
 * Every registered origin is enumerated, each carrying the verdict of one
 * reachability probe (a-label-is-not-a-boundary, U5). Removing an origin
 * that could not be read used to happen HERE, one layer above the fan-out
 * that maintains the warnings array, so a union over three origins with one
 * dead origin came back as though that origin had honestly contributed
 * nothing. `recall-sources.ts` states the rule for the same fact one layer
 * down - reported, never dropped, the operator decides - and this module
 * used to undo it. Deciding whether to search an unreachable origin belongs
 * to the caller; deciding not to MENTION it never did.
 */

import { resolve } from "node:path";

import { resolveSharedNamespace } from "../../config.ts";
import { probeOriginReach, type OriginReach, type OriginReachReason } from "./origin-reach.ts";
import { listProfiles } from "./profiles.ts";
import { listRecallSources } from "./recall-sources.ts";

export type SearchOriginKind = "active" | "profile" | "source" | "shared";

/** Label of the shared namespace: one key, so one origin, so no namespace segment. */
const SHARED_ORIGIN_LABEL = "shared";

export interface SearchOrigin {
  /** Bare name: profile name, source alias, or "local". */
  readonly alias: string;
  /** Kind-namespaced label used in `origin:` reasons: "local", "profile/x", "source/y". */
  readonly label: string;
  readonly vault: string;
  readonly kind: SearchOriginKind;
  /** What a probe learned about this origin's vault directory. */
  readonly reach: OriginReach;
  /** Why the origin is not reachable. Absent exactly when it is. */
  readonly reason?: OriginReachReason;
}

/**
 * Freeze one origin with its probe verdict.
 *
 * The probe runs for every kind including the active vault: an active vault
 * that has been unmounted answers nothing either, and a caller reading the
 * verdict must not have to know which kinds were measured.
 */
function origin(alias: string, label: string, vault: string, kind: SearchOriginKind): SearchOrigin {
  const verdict = probeOriginReach(vault);
  return Object.freeze({
    alias,
    label,
    vault,
    kind,
    reach: verdict.reach,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
  });
}

export function listSearchOrigins(
  configPath: string,
  activeVault: string,
): ReadonlyArray<SearchOrigin> {
  const activeResolved = resolve(activeVault);
  const seen = new Set<string>([activeResolved]);
  const origins: SearchOrigin[] = [origin("local", "local", activeResolved, "active")];
  for (const profile of listProfiles(configPath).profiles) {
    const vault = resolve(profile.vault);
    if (seen.has(vault)) continue;
    seen.add(vault);
    origins.push(origin(profile.name, `profile/${profile.name}`, vault, "profile"));
  }
  // `RecallSourceStatus.broken` is deliberately not consulted: it is one
  // boolean over "absent" and "could not look", and the whole point of the
  // verdict is that those are different answers with different repairs.
  for (const source of listRecallSources(configPath, activeVault)) {
    const vault = resolve(source.vault);
    if (seen.has(vault)) continue;
    seen.add(vault);
    origins.push(origin(source.alias, `source/${source.alias}`, vault, "source"));
  }
  // The shared namespace is a WRITE target for the mirror; enumerating it
  // here is what makes it readable at all, so a vault an agent mirrors into
  // stops being a sink with no way back out.
  const shared = resolveSharedNamespace(configPath);
  if (shared !== null) {
    const vault = resolve(shared);
    if (!seen.has(vault)) {
      seen.add(vault);
      origins.push(origin(SHARED_ORIGIN_LABEL, SHARED_ORIGIN_LABEL, vault, "shared"));
    }
  }
  return Object.freeze(origins);
}
