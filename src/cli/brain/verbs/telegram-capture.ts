/**
 * `o2b brain telegram-capture <run|catchup>` (Knowledge intake suite,
 * t_f8f5ef6a): the explicit runner verb for the inbound Telegram capture
 * bot plus a disk-only catchup renderer.
 *
 *   - `run`     resolves the bot token (a typed error when absent), builds
 *               the real fetch transport, and long-polls getUpdates until
 *               interrupted. Never invoked from a hook; nothing runs
 *               implicitly.
 *   - `catchup` renders the captures since the last acknowledged one and
 *               advances the watermark. Reads only from disk, so it needs
 *               neither a token nor the network.
 */

import { resolveTelegramBotToken, resolveTelegramCaptureAllowlist } from "../../../core/config.ts";
import {
  createFetchTelegramTransport,
  renderCatchup,
  requireTelegramToken,
  runTelegramCapture,
} from "../../../core/brain/capture/telegram-capture.ts";
import { brainVerbContext, fail, ok, parse, resolveBrainAgent, usageError } from "../helpers.ts";

const ACTIONS = ["run", "catchup"] as const;

export async function cmdBrainTelegramCapture(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action === undefined || !ACTIONS.includes(action as (typeof ACTIONS)[number])) {
    return usageError("usage: o2b brain telegram-capture <run|catchup> [--vault PATH]");
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    agent: { type: "string" },
  });
  const { config, vault } = brainVerbContext(flags);

  if (action === "catchup") {
    ok(renderCatchup(vault));
    return 0;
  }

  // action === "run"
  let token: string;
  try {
    token = requireTelegramToken(resolveTelegramBotToken(config));
  } catch (err) {
    return fail((err as Error).message);
  }
  const allowlist = new Set(resolveTelegramCaptureAllowlist(config));
  const agent = resolveBrainAgent(flags, config);
  const transport = createFetchTelegramTransport(token);

  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runTelegramCapture(vault, {
      transport,
      allowlist,
      agent,
      now: () => new Date(),
      shouldStop: () => stop,
    });
    ok(
      `telegram-capture: handled ${result.decisions.length} update(s) over ${result.cycles} cycle(s)`,
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
