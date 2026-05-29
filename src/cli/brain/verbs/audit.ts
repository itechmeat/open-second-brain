import { defaultConfigPath } from "../../../core/config.ts";
import { readPrefAudit, renderPrefAudit } from "../../../core/brain/pref-audit.ts";
import { fail, parse, resolveBrainVault } from "../helpers.ts";

/**
 * `o2b brain audit <pref-id>` - render a preference's full mutation
 * audit trail (create / promote / update / retire / merge). The trail
 * is keyed by the original `pref-<slug>` id, so a `ret-<slug>` or bare
 * `<slug>` argument is normalised to the same file. Read-only.
 */
export async function cmdBrainAudit(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const raw = positional[0];
  if (!raw) return fail("usage: o2b brain audit <pref-id>");
  const slug = raw.replace(/^(?:pref-|ret-)/, "").trim();
  if (slug.length === 0) {
    return fail(`audit: empty preference slug after stripping prefix from '${raw}'`);
  }
  const prefId = `pref-${slug}`;

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let result;
  try {
    result = readPrefAudit(vault, prefId);
  } catch (exc) {
    return fail(`audit failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ pref_id: prefId, ...result }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(renderPrefAudit(prefId, result.records) + "\n");
  }
  return 0;
}
