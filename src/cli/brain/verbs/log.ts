import { breakDetail, verifyLogChain } from "../../../core/brain/log-chain.ts";
import { brainDirs } from "../../../core/brain/paths.ts";
import { brainVerbContext, fail, info, parse, writeJson } from "../helpers.ts";

/**
 * `o2b brain log <verb>` (who-wrote-what, Task E) - the operator surface
 * over `Brain/log/` itself, as opposed to over what it records.
 *
 * `verify` is the only verb today and the reason the namespace exists:
 * the per-shard hash chain is report-only, so nothing surfaces a shard
 * that stopped linking up until someone asks. The doctor asks on every
 * run; this is the surface for an operator who suspects something and
 * wants the whole picture, shard by shard.
 *
 * The name is RESERVED rather than collapsed into a single `log-verify`
 * verb: the log is a subsystem with more than one question worth asking
 * of it, and an unknown subcommand is refused by name here rather than
 * being read as a flag or silently ignored.
 */
const LOG_VERBS = Object.freeze({ verify: "verify" } as const);

/** Printed for `o2b brain log` with no verb, and for `--help`. */
const LOG_USAGE =
  "usage: o2b brain log <verb> [args...]\n" +
  "Verbs:\n" +
  "  verify [--json]   Walk every JSONL shard of the Brain log and report\n" +
  "                    where each one stops linking up: shard path, line\n" +
  "                    number, and whether the line was edited, removed or\n" +
  "                    stripped of its chain fields. Reports only - nothing\n" +
  "                    here rewrites a log to make it verify.\n";

export async function handleBrainLogSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(LOG_USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0]!;
  const rest = argv.slice(1);
  switch (sub) {
    case LOG_VERBS.verify:
      return await cmdBrainLogVerify([...rest]);
    default:
      process.stderr.write(
        `unknown brain log verb: ${sub}; supported: ${Object.values(LOG_VERBS).join(", ")}\n`,
      );
      return 2;
  }
}

/**
 * Walk every chained shard and print the verdict.
 *
 * Exit 1 when the log does not verify. A check whose failure looks like
 * its success is not a check, and this one is meant to be runnable from
 * a cron entry that only reports when something is wrong. Exit 0 with an
 * explicit line for a vault with no chained shard at all: "there is
 * nothing to verify" is an answer, and printing nothing would make it
 * indistinguishable from "everything verified".
 */
export async function cmdBrainLogVerify(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  let result;
  try {
    result = verifyLogChain(vault);
  } catch (exc) {
    return fail(`log verify failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    writeJson({
      ok: result.ok,
      shards: result.shards.map((shard) => ({
        path: shard.path,
        date: shard.date,
        shard_id: shard.shardId,
        chained: shard.chained,
        legacy: shard.legacy,
        unparsed: shard.unparsed,
        first_break:
          shard.firstBreak === null
            ? null
            : { line: shard.firstBreak.line, reason: shard.firstBreak.reason },
      })),
      notices: result.notices.map((notice) => ({
        code: notice.code,
        site: notice.site,
        ...(notice.path !== undefined ? { path: notice.path } : {}),
        detail: notice.detail,
      })),
    });
    return result.ok ? 0 : 1;
  }

  if (result.shards.length === 0) {
    info(`no chained log shard under ${brainDirs(vault).log}: nothing to verify`);
    // Still a finding when the directory itself could not be listed.
    for (const notice of result.notices) info(`  ${notice.detail}`);
    return result.ok ? 0 : 1;
  }

  const chained = result.shards.reduce((sum, shard) => sum + shard.chained, 0);
  const legacy = result.shards.reduce((sum, shard) => sum + shard.legacy, 0);
  const broken = result.shards.filter((shard) => shard.firstBreak !== null);
  info(
    `${plural(result.shards.length, "shard")}, ${chained} chained ` +
      `${plural(chained, "line", false)}, ${legacy} legacy`,
  );

  for (const shard of broken) {
    const found = shard.firstBreak!;
    info(`${shard.path}: line ${found.line} (${found.reason}) - it ${breakDetail(found.reason)}`);
  }
  if (broken.length === 0) {
    info("every shard links up");
    return 0;
  }
  info(
    `${plural(broken.length, "shard")} of ${result.shards.length} did not link up. ` +
      "Nothing here rewrites a log to make it verify: the line named above was edited, " +
      "removed, or stripped of its chain fields after it was written, and that is what " +
      "the chain exists to say. Every event in those shards still reads.",
  );
  return 1;
}

/** `1 shard` / `2 shards`, with the count kept in front for scanning. */
function plural(count: number, noun: string, withCount = true): string {
  const word = count === 1 ? noun : `${noun}s`;
  return withCount ? `${count} ${word}` : word;
}
