import {
  planUpgrade,
  applyUpgrade,
  BrainUpgradeError,
  type UpgradePlan,
} from "../../../core/brain/upgrade.ts";
import {
  brainVerbContext,
  describeErrorChain,
  fail,
  ok,
  okJson,
  parse,
  printUpgradePlanText,
  readSingleLine,
  renderUpgradePlanJson,
} from "../helpers.ts";
import { info } from "../../output.ts";
import { runSelfHealUpgrade } from "../../../core/maintenance/self-heal-upgrade.ts";
import {
  clearSelfHealUpgradeFailure,
  describeSelfHealUpgradeFailure,
  readSelfHealUpgradeFailure,
  recordSelfHealUpgradeFailure,
  type SelfHealUpgradeFailure,
} from "../../../core/maintenance/self-heal-upgrade-state.ts";

/** JSON shape of a recorded automatic-upgrade failure. */
function failureJson(failure: SelfHealUpgradeFailure): Record<string, unknown> {
  return {
    failed_at: failure.failedAt,
    error: failure.error,
    consecutive_failures: failure.consecutiveFailures,
    pending: failure.pending,
    retry_after: failure.retryAfter,
  };
}

/** Print the plan, plus the last automatic-upgrade failure when one is recorded. */
function printPlan(plan: UpgradePlan, failure: SelfHealUpgradeFailure | null, json: boolean): void {
  if (json) {
    okJson({
      ...renderUpgradePlanJson(plan),
      self_heal_failure: failure === null ? null : failureJson(failure),
    });
    return;
  }
  printUpgradePlanText(plan);
  if (failure !== null) {
    info(`last automatic upgrade: ${describeSelfHealUpgradeFailure(failure)}`);
  }
}

export async function cmdBrainUpgrade(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
    // The detached worker `ensureVaultCurrent` starts, with the lock claim
    // it was handed. Not an operator flag: the worker's outcome is
    // recorded, never printed (its streams are ignored).
    "self-heal": { type: "string" },
  });
  const { vault } = brainVerbContext(flags);

  const selfHealToken = flags["self-heal"] as string | undefined;
  if (selfHealToken !== undefined) {
    runSelfHealUpgrade(vault, { lockToken: selfHealToken });
    return 0;
  }

  if (flags["dry-run"] && flags["apply"])
    return fail("brain upgrade: --dry-run and --apply are mutually exclusive");
  if (flags["check"] && flags["apply"])
    return fail("brain upgrade: --check and --apply are mutually exclusive");

  let plan: UpgradePlan;
  try {
    plan = planUpgrade(vault);
  } catch (exc) {
    return fail(`upgrade plan failed: ${(exc as Error).message ?? exc}`);
  }

  const failure = readSelfHealUpgradeFailure(vault);

  if (flags["check"]) {
    printPlan(plan, failure, Boolean(flags["json"]));
    return plan.pending > 0 || plan.errors > 0 ? 2 : 0;
  }

  if (!flags["apply"]) {
    printPlan(plan, failure, Boolean(flags["json"]));
    return 0;
  }

  if (plan.errors > 0)
    return fail(
      `upgrade aborted: ${plan.errors} file(s) failed to plan; run with --dry-run to inspect the error.`,
    );
  if (plan.pending === 0) {
    // Nothing left for the automatic upgrade to retry either.
    clearSelfHealUpgradeFailure(vault);
    if (flags["json"]) {
      okJson({ run_id: "", snapshot_path: "", files_updated: [] });
    } else {
      ok("upgrade: nothing to do; all managed files match the current release.");
    }
    return 0;
  }
  if (!flags["yes"]) {
    if (flags["json"] || !process.stdin.isTTY)
      return fail(
        "brain upgrade --apply requires --yes in non-interactive mode (--json or non-TTY stdin)",
      );
    process.stderr.write(
      `About to rewrite ${plan.pending} managed file(s):\n` +
        plan.files
          .filter((f) => f.status === "update")
          .map((f) => `  - ${f.path}\n`)
          .join("") +
        `A pre-apply snapshot will be taken (rollback via run id).\nProceed? [y/N] `,
    );
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      ok("upgrade cancelled");
      return 0;
    }
  }

  let result;
  const now = new Date();
  try {
    // The plan computed (and, interactively, confirmed) above, not a
    // re-plan: a file that changed since it was read is refused by name
    // instead of overwritten.
    result = applyUpgrade(vault, { plan, now });
  } catch (exc) {
    // Recorded as the automatic path records it, so `o2b doctor` shows
    // the latest failure and the automatic retry waits its cooldown.
    try {
      recordSelfHealUpgradeFailure(
        vault,
        (exc as Error).message ?? String(exc),
        plan.files.filter((f) => f.status === "update").map((f) => f.path),
        now,
      );
    } catch {
      // The error below is what the operator acts on.
    }
    if (exc instanceof BrainUpgradeError) {
      if (flags["json"]) {
        // `drifted` names each refused file, so a script can tell a drift
        // from any other failure without parsing the message.
        okJson({ ok: false, error: exc.message, run_id: exc.runId, drifted: [...exc.drifted] });
      } else {
        process.stderr.write(`error: ${exc.message}\n`);
      }
      return 1;
    }
    return fail(`upgrade failed: ${describeErrorChain(exc)}`);
  }

  clearSelfHealUpgradeFailure(vault);
  if (flags["json"]) {
    okJson({
      run_id: result.run_id,
      snapshot_path: result.snapshot_path,
      files_updated: result.files_updated,
    });
  } else {
    ok(`run_id: ${result.run_id}`);
    ok(`snapshot: ${result.snapshot_path}`);
    for (const p of result.files_updated) ok(`  updated: ${p}`);
  }
  return 0;
}
