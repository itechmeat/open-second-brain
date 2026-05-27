import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { setPinned } from "../../../core/brain/pin.ts";
import { BrainPreferenceNotFoundError } from "../../../core/brain/apply-evidence.ts";
import { parse, fail, normalizeFlagString, ok, okJson, resolveBrainVault } from "../helpers.ts";

async function pinOrUnpin(argv: string[], value: boolean): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    id: { type: "string" },
    json: { type: "boolean" },
  });
  // Normalise once so `setPinned` and the slug rendering both see the
  // same trimmed value — passing an untrimmed `"  pref-foo  "` into
  // `setPinned` previously failed deep inside path resolution.
  const id = normalizeFlagString(flags["id"]);
  if (id === null) {
    return fail(`brain ${value ? "pin" : "unpin"} missing required flag: --id`);
  }
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = resolveAgentName(config);

  try {
    const out = setPinned(vault, id, value, { agent });
    const slug = id.replace(/^pref-/, "");
    const label = value ? "pinned" : "unpinned";
    const idemLabel = value ? "already pinned" : "already unpinned";
    if (flags["json"]) {
      okJson({ id: `pref-${slug}`, changed: out.changed, pinned: value });
    } else if (out.changed) {
      ok(`${label}: pref-${slug}`);
    } else {
      ok(`${idemLabel}: pref-${slug}`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    return fail(`${value ? "pin" : "unpin"} failed: ${(exc as Error).message ?? exc}`);
  }
}

export async function cmdBrainPin(argv: string[]): Promise<number> {
  return pinOrUnpin(argv, true);
}
export async function cmdBrainUnpin(argv: string[]): Promise<number> {
  return pinOrUnpin(argv, false);
}
