/**
 * `o2b brain distill <source> --claims <json>` (t_2e2e959f): condense a source
 * into atomic claims with block-level provenance.
 *
 * Provider-agnostic: the agent supplies the atomic claims (and optional source
 * block ids) as JSON - a `[{ "text": "...", "block": "^abc" }]` array via
 * `--claims` or `--claims-file`. OSB validates them and writes one idempotent
 * distillation page per source. No model, no extraction here.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage errors.
 */

import { readFileSync } from "node:fs";

import {
  distillSource,
  DistillValidationError,
  normalizeClaim,
  type DistillClaim,
} from "../../../core/brain/distill/distill-source.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

const USAGE =
  "usage: o2b brain distill <source> (--claims <json> | --claims-file <path>) [--vault <path>] [--json]";

/** Parse and structurally validate the claims JSON into DistillClaim[]. */
function parseClaims(raw: string): DistillClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("claims must be valid JSON");
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { claims?: unknown }).claims)
      ? (parsed as { claims: unknown[] }).claims
      : null;
  if (arr === null) {
    throw new Error("claims must be a JSON array of { text, block? } objects");
  }
  return arr.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`claim ${i} must be an object with a text field`);
    }
    return normalizeClaim(item as Record<string, unknown>);
  });
}

export async function cmdBrainDistill(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    claims: { type: "string" },
    "claims-file": { type: "string" },
    json: { type: "boolean" },
  });
  const source = positional[0];
  // Usage errors exit 2 (the command's documented contract), distinct from the
  // operational exit 1 the catch below returns.
  if (!source) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (typeof flags["claims"] !== "string" && typeof flags["claims-file"] !== "string") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const { config, vault } = brainVerbContext(flags);
    // Read the claims source inside the try so a missing --claims-file is a
    // clean error, not an uncaught throw.
    const claimsRaw =
      typeof flags["claims"] === "string"
        ? (flags["claims"] as string)
        : readFileSync(flags["claims-file"] as string, "utf8");
    const claims = parseClaims(claimsRaw);
    const res = distillSource(
      vault,
      { sourcePath: source, claims },
      { agent: resolveBrainAgent(flags, config), now: new Date() },
    );
    if (flags["json"]) {
      okJson({
        distillation_path: res.distillationPath,
        created: res.created,
        claim_count: res.claimCount,
        source_hash: res.sourceHash,
      });
      return 0;
    }
    ok(
      `distilled ${res.claimCount} claim(s) -> ${res.distillationPath}${res.created ? "" : " (updated)"}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof DistillValidationError) {
      return fail(`distill: ${err.message}`);
    }
    return fail(`distill failed: ${(err as Error).message ?? err}`);
  }
}
