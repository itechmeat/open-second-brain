import { createInterface } from "node:readline/promises";
import { posix, resolve, win32 } from "node:path";

import { configuredVaultKey, defaultConfigPath, discoverConfig } from "../core/config.ts";
import { configuredStore } from "../core/store/read/store-entities.ts";
import { runDoctorSelftest } from "../core/doctor-selftest.ts";
import { buildInstallEnv } from "../core/install/env.ts";
import { assertNotRunnerCache, installOrigin } from "../core/install/origin.ts";
import { HOST_KINDS } from "../core/install/host-kinds.ts";
import { manifestPath } from "../core/install/manifest.ts";
import { defaultRegistry } from "../core/install/registry.ts";
import { buildPayload } from "../core/install/payload.ts";
import { payloadAsWritten } from "../core/install/payload-host.ts";
import { grokMcpServers } from "../core/install/grok-asset.ts";
import { isInstallTargetId } from "../core/runtime/host-facts.ts";
import { resolveConfiguredStoreRoot } from "../core/store/store-paths.ts";
import { hasLegacyTree } from "../core/store/store-only.ts";
import {
  InstallError,
  type ApplyResult,
  type InstallAdapter,
  type InstallEnv,
  type McpPayload,
  type VerifyResult,
} from "../core/install/types.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { INSTALL_EXIT } from "./install/install.ts";
import { cmdInit, runMcpProbe } from "./main.ts";
import { cmdInitInteractive } from "./install/init-interactive.ts";

interface SetupStep {
  readonly name: string;
  readonly outcome: string;
  readonly output?: string;
}

interface SetupReport {
  readonly target: string;
  readonly steps: ReadonlyArray<SetupStep>;
  readonly writtenPaths: ReadonlyArray<string>;
  readonly registeredCommand: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  } | null;
  readonly verification: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly details?: ReadonlyArray<string>;
  }>;
  readonly remainingActions: ReadonlyArray<string>;
}

export async function captureStdout<T>(
  operation: () => T | Promise<T>,
): Promise<{ value: T; output: string }> {
  const original = process.stdout.write;
  const chunks: string[] = [];
  const capture = function (
    this: NodeJS.WriteStream,
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  try {
    const value = await operation();
    return { value, output: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

function usage(message: string, json = false, target = ""): number {
  process.stderr.write(`error: ${message}\n`);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          target,
          steps: [{ name: "validation", outcome: "failed", output: message }],
          writtenPaths: [],
          registeredCommand: null,
          verification: [],
          remainingActions: [],
        },
        null,
        2,
      ) + "\n",
    );
  }
  return INSTALL_EXIT.usage;
}

function payloadFor(target: string, env: InstallEnv): McpPayload {
  return buildPayload({
    vault: env.vault,
    agent_name: env.env["VAULT_AGENT_NAME"] ?? null,
    timezone: env.env["VAULT_TIMEZONE"] ?? null,
    origin: env.origin,
    configPath: env.env["OPEN_SECOND_BRAIN_CONFIG"],
  });
}

export function setupVaultForPayload(
  explicitVault: string | undefined,
  configuredVault: string | null,
  platform: string = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  if (
    explicitVault !== undefined &&
    configuredVault !== null &&
    path.resolve(explicitVault) === path.resolve(configuredVault)
  ) {
    return path.isAbsolute(configuredVault) ? configuredVault : path.resolve(configuredVault);
  }
  return explicitVault !== undefined ? path.resolve(explicitVault) : (configuredVault ?? "");
}

