import { defaultConfigPath } from "../../../core/config.ts";
import { renderDigest, type RenderDigestOptions } from "../../../core/brain/digest.ts";
import { parse, fail, resolveBrainVault, ISO_8601_RE } from "../helpers.ts";

export async function cmdBrainDigest(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    json: { type: "boolean" },
    "silent-if-empty": { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  let sinceDate: Date | undefined;
  if (flags["since"]) {
    const raw = String(flags["since"]);
    if (!ISO_8601_RE.test(raw)) return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return fail(`--since must be a valid ISO-8601 timestamp; got ${raw}`);
    sinceDate = d;
  }
  let untilDate: Date | undefined;
  if (flags["until"]) {
    const raw = String(flags["until"]);
    if (!ISO_8601_RE.test(raw)) return fail(`--until must be a valid ISO-8601 timestamp; got ${raw}`);
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return fail(`--until must be a valid ISO-8601 timestamp; got ${raw}`);
    untilDate = d;
  }
  const opts: RenderDigestOptions = {
    ...(sinceDate ? { since: sinceDate } : {}),
    ...(untilDate ? { until: untilDate } : {}),
    format: flags["json"] ? "json" : "markdown",
  };

  let result;
  try {
    result = renderDigest(vault, opts);
  } catch (exc) {
    return fail(`digest failed: ${(exc as Error).message ?? exc}`);
  }

  if (result.empty && flags["silent-if-empty"]) return 2;
  process.stdout.write(result.content);
  if (!result.content.endsWith("\n")) process.stdout.write("\n");
  return 0;
}
