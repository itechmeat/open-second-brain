import { defaultConfigPath } from "../../../core/config.ts";
import { planUpgrade, applyUpgrade, BrainUpgradeError, type UpgradePlan } from "../../../core/brain/upgrade.ts";
import { parse, fail, ok, okJson, resolveBrainVault, printUpgradePlanText, renderUpgradePlanJson, readSingleLine } from "../helpers.ts";

export async function cmdBrainUpgrade(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    check: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  if (flags["dry-run"] && flags["apply"]) return fail("brain upgrade: --dry-run and --apply are mutually exclusive");
  if (flags["check"] && flags["apply"]) return fail("brain upgrade: --check and --apply are mutually exclusive");

  let plan: UpgradePlan;
  try { plan = planUpgrade(vault); }
  catch (exc) { return fail(`upgrade plan failed: ${(exc as Error).message ?? exc}`); }

  if (flags["check"]) {
    if (flags["json"]) { okJson(renderUpgradePlanJson(plan)); }
    else { printUpgradePlanText(plan); }
    return plan.pending > 0 || plan.errors > 0 ? 2 : 0;
  }

  if (!flags["apply"]) {
    if (flags["json"]) { okJson(renderUpgradePlanJson(plan)); }
    else { printUpgradePlanText(plan); }
    return 0;
  }

  if (plan.errors > 0) return fail(`upgrade aborted: ${plan.errors} file(s) failed to plan; run with --dry-run to inspect the error.`);
  if (plan.pending === 0) {
    if (flags["json"]) { okJson({ run_id: "", snapshot_path: "", files_updated: [] }); }
    else { ok("upgrade: nothing to do; all managed files match the current release."); }
    return 0;
  }
  if (!flags["yes"]) {
    if (flags["json"] || !process.stdin.isTTY) return fail("brain upgrade --apply requires --yes in non-interactive mode (--json or non-TTY stdin)");
    process.stderr.write(
      `About to rewrite ${plan.pending} managed file(s):\n` +
        plan.files.filter((f) => f.status === "update").map((f) => `  - ${f.path}\n`).join("") +
        `A pre-apply snapshot will be taken (rollback via run id).\nProceed? [y/N] `,
    );
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") { ok("upgrade cancelled"); return 0; }
  }

  let result;
  try { result = applyUpgrade(vault, { now: new Date() }); }
  catch (exc) {
    if (exc instanceof BrainUpgradeError) { process.stderr.write(`error: ${exc.message}\n`); return 1; }
    return fail(`upgrade failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) { okJson({ run_id: result.run_id, snapshot_path: result.snapshot_path, files_updated: result.files_updated }); }
  else {
    ok(`run_id: ${result.run_id}`);
    ok(`snapshot: ${result.snapshot_path}`);
    for (const p of result.files_updated) ok(`  updated: ${p}`);
  }
  return 0;
}
