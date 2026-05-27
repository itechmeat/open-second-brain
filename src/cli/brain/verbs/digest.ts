import { defaultConfigPath } from "../../../core/config.ts";
import { renderDigest, type RenderDigestOptions } from "../../../core/brain/digest.ts";
import { parse, fail, resolveBrainVault, parseOptionalIsoDate } from "../helpers.ts";

export function parseWindow(raw: string): number {
  const m = /^(\d+)(?:d)?$/.exec(raw);
  if (!m) throw new Error(`invalid --window value: ${raw} (expected Nd or N, e.g. 7d)`);
  const n = parseInt(m[1]!, 10);
  if (n <= 0) throw new Error(`invalid --window value: ${raw} (must be positive)`);
  return n;
}

export async function cmdBrainDigest(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    window: { type: "string" },
    json: { type: "boolean" },
    "silent-if-empty": { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const { value: parsedSinceDate, error: sinceErr } = parseOptionalIsoDate(flags, "since");
  if (sinceErr) return fail(sinceErr);
  let sinceDate = parsedSinceDate;
  const { value: untilDate, error: untilErr } = parseOptionalIsoDate(flags, "until");
  if (untilErr) return fail(untilErr);
  if (flags["window"]) {
    if (flags["since"]) {
      return fail("--since and --window are mutually exclusive");
    }
    let windowDays: number;
    try {
      windowDays = parseWindow(String(flags["window"]));
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      return 2;
    }
    const until = untilDate ?? new Date();
    sinceDate = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);
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
