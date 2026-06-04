import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { mergePreferences, BrainMergeError } from "../../../core/brain/merge.ts";
import { parse, fail, ok, okJson, resolveBrainVault, readSingleLine } from "../helpers.ts";

export async function cmdBrainMerge(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length !== 2)
    return fail("brain merge requires exactly two positional ids: <keep-pref-id> <drop-pref-id>");
  const [keepId, dropId] = positional as [string, string];
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);
  const dryRun = flags["dry-run"] === true;
  const force = flags["force"] === true;
  const wantJson = flags["json"] === true;

  let plan;
  try {
    plan = mergePreferences(vault, keepId, dropId, {
      now: new Date(),
      agentName: agent,
      dryRun: true,
      bypassEntityGuard: force,
    });
  } catch (exc) {
    if (exc instanceof BrainMergeError) return fail(`brain merge: ${exc.message}`);
    return fail(`brain merge: failed to plan merge: ${(exc as Error).message ?? exc}`);
  }

  const planLines = [
    `merge plan:`,
    `  keep: ${plan.keep_id}`,
    `  drop: ${plan.drop_id} → ${plan.retired_path}`,
    `  topic: ${plan.topic}${plan.scope ? `, scope: ${plan.scope}` : ""}`,
    `  evidenced_by union: ${plan.merged_evidenced_by.length}`,
    `  applied_sum: ${plan.applied_sum}`,
    `  violated_sum: ${plan.violated_sum}`,
    `  last_evidence_at: ${plan.last_evidence_at ?? "—"}`,
  ];

  if (dryRun) {
    if (wantJson) {
      okJson({ dry_run: true, plan });
    } else {
      for (const line of planLines) ok(line);
      ok("dry-run; no changes written");
    }
    return 0;
  }

  if (!force) {
    if (wantJson)
      return fail(
        "brain merge: --json without --force is not supported (interactive prompt cannot render)",
      );
    if (!process.stdin.isTTY)
      return fail(
        "brain merge: --force required when stdin is not a TTY (cannot prompt for confirmation)",
      );
    for (const line of planLines) process.stderr.write(line + "\n");
    process.stderr.write("Proceed? [y/N] ");
    const ans = (await readSingleLine()).toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      ok("merge cancelled");
      return 0;
    }
  }

  try {
    mergePreferences(vault, keepId, dropId, {
      now: new Date(),
      agentName: agent,
      bypassEntityGuard: force,
    });
  } catch (exc) {
    if (exc instanceof BrainMergeError) return fail(`brain merge: ${exc.message}`);
    return fail(`brain merge: failed to commit merge: ${(exc as Error).message ?? exc}`);
  }

  if (wantJson) {
    okJson({ merged: true, plan });
  } else {
    ok(`merged: ${plan.drop_id} → ${plan.keep_id} (retired as merged-into)`);
  }
  return 0;
}
