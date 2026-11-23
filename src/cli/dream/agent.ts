/**
 * `o2b dream agent` (change `dream-launched-agent`, design D5): the
 * command that starts the dream agent on this machine.
 *
 *  - `agent [show] [--json]`: the command (a preset name or `custom`),
 *    its fallbacks, whether it was verified and when, the last run;
 *  - `agent set <preset | JSON array> [--fallback <preset | JSON array> ...]`:
 *    write the machine config keys `dream_agent_command` and
 *    `dream_agent_fallbacks`;
 *  - `agent check [--command <preset | JSON array>] [--json]`: start a
 *    real short session against two canary items in a throwaway store and
 *    record the command as verified when it answered both and finished.
 */

import {
  defaultConfigPath,
  discoverConfig,
  setConfigJsonValue,
  setConfigValue,
} from "../../core/config.ts";
import {
  DREAM_AGENT_COMMAND_KEY,
  DREAM_AGENT_FALLBACKS_KEY,
  parseDreamAgentCommand,
  resolveDreamAgentConfig,
  type DreamAgentCommand,
} from "../../core/brain/dream-queue/agent-config.ts";
import { checkDreamAgent } from "../../core/brain/dream-queue/agent-check.ts";
import { dreamAgentPresetNames } from "../../core/brain/dream-queue/agent-presets.ts";
import {
  dreamAgentVerification,
  readDreamAgentLastRun,
} from "../../core/brain/dream-queue/agent-verified.ts";
import { CliError, parseFlags } from "../argparse.ts";
import { sortedReplacer } from "../helpers.ts";

export const DREAM_AGENT_USAGE = [
  "usage: o2b dream agent [show] [--config <file>] [--json]",
  "       o2b dream agent set <preset | JSON array> [--fallback <preset | JSON array> ...] [--config <file>]",
  "       o2b dream agent check [--command <preset | JSON array>] [--config <file>] [--json]",
].join("\n");

const EXIT = Object.freeze({ ok: 0, failed: 1 } as const);

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, sortedReplacer, 2)}\n`);
}

function describe(command: DreamAgentCommand): string {
  return command.preset ?? JSON.stringify([command.program, ...command.args]);
}

export async function cmdAgent(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    command: { type: "string" },
    fallback: { type: "string-array" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  const configPath = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const json = flags["json"] === true;
  const verb = positional[0] ?? "show";
  if (verb === "show") {
    if (positional.length > 1) throw new CliError(`unexpected argument: ${positional[1]}`);
    return show(configPath, json);
  }
  if (verb === "set") {
    const raw = positional[1];
    if (raw === undefined) throw new CliError("agent set needs a preset name or a JSON array");
    if (positional.length > 2) throw new CliError(`unexpected argument: ${positional[2]}`);
    return set(configPath, raw, (flags["fallback"] as string[] | undefined) ?? []);
  }
  if (verb === "check") {
    if (positional.length > 1) throw new CliError(`unexpected argument: ${positional[1]}`);
    return await check(configPath, flags["command"] as string | undefined, json);
  }
  throw new CliError(`unknown agent verb: ${verb}`);
}

function show(configPath: string, json: boolean): number {
  const cfg = resolveDreamAgentConfig({
    config: discoverConfig(configPath).data,
    env: process.env,
  });
  const verification = cfg.command === null ? null : dreamAgentVerification(cfg.command);
  const last = readDreamAgentLastRun();
  if (json) {
    writeJson({
      command:
        cfg.command === null
          ? null
          : { label: cfg.command.label, program: cfg.command.program, args: cfg.command.args },
      fallbacks: cfg.fallbacks.map((c) => ({ label: c.label, program: c.program, args: c.args })),
      verified: verification,
      last_run: last,
      presets: dreamAgentPresetNames(),
      errors: cfg.errors,
    });
    return EXIT.ok;
  }
  const lines: string[] = [];
  if (cfg.command === null) {
    lines.push(
      "dream agent: not set",
      `  set one with \`o2b dream agent set <preset | JSON array>\``,
    );
  } else {
    lines.push(`dream agent: ${describe(cfg.command)}`);
    for (const f of cfg.fallbacks) lines.push(`  fallback: ${describe(f)}`);
    lines.push(
      verification === null
        ? "  not verified: run `o2b dream agent check`"
        : `  verified ${verification.verified_at} (model ${verification.model})`,
    );
  }
  if (last !== null) {
    lines.push(
      `last run: ${last.at} ${last.status}` +
        (last.status === "ran"
          ? ` by ${last.agent}, ${last.answered} answered, ${last.ended}`
          : ""),
    );
  }
  for (const e of cfg.errors) lines.push(`error: ${e}`);
  const presets = dreamAgentPresetNames();
  lines.push(`presets: ${presets.length === 0 ? "none" : presets.join(", ")}`);
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT.ok;
}

function parseOrThrow(raw: string, key: string): DreamAgentCommand {
  const errors: string[] = [];
  const command = parseDreamAgentCommand(raw, key, errors);
  if (command === null) throw new CliError(errors[0] ?? `${key} is invalid`);
  return command;
}

function set(configPath: string, raw: string, fallbacks: ReadonlyArray<string>): number {
  const command = parseOrThrow(raw, DREAM_AGENT_COMMAND_KEY);
  const parsedFallbacks = fallbacks.map((f) => parseOrThrow(f, DREAM_AGENT_FALLBACKS_KEY));
  if (command.preset !== null) setConfigValue(DREAM_AGENT_COMMAND_KEY, command.preset, configPath);
  else setConfigJsonValue(DREAM_AGENT_COMMAND_KEY, [command.program, ...command.args], configPath);
  if (parsedFallbacks.length > 0) {
    setConfigJsonValue(
      DREAM_AGENT_FALLBACKS_KEY,
      parsedFallbacks.map((c) => c.preset ?? [c.program, ...c.args]),
      configPath,
    );
  }
  process.stdout.write(
    `dream agent set: ${describe(command)}\n  not verified yet: it is used only after the agent check passes\n`,
  );
  return EXIT.ok;
}

async function check(configPath: string, raw: string | undefined, json: boolean): Promise<number> {
  let command: DreamAgentCommand | null;
  if (raw !== undefined) command = parseOrThrow(raw, "--command");
  else {
    const cfg = resolveDreamAgentConfig({
      config: discoverConfig(configPath).data,
      env: process.env,
    });
    command = cfg.command;
  }
  if (command === null) {
    throw new CliError("no dream agent is set: pass --command or run `o2b dream agent set`");
  }
  const result = await checkDreamAgent(command, { configPath });
  if (json) {
    writeJson(
      result.ok
        ? {
            ok: true,
            agent: result.agent,
            model: result.model,
            program_version: result.programVersion,
          }
        : { ok: false, reason: result.reason, seen: result.seen },
    );
  } else if (result.ok) {
    process.stdout.write(
      `dream agent check: passed\n  agent ${result.agent}, model ${result.model}` +
        (result.programVersion !== null ? `, ${result.programVersion}` : "") +
        "\n  the command is verified\n",
    );
  } else {
    process.stdout.write(
      `dream agent check: failed: ${result.reason}\n${result.seen.map((s) => `  ${s}`).join("\n")}\n`,
    );
  }
  return result.ok ? EXIT.ok : EXIT.failed;
}
