/**
 * `o2b brain profile` (Workspace Insight Suite, t_323a9a83): materialize
 * the compact `Brain/profile.md` digest plus the `.o2bfs` root marker.
 * Age-gated: an existing fresh profile is left alone unless --force.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { isProfileStale, writeProfileDoc } from "../../../core/brain/profile-doc.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const DEFAULT_STALE_SECONDS = 3600;

export async function cmdBrainProfile(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "stale-seconds": { type: "string" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const json = flags["json"] === true;

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const staleRaw = flags["stale-seconds"];
    const staleSeconds =
      typeof staleRaw === "string" && staleRaw.trim() !== ""
        ? Number(staleRaw)
        : DEFAULT_STALE_SECONDS;
    if (!Number.isFinite(staleSeconds) || staleSeconds < 0) {
      return fail("--stale-seconds must be a non-negative number");
    }
    const now = new Date();
    if (flags["force"] !== true && !isProfileStale(vault, staleSeconds, now)) {
      if (json) okJson({ ok: true, refreshed: false, reason: "fresh" });
      else ok("profile is fresh (use --force to regenerate)");
      return 0;
    }
    const result = writeProfileDoc(vault, { now });
    if (json) {
      okJson({
        ok: true,
        refreshed: true,
        path: result.path,
        marker: result.markerPath,
        generated_at: result.generatedAt,
      });
    } else ok(`profile written: ${result.path}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
