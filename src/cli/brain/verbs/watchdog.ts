import { defaultConfigPath } from "../../../core/config.ts";
import { runBrainWatchdog } from "../../../core/brain/watchdog.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainWatchdog(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    remediate: { type: "boolean" },
    "dry-run": { type: "boolean" },
    restore: { type: "string" },
    "force-restore": { type: "boolean" },
    attempt: { type: "string", default: "0" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  try {
    const rawAttempt = flags["attempt"] as string;
    if (!/^\d+$/.test(rawAttempt)) return fail("--attempt must be a non-negative integer");
    const attempt = Number(rawAttempt);
    if (!Number.isSafeInteger(attempt)) return fail("--attempt must be a non-negative integer");
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const result = runBrainWatchdog(vault, {
      remediate: Boolean(flags["remediate"]),
      dryRun: Boolean(flags["dry-run"]),
      restoreRunId: flags["restore"] as string | undefined,
      forceRestore: Boolean(flags["force-restore"]),
      attempt,
    });
    if (flags["json"]) okJson({ ...result });
    else ok(renderWatchdogText(result));
    return result.restore.refused ? 2 : 0;
  } catch (err) {
    return fail(`watchdog failed: ${(err as Error).message ?? err}`);
  }
}

function renderWatchdogText(result: ReturnType<typeof runBrainWatchdog>): string {
  const lines = [
    `watchdog: ${result.report.ok ? "ok" : "degraded"}`,
    `checks: ok=${result.report.counts.ok} warning=${result.report.counts.warning} critical=${result.report.counts.critical}`,
  ];
  for (const check of result.report.checks)
    lines.push(`${check.status}: ${check.name} - ${check.message}`);
  if (result.remediation_plan.length > 0) {
    lines.push("remediation:");
    for (const item of result.remediation_plan) {
      lines.push(`- ${item.action} ${item.target ?? item.command ?? ""}`.trim());
    }
  }
  return lines.join("\n");
}