function snippet(payload: McpPayload): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        "open-second-brain": payload.full,
        "open-second-brain-writer": payload.writer,
      },
    },
    null,
    2,
  )}\n`;
}

function verifyCode(result: VerifyResult): number {
  switch (result.status) {
    case "ok":
      return INSTALL_EXIT.ok;
    case "drift":
      return INSTALL_EXIT.drift;
    case "mcp-unreachable":
      return INSTALL_EXIT.mcpUnreachable;
    case "not-installed":
      return INSTALL_EXIT.drift;
  }
}

function pathsFromApply(result: ApplyResult, env: InstallEnv): string[] {
  return [
    ...new Set([
      ...(result.manifest.config_path ? [result.manifest.config_path] : []),
      ...(result.manifest.owned_paths ?? []),
      manifestPath(env.vault),
    ]),
  ];
}

function textReport(report: SetupReport): string {
  const lines = [`Open Second Brain setup for ${report.target}`];
  for (const step of report.steps) {
    lines.push(`${step.name}: ${step.outcome}`);
    if (step.output) lines.push(step.output.trimEnd());
  }
  if (report.registeredCommand) {
    lines.push(
      `registered command: ${report.registeredCommand.command} ${report.registeredCommand.args.join(" ")}`,
    );
  }
  for (const verification of report.verification) {
    lines.push(`verified ${verification.name}: ${verification.status}`);
  }
  for (const path of report.writtenPaths) lines.push(`wrote: ${path}`);
  for (const action of report.remainingActions) lines.push(`remaining: ${action}`);
  return lines.join("\n") + "\n";
}

async function askConsent(): Promise<boolean> {
  const interface_ = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (
      (await interface_.question("Proceed with Open Second Brain setup? [y/N] "))
        .trim()
        .toLowerCase() === "y"
    );
  } finally {
    interface_.close();
  }
}

export async function cmdSetup(argv: string[]): Promise<number> {
  const wantsJson = argv.includes("--json");
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv, {
      target: { type: "string" },
      vault: { type: "string" },
      "no-vault": { type: "boolean" },
      "agent-name": { type: "string" },
      timezone: { type: "string" },
      config: { type: "string" },
      apply: { type: "boolean" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
    });
  } catch (error) {
    return usage(error instanceof CliError ? error.message : String(error), wantsJson);
  }
  const flags = parsed.flags;
  const json = flags["json"] === true;
  if (parsed.positional.length) return usage(`unexpected argument: ${parsed.positional[0]}`, json);
  const target = flags["target"] as string | undefined;
  if (!target) {
    if (process.stdin.isTTY)
      return cmdInitInteractive(flags["config"] ? ["--config", flags["config"] as string] : []);
    return usage("--target is required without an interactive terminal", json);
  }
  const kind = Object.hasOwn(HOST_KINDS, target)
    ? HOST_KINDS[target as keyof typeof HOST_KINDS]
    : undefined;
  if (!kind)
    return usage(
      `unknown --target: ${target}. Available: ${Object.keys(HOST_KINDS).join(", ")}`,
      json,
      target,
    );
  const configPath = resolve((flags["config"] as string | undefined) ?? defaultConfigPath());
  const explicitVault = flags["vault"] as string | undefined;
  const noVault = flags["no-vault"] === true;
  if (explicitVault !== undefined && noVault)
    return usage("--vault and --no-vault cannot be used together", json, target);

  let configuredVault: string | null;
  let config: ReturnType<typeof discoverConfig>;
  try {
    config = discoverConfig(configPath);
    configuredVault = configuredVaultKey(configPath);
    assertNotRunnerCache(installOrigin());
  } catch (error) {
    return usage((error as Error).message, json, target);
  }
  if (
    explicitVault !== undefined &&
    configuredVault &&
    resolve(explicitVault) !== resolve(configuredVault)
  ) {
    return usage(
      `--vault ${explicitVault} contradicts configured vault ${configuredVault}; use o2b init --vault <path> to change it`,
      json,
      target,
    );
  }
  if (noVault && configuredVault)
    return usage(
      `--no-vault contradicts configured vault ${configuredVault}; use o2b init to change it`,
      json,
      target,
    );

  if (target === "aider" && explicitVault === undefined && !configuredVault)
    return usage(
      "Aider reads its context from a file in the vault; pass --vault <path>",
      json,
      target,
    );

  const agentName = flags["agent-name"] as string | undefined;
  const timezone = flags["timezone"] as string | undefined;
  const identityConfigured = Boolean(config.data["agent_name"] && config.data["timezone"]);
  const brainReady =
    configuredStore(configPath) !== null ||
    (configuredVault !== null && hasLegacyTree(configuredVault));
  const machineConfigured = identityConfigured && brainReady;
  if (identityConfigured) {
    if (agentName !== undefined && agentName !== config.data["agent_name"])
      return usage(
        "--agent-name differs from the configured value; use `o2b init --agent-name <name>` to change it",
        json,
        target,
      );
    if (timezone !== undefined && timezone !== config.data["timezone"])
      return usage(
        "--timezone differs from the configured value; use `o2b init --timezone <timezone>` to change it",
        json,
        target,
      );
    if (explicitVault !== undefined && !configuredVault)
      return usage(
        "--vault cannot add a vault to an already configured machine; use `o2b init --vault <path>` to change it",
        json,
        target,
      );
  }
  const missing: string[] = [];
  if (!machineConfigured) {
    if (!identityConfigured && explicitVault === undefined && !noVault && !configuredVault)
      missing.push("--vault or --no-vault");
    if (!agentName && !config.data["agent_name"]) missing.push("--agent-name");
    if (!timezone && !config.data["timezone"]) missing.push("--timezone");
  }
  const apply = flags["apply"] === true;
  const yes = flags["yes"] === true;
  if (apply && missing.length) return usage(`missing required choice ${missing[0]}`, json, target);
  if (apply && !yes && !process.stdin.isTTY) {
    process.stderr.write("error: --apply requires --yes without an interactive terminal\n");
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            target,
            steps: [
              {
                name: "consent",
                outcome: "refused",
                output: "--apply requires --yes without an interactive terminal",
              },
            ],
            writtenPaths: [],
            registeredCommand: null,
            verification: [],
            remainingActions: [],
          },
          null,
          2,
        ) + "\n",
      );
    }
    return INSTALL_EXIT.consentRefused;
  }
  if (apply && !yes && !(await askConsent())) {
    if (json)
      process.stdout.write(
        JSON.stringify(
          {
            target,
            steps: [{ name: "consent", outcome: "refused" }],
            writtenPaths: [],
            registeredCommand: null,
            verification: [],
            remainingActions: [],
          },
          null,
          2,
        ) + "\n",
      );
    return INSTALL_EXIT.consentRefused;
  }

  const selectedVault = setupVaultForPayload(explicitVault, configuredVault);
  const environmentWithChoices = {
    ...process.env,
    ...(agentName ? { VAULT_AGENT_NAME: agentName } : {}),
    ...(timezone ? { VAULT_TIMEZONE: timezone } : {}),
  };
  let env = buildInstallEnv({ vault: selectedVault, configPath, env: environmentWithChoices });
  let payload = payloadFor(target, env);
  const adapter: InstallAdapter | undefined = isInstallTargetId(target)
    ? defaultRegistry.get(target)
    : undefined;
  const steps: SetupStep[] = [];
  const writtenPaths: string[] = [];
  const verification: Array<{ name: string; status: string; details?: ReadonlyArray<string> }> = [];
  const remainingActions: string[] = [];
  let wrote = false;
  let exitCode: number = INSTALL_EXIT.ok;
  const registeredCommandFor = (current: McpPayload) => {
    const writtenPayload = isInstallTargetId(target)
      ? payloadAsWritten(target, current, env)
      : current;
    const grokCommand =
      target === "grok" ? grokMcpServers(current)["open-second-brain"] : undefined;
    return kind.kind === "adapter" && target !== "aider" && target !== "pi"
      ? {
          command: grokCommand?.command ?? writtenPayload.full.command,
          args: grokCommand?.args ?? writtenPayload.full.args,
        }
      : null;
  };

  if (!apply) {
    const registeredCommand = registeredCommandFor(payload);
    steps.push({
      name: "machine and brain",
      outcome: machineConfigured
        ? "already configured"
        : "would configure and initialize the brain store",
    });
    if (kind.kind === "adapter" && adapter) {
      const plan = adapter.plan(payload, env);
      steps.push({ name: "host", outcome: "plan", output: JSON.stringify(plan, null, 2) });
    } else if (kind.kind === "plugin") {
      steps.push({ name: "host", outcome: "manual step", output: kind.step });
      remainingActions.push(kind.step);
    } else {
      steps.push({ name: "host", outcome: "manual merge", output: snippet(payload) });
      remainingActions.push("merge the printed MCP configuration into the host configuration");
    }
    if (missing.length)
      steps.push({ name: "choices", outcome: `apply needs ${missing.join(", ")}` });
    const report: SetupReport = {
      target,
      steps,
      writtenPaths,
      registeredCommand,
      verification,
      remainingActions,
    };
    process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : textReport(report));
    return INSTALL_EXIT.ok;
  }

  if (!machineConfigured) {
    const initArgs = [
      ...(explicitVault !== undefined ? ["--vault", explicitVault] : []),
      "--agent-name",
      agentName ?? config.data["agent_name"]!,
      "--timezone",
      timezone ?? config.data["timezone"]!,
      "--config",
      configPath,
    ];
    const init = await captureStdout(() => cmdInit(initArgs));
    steps.push({
      name: "machine and brain",
      outcome: init.value === 0 ? "configured" : "failed",
      ...(init.output ? { output: init.output } : {}),
    });
    if (init.value !== 0) exitCode = INSTALL_EXIT.runtimeError;
    else {
      wrote = true;
      writtenPaths.push(configPath, resolveConfiguredStoreRoot(configPath).root);
      env = buildInstallEnv({
        vault: configuredVaultKey(configPath) ?? "",
        configPath,
        env: environmentWithChoices,
      });
      payload = payloadFor(target, env);
    }
  } else {
    steps.push({ name: "machine and brain", outcome: "already configured" });
  }

  const registeredCommand = registeredCommandFor(payload);

  if (exitCode === INSTALL_EXIT.ok && kind.kind === "adapter" && adapter) {
    const before = adapter.verify(env);
    if (before.status === "ok") {
      steps.push({ name: "host", outcome: "already connected" });
    } else {
      try {
        const plan = adapter.plan(payload, env);
        wrote = true;
        const applied = await captureStdout(() =>
          adapter.apply(plan, payload, env, {
            dryRun: false,
            force: false,
            stdout: process.stdout,
            stderr: process.stderr,
          }),
        );
        writtenPaths.push(...pathsFromApply(applied.value, env));
        steps.push({
          name: "host",
          outcome: "connected",
          ...(applied.output ? { output: applied.output } : {}),
        });
      } catch (error) {
        steps.push({ name: "host", outcome: "failed", output: (error as Error).message });
        exitCode =
          error instanceof InstallError && error.kind === "user-modified-block"
            ? INSTALL_EXIT.userModifiedBlock
            : INSTALL_EXIT.runtimeError;
      }
    }
    if (exitCode === INSTALL_EXIT.ok) {
      const checked = adapter.verify(env);
      verification.push({ name: target, status: checked.status, details: checked.details });
      steps.push({ name: "host verification", outcome: checked.status });
      if (checked.status !== "ok") exitCode = verifyCode(checked);
    }
  } else if (exitCode === INSTALL_EXIT.ok && kind.kind === "plugin") {
    steps.push({ name: "host", outcome: "manual step", output: kind.step });
    remainingActions.push(kind.step);
    exitCode = 7;
  } else if (exitCode === INSTALL_EXIT.ok) {
    steps.push({ name: "host", outcome: "manual merge", output: snippet(payload) });
    remainingActions.push("merge the printed MCP configuration into the host configuration");
    exitCode = 7;
  }

  if (exitCode !== INSTALL_EXIT.runtimeError) {
    const probe = await captureStdout(() =>
      runMcpProbe({
        vault: undefined,
        config: configPath,
        scope: "full",
        serverName: "open-second-brain",
        json: false,
        capabilityWindow: undefined,
        hostTarget: isInstallTargetId(target) ? target : undefined,
      }),
    );
    verification.push({ name: "MCP probe", status: probe.value === 0 ? "ok" : "failed" });
    steps.push({
      name: "MCP probe",
      outcome: probe.value === 0 ? "passed" : "failed",
      ...(probe.output ? { output: probe.output } : {}),
    });
    if (probe.value !== 0 && exitCode === INSTALL_EXIT.ok) exitCode = INSTALL_EXIT.runtimeError;
  }

  if (wrote) {
    const selftest = await runDoctorSelftest();
    const failedStages = selftest.stages
      .filter((stage) => !stage.ok)
      .map((stage) => `${stage.name}: ${stage.message}`);
    verification.push({
      name: "store self-test",
      status: selftest.ok ? "ok" : "failed",
      ...(failedStages.length ? { details: failedStages } : {}),
    });
    steps.push({
      name: "store self-test",
      outcome: selftest.ok ? "passed" : "failed",
      ...(failedStages.length ? { output: failedStages.join("\n") } : {}),
    });
    if (!selftest.ok && exitCode === INSTALL_EXIT.ok) exitCode = INSTALL_EXIT.runtimeError;
  } else {
    steps.push({ name: "store self-test", outcome: "self-test skipped (no writes)" });
  }

  const report: SetupReport = {
    target,
    steps,
    writtenPaths: [...new Set(writtenPaths)],
    registeredCommand,
    verification,
    remainingActions,
  };
  process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : textReport(report));
  return exitCode;
}
