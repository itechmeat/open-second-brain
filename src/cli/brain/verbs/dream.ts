import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { dream } from "../../../core/brain/dream.ts";
import {
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SafeguardTimeoutError,
} from "../../../core/brain/safeguard.ts";
import { parse, fail, ok, resolveBrainVault, parseOptionalIsoDate } from "../helpers.ts";

export async function cmdBrainDream(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    now: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  const agentFlag = flags["agent"];
  let agent: string;
  if (typeof agentFlag === "string") {
    const trimmed = agentFlag.trim();
    if (trimmed.length === 0) {
      return fail("brain dream: --agent must be a non-empty string when provided");
    }
    agent = trimmed;
  } else {
    agent = resolveAgentName(config);
  }

  const { value: now, error: nowErr } = parseOptionalIsoDate(flags, "now");
  if (nowErr) return fail(nowErr);

  let summary;
  try {
    summary = dream(vault, {
      ...(now !== null ? { now } : {}),
      dryRun: Boolean(flags["dry-run"]),
      ...(agent ? { agentName: agent } : {}),
      safeguard: createSafeguard({
        operation: "dream",
        timeoutMs: resolveSafeguardTimeoutMs("dream", config ?? undefined),
      }),
    });
  } catch (exc) {
    if (exc instanceof SafeguardTimeoutError && flags["json"]) {
      process.stdout.write(
        JSON.stringify({ ok: false, timed_out: true, message: exc.message }) + "\n",
      );
      return 1;
    }
    return fail(`dream failed: ${(exc as Error).message ?? exc}`);
  }

  for (const w of summary.warnings ?? []) {
    process.stderr.write(`warning: ${w.code}: ${w.message}\n`);
  }

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  ok(`run_id: ${summary.run_id}`);
  ok(`changed: ${summary.changed}`);
  if (summary.new_unconfirmed.length > 0)
    ok(`new_unconfirmed: ${summary.new_unconfirmed.join(", ")}`);
  if (summary.confirmed.length > 0) ok(`confirmed: ${summary.confirmed.join(", ")}`);
  if (summary.retired.length > 0)
    ok(`retired: ${summary.retired.map((r) => `${r.id} (${r.reason})`).join(", ")}`);
  if (summary.contradictions.length > 0) ok(`contradictions: ${summary.contradictions.join(", ")}`);
  if (summary.moved_to_processed.length > 0)
    ok(`moved_to_processed: ${summary.moved_to_processed.length}`);
  return 0;
}
