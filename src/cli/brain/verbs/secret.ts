/**
 * `o2b brain secret <set|list|rm|run|lock|unlock|export|import>`
 * (t_0b134404, t_e6667a56, t_592d9e91): capability-gated secret custody.
 * `set` ingests the value from stdin or --from-env - NEVER from argv,
 * where it would land in shell history and process lists; `list` shows
 * metadata only; `run <name> -- cmd...` injects the secret into an
 * allowlisted subprocess env and returns redacted output; `unlock` wraps
 * the keyfile under a passphrase (first unlock) and holds the key for
 * this process only; `lock` clears that holder; `export` writes every
 * entry as one passphrase-encrypted bundle to an operator-named `--out`,
 * with the shared egress redactor run over the bundle's non-ciphertext
 * metadata tree; `import` restores a bundle. No surface ever prints a
 * value or a passphrase.
 *
 * A LOST PASSPHRASE IS UNRECOVERABLE: after `unlock` has wrapped the
 * keyfile, the stored values stay unreadable forever without it - and a
 * lost bundle passphrase loses the bundle. There is no recovery path and
 * none is pretended.
 *
 * Exit codes: 0 on success (run: the subprocess exit code), 1 on an
 * operational failure, 2 on usage errors.
 */

import { readFileSync } from "node:fs";

import { resolveAgentName } from "../../../core/config.ts";
import { atomicWriteFileSync } from "../../../core/fs-atomic.ts";
import { runWithSecret, SecretExecDeniedError } from "../../../core/brain/secrets/exec.ts";
import {
  bundleEgressScanTree,
  bundleFromEgressScan,
  exportSecretBundle,
  importSecretBundle,
} from "../../../core/brain/secrets/bundle.ts";
import {
  listSecrets,
  lockSecretKeyfile,
  removeSecret,
  setSecret,
  unlockSecretKeyfile,
} from "../../../core/brain/secrets/store.ts";
import {
  formatSecretsSyncExposure,
  formatWrappedKeyfileExposure,
  secretsSyncExposure,
} from "../../../core/brain/secrets/sync-exposure.ts";
import { EGRESS_REDACTION_NOTICE, redactForEgress } from "../../../core/egress/guard.ts";
import { SECRET_VERB_USAGE, secretOpAccepts } from "../help-text.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";
import { readStdinText } from "../../stdin.ts";

// Assembled from the same per-op flag tables `o2b brain secret --help`
// renders (help-text.ts), so the two surfaces cannot drift apart.
const USAGE = SECRET_VERB_USAGE;

/** Success notes, hoisted: stdout is contract, not prose. */
const UNLOCKED_NOTE =
  "keyfile unlocked for this process; the passphrase is held in memory only and never written";
const LOCKED_NOTE = "keyfile locked; this process's unlocked-key holder is cleared";

/** The declared egress site of the bundle export (src/core/egress/registry.ts). */
const BUNDLE_EGRESS_SITE = "brain-secret-bundle-export" as const;

/**
 * Ingest the passphrase the way `set` ingests a value: `--passphrase-from-env`
 * or stdin, never argv. The passphrase must never land in shell history or a
 * process list - it protects every stored value after the first unlock. Both
 * routes enforce ONE blankness rule - a value that is empty after trim is not
 * a passphrase - so `SECRET_PASS="   "` cannot wrap the keyfile the way an
 * unset-variable accident through the stdin route cannot.
 */
