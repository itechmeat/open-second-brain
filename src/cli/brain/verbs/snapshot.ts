import {
  listSnapshots,
  extractSnapshotToTemp,
  type ExtractSnapshotResult,
} from "../../../core/brain/snapshot.ts";
import { diffBrainTrees } from "../../../core/brain/snapshot-diff.ts";
import { renderDiffJson, renderDiffMarkdown } from "../../../core/brain/snapshot-diff-render.ts";
import { brainDirs } from "../../../core/brain/paths.ts";
import { defaultConfigPath } from "../../../core/config.ts";
import { parse, fail, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSnapshotDiff(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  if (positional.length < 1 || positional.length > 2) {
    return fail(
      "brain snapshot diff requires <run_id_a> [<run_id_b>] (with one arg, the live tree is compared as B)",
    );
  }
  const [a, b] = positional;
  const snaps = listSnapshots(vault);
  if (!snaps.some((s) => s.run_id === a)) {
    process.stderr.write(
      `snapshot not found: ${a}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }
  if (b !== undefined && !snaps.some((s) => s.run_id === b)) {
    process.stderr.write(
      `snapshot not found: ${b}; run \`o2b brain rollback --list\` to enumerate.\n`,
    );
    return 2;
  }

  let extA: ExtractSnapshotResult | null = null;
  let extB: ExtractSnapshotResult | null = null;
  try {
    extA = extractSnapshotToTemp(vault, a!);
    const bRoot =
      b !== undefined ? (extB = extractSnapshotToTemp(vault, b)).brainRoot : brainDirs(vault).brain;
    const diff = diffBrainTrees(extA.brainRoot, bRoot);
    const out = flags["json"]
      ? JSON.stringify(renderDiffJson(diff), null, 2) + "\n"
      : renderDiffMarkdown(diff, { aLabel: a!, bLabel: b ?? "live" });
    process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
    return 0;
  } catch (exc) {
    return fail(`snapshot diff failed: ${(exc as Error).message ?? exc}`);
  } finally {
    extA?.cleanup();
    extB?.cleanup();
  }
}

export async function handleBrainSnapshotSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      "usage: o2b brain snapshot <verb> [args...]\n" +
        "Verbs:\n" +
        "  diff <run_id_a> [<run_id_b>]   Read-only diff between two snapshots,\n" +
        "                                  or between a snapshot and live Brain/.\n",
    );
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0]!;
  const rest = argv.slice(1);
  switch (sub) {
    case "diff":
      return await cmdBrainSnapshotDiff([...rest]);
    default:
      process.stderr.write(`unknown brain snapshot verb: ${sub}; supported: diff\n`);
      return 2;
  }
}
