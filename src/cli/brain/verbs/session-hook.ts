import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { captureSessionLifecycleEvent } from "../../../core/brain/session-lifecycle.ts";
import { readHookInput } from "../../../../hooks/lib/stdin.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainSessionHook(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  let payload: unknown;
  try {
    payload = await readHookInput();
  } catch (err) {
    return fail(`session-hook failed to read stdin: ${(err as Error).message ?? err}`);
  }

  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
    const agent = typeof flags["agent"] === "string" ? flags["agent"] : resolveAgentName(config);
    const result = await captureSessionLifecycleEvent(vault, payload, {
      agent,
      dryRun: Boolean(flags["dry-run"]),
    });
    if (flags["json"]) okJson({ ...result });
    else
      ok(
        `session-hook: ${result.event} created=${result.signals_created} deduped=${result.signals_deduped}`,
      );
    return 0;
  } catch (err) {
    return fail(`session-hook failed: ${(err as Error).message ?? err}`);
  }
}