async function ingestPassphrase(
  op: string,
  flags: Record<string, string | boolean | string[] | undefined>,
): Promise<{ passphrase: string } | { exitCode: number }> {
  const fromEnv = flags["passphrase-from-env"] as string | undefined;
  if (fromEnv !== undefined) {
    const value = process.env[fromEnv];
    if (value === undefined || value.trim().length === 0) {
      process.stderr.write(
        `brain secret ${op}: env var ${fromEnv} is unset, empty, or blank; set it to a passphrase, or pipe the passphrase via stdin\n`,
      );
      return { exitCode: 2 };
    }
    return { passphrase: value };
  }
  const passphrase = (await readStdinText()).replace(/\r?\n$/, "");
  if (passphrase.trim().length === 0) {
    process.stderr.write(
      `brain secret ${op}: pipe the passphrase via stdin or pass --passphrase-from-env SRC\n`,
    );
    return { exitCode: 2 };
  }
  return { passphrase };
}

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
    "passphrase-from-env": { type: "string" },
    out: { type: "string" },
    replace: { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  const asJson = flags["json"] === true;
  if (
    op !== "set" &&
    op !== "list" &&
    op !== "rm" &&
    op !== "run" &&
    op !== "lock" &&
    op !== "unlock" &&
    op !== "export" &&
    op !== "import"
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // An op that never documents a flag refuses it by name instead of
  // silently swallowing it while its effect never happens: the parse
  // table is op-independent, so without this check `lock
  // --passphrase-from-env SRC` would exit 0 having read nothing.
  for (const flag of Object.keys(flags)) {
    if (!secretOpAccepts(op, flag)) {
      process.stderr.write(`brain secret ${op}: unknown flag --${flag}\n${USAGE}\n`);
      return 2;
    }
  }
  const name = positional[1];
  const needsName = op === "set" || op === "rm" || op === "run" || op === "import";
  if (needsName && !name) {
    const what = op === "import" ? "a bundle file path is required" : "a secret name is required";
    process.stderr.write(`brain secret ${op}: ${what}\n${USAGE}\n`);
    return 2;
  }

  const { config, vault } = brainVerbContext(flags);
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
            process.stderr.write(
              `brain secret set: env var ${fromEnv} is unset or empty; set it to a value, or pipe the value via stdin\n`,
            );
            return 2;
          }
          value = fromEnvValue;
        } else {
          value = (await readStdinText()).replace(/\r?\n$/, "");
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
        // Stored, but say so if a Syncthing folder will carry the keyfile
        // to its peers: the directory's .gitignore does not reach
        // Syncthing, and the operator's .stignore is theirs to edit.
        const exposure = secretsSyncExposure(vault);
        if (exposure !== null) {
          process.stderr.write(`warning: ${formatSecretsSyncExposure(exposure)}\n`);
        }
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
      case "unlock": {
        const ingested = await ingestPassphrase("unlock", flags);
        if ("exitCode" in ingested) return ingested.exitCode;
        // Wrap-on-first-unlock: on a store whose keyfile is still raw,
        // THIS is the opt-in. From then on the passphrase is the only key
        // to every stored value, and losing it loses them.
        unlockSecretKeyfile(vault, ingested.passphrase, { agent, now });
        // Say what a synced folder now carries: the envelope travels to
        // every peer, where the passphrase is the protection left.
        const exposure = secretsSyncExposure(vault);
        if (exposure !== null) {
          process.stderr.write(`warning: ${formatWrappedKeyfileExposure(exposure)}\n`);
        }
        if (asJson) okJson({ unlocked: true });
        else ok(UNLOCKED_NOTE);
        return 0;
      }
      case "lock": {
        lockSecretKeyfile(vault, { agent, now });
        if (asJson) okJson({ locked: true });
        else ok(LOCKED_NOTE);
        return 0;
      }
      case "export": {
        const out = flags["out"] as string | undefined;
        if (out === undefined || out.length === 0) {
          process.stderr.write(`brain secret export: --out FILE is required\n${USAGE}\n`);
          return 2;
        }
        const ingested = await ingestPassphrase("export", flags);
        if ("exitCode" in ingested) return ingested.exitCode;
        const bundle = exportSecretBundle(vault, ingested.passphrase, { agent, now });
        // The destination is operator-named and leaves the machine, so the
        // shared egress guard runs before any byte is written - over the
        // bundle's metadata inventory (see bundleEgressScanTree for what is
        // deliberately out of the tree). A redacted allow pattern merges;
        // a rewritten entry identifier refuses.
        const verdict = redactForEgress(BUNDLE_EGRESS_SITE, bundleEgressScanTree(bundle));
        if (verdict.outcome !== "released") {
          return fail(`secret export: ${verdict.detail}`);
        }
        const payload = verdict.redacted ? bundleFromEgressScan(bundle, verdict.payload) : bundle;
        atomicWriteFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
        if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
        if (asJson) okJson({ out, exported: Object.keys(bundle.entries).length });
        else ok(`secret bundle exported: ${Object.keys(bundle.entries).length} entries -> ${out}`);
        return 0;
      }
      case "import": {
        const ingested = await ingestPassphrase("import", flags);
        if ("exitCode" in ingested) return ingested.exitCode;
        let bundle: unknown;
        try {
          bundle = JSON.parse(readFileSync(name!, "utf8"));
        } catch (err) {
          return fail(
            `secret import: the bundle file is unreadable or not JSON: ${name!}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const result = importSecretBundle(vault, bundle, {
          passphrase: ingested.passphrase,
          replace: flags["replace"] === true,
          agent,
          now,
        });
        if (asJson) okJson({ imported: result.imported, replaced: result.replaced });
        else
          ok(
            `secret bundle imported: ${result.imported.length} entries ` +
              `(${result.replaced.length} replaced)`,
          );
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
