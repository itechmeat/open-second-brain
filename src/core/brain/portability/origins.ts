/**
 * Search-origin enumeration (Workspace Insight Suite, t_72a22658).
 *
 * One place answers "which vaults participate in cross-vault recall":
 * the active vault first (label `local`), then registered profile
 * vaults (`profile/<name>`), then read-only recall sources
 * (`source/<alias>`), deduped by resolved path with earlier kinds
 * winning. Labels are namespaced by kind so a profile and a source can
 * never collide, and they double as the `origin:` reason prefix on
 * search results.
 *
 * Only existing directories are enumerated: broken sources stay
 * visible through `listRecallSources` / `o2b brain source list`, but
 * they never reach the search fan-out.
 */

import { resolve } from "node:path";

import { isDir as isDirectory } from "../../fs-utils.ts";
import { listProfiles } from "./profiles.ts";
import { listRecallSources } from "./recall-sources.ts";

export type SearchOriginKind = "active" | "profile" | "source";

export interface SearchOrigin {
  /** Bare name: profile name, source alias, or "local". */
  readonly alias: string;
  /** Kind-namespaced label used in `origin:` reasons: "local", "profile/x", "source/y". */
  readonly label: string;
  readonly vault: string;
  readonly kind: SearchOriginKind;
}

export function listSearchOrigins(
  configPath: string,
  activeVault: string,
): ReadonlyArray<SearchOrigin> {
  const activeResolved = resolve(activeVault);
  const seen = new Set<string>([activeResolved]);
  const origins: SearchOrigin[] = [
    Object.freeze({
      alias: "local",
      label: "local",
      vault: activeResolved,
      kind: "active" as const,
    }),
  ];
  for (const profile of listProfiles(configPath).profiles) {
    const vault = resolve(profile.vault);
    if (seen.has(vault) || !isDirectory(vault)) continue;
    seen.add(vault);
    origins.push(
      Object.freeze({
        alias: profile.name,
        label: `profile/${profile.name}`,
        vault,
        kind: "profile" as const,
      }),
    );
  }
  for (const source of listRecallSources(configPath, activeVault)) {
    const vault = resolve(source.vault);
    if (seen.has(vault) || source.broken) continue;
    seen.add(vault);
    origins.push(
      Object.freeze({
        alias: source.alias,
        label: `source/${source.alias}`,
        vault,
        kind: "source" as const,
      }),
    );
  }
  return Object.freeze(origins);
}
