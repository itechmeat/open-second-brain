/**
 * `o2b brain secret <set|list|rm|run>` (t_0b134404): capability-gated
 * secret custody. `set` ingests the value from stdin or --from-env -
 * NEVER from argv, where it would land in shell history and process
 * lists; `list` shows metadata only; `run <name> -- cmd...` injects
 * the secret into an allowlisted subprocess env and returns redacted
 * output. No surface ever prints the value.
 *
 * Exit codes: 0 on success (run: the subprocess exit code), 1 on an
 * operational failure, 2 on usage errors.
 */

import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { runWithSecret, SecretExecDeniedError } from "../../../core/brain/secrets/exec.ts";
import { listSecrets, removeSecret, setSecret } from "../../../core/brain/secrets/store.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE =
  "usage: o2b brain secret set <name> [--env-var V] [--allow PATTERN]... [--from-env SRC] | " +
  "list | rm <name> | run <name> -- <command...>  [--vault <path>] [--json]";

export async function cmdBrainSecret(argv: string[]): Promise<number> {
  // `run <name> -- cmd...`: everything after `--` belongs to the
  // subprocess verbatim and must not be flag-parsed.
  const dashDash = argv.indexOf("--");
  const ownArgs = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const commandArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : [];

  const { flags, positional } = parse(ownArgs, {
    vault: { type: "string" },
    "env-var": { type: "string" },
    allow: { type: "string-array" },
    "from-env": { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  if (op !== "set" && op !== "list" && op !== "rm" && op !== "run") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const name = positional[1];
  if (op !== "list" && !name) {
    process.stderr.write(`brain secret ${op}: a secret name is required\n${USAGE}\n`);
    return 2;
  }

  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined)?.trim() || resolveAgentName(config);
  const now = new Date();

  try {
    switch (op) {
      case "set": {
        const fromEnv = flags["from-env"] as string | undefined;
        let value: string;
        if (fromEnv !== undefined) {
          const fromEnvValue = process.env[fromEnv];
          if (fromEnvValue === undefined || fromEnvValue.length === 0) {
            process.stderr.write(`brain secret set: env var ${fromEnv} is unset or empty\n`);
            return 2;
          }
          value = fromEnvValue;
        } else {
          value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
          if (value.trim().length === 0) {
            process.stderr.write(
              `brain secret set: pipe the value via stdin or pass --from-env SRC\n`,
            );
            return 2;
          }
        }
        const metadata = setSecret(vault, {
          name: name!,
          value,
          ...(typeof flags["env-var"] === "string" ? { envVar: flags["env-var"] as string } : {}),
          allow: (flags["allow"] as string[] | undefined) ?? [],
          agent,
          now,
        });
        if (asJson) okJson({ ...metadata });
        else ok(`secret stored: ${metadata.name} (env: ${metadata.env_var})`);
        return 0;
      }
      case "list": {
        const secrets = listSecrets(vault);
        if (asJson) okJson({ secrets });
        else {
          ok(`secrets: ${secrets.length}`);
          for (const s of secrets) {
            ok(
              `  ${s.name}  env: ${s.env_var}  allow: ${s.allow.length === 0 ? "(exec denied)" : s.allow.join(", ")}`,
            );
          }
        }
        return 0;
      }
      case "rm": {
        const removed = removeSecret(vault, name!, { agent, now });
        if (!removed) return fail(`secret rm: unknown secret "${name}"`);
        if (asJson) okJson({ removed: name });
        else ok(`secret removed: ${name}`);
        return 0;
      }
      case "run": {
        if (commandArgs.length === 0) {
          process.stderr.write(`brain secret run: a command is required after --\n${USAGE}\n`);
          return 2;
        }
        const result = await runWithSecret(vault, name!, commandArgs, { agent, now });
        if (asJson) {
          okJson({ exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        } else {
          if (result.stdout.length > 0) process.stdout.write(result.stdout);
          if (result.stderr.length > 0) process.stderr.write(result.stderr);
        }
        return result.exitCode;
      }
    }
    return 2;
  } catch (exc) {
    if (exc instanceof SecretExecDeniedError) {
      process.stderr.write(`brain secret: ${exc.message}\n`);
      return 2;
    }
    const message = `secret ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
