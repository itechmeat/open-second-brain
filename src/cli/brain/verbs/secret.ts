/**
 * `o2b brain secret <set|list|rm|run|lock|unlock|unwrap|export|import>`
 * (t_0b134404, t_e6667a56, t_592d9e91): capability-gated secret custody.
 * `set` ingests the value from stdin or --from-env - NEVER from argv,
 * where it would land in shell history and process lists; `list` shows
 * metadata only; `run <name> -- cmd...` injects the secret into an
 * allowlisted subprocess env and returns redacted output; `unlock` wraps
 * the keyfile under a passphrase (first unlock) and holds the key for
 * this process only; `lock` clears that holder; `unwrap` writes the raw
 * keyfile back (the way back from a wrapped store); `export` writes every
 * entry as one passphrase-encrypted bundle to an operator-named `--out`,
 * with the shared egress redactor run over the bundle's non-ciphertext
 * metadata tree; `import` restores a bundle. No surface ever prints a
 * value or a passphrase.
 *
 * A wrapped store reaches every key-bearing verb (set, rm, run, export,
 * import): the verb ingests a passphrase the way `unlock` does - via
 * `--passphrase-from-env` or stdin - and unlocks before the operation,
 * so one command can carry both the passphrase and its work. A host that
 * cannot answer a prompt (the MCP server, a cron job) sets
 * OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE instead; the first key operation
 * consumes it, holds the key, and deletes the variable.
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
  resealBundleMetadata,
} from "../../../core/brain/secrets/bundle.ts";
import {
  listSecrets,
  lockSecretKeyfile,
  removeSecret,
  setSecret,
  storeLockedForThisProcess,
  unlockSecretKeyfile,
  unwrapSecretKeyfile,
} from "../../../core/brain/secrets/store.ts";
import { SECRET_STORE_PASSPHRASE_ENV } from "../../../core/brain/secrets/envelope.ts";
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
const UNWRAPPED_NOTE =
  "keyfile unwrapped; the raw key is on disk again and the passphrase wrap is gone";
const UNWRAPPED_WARNING =
  "warning: the keyfile holds raw key material again and the passphrase no longer protects " +
  `it - re-run "o2b brain secret unlock" to wrap it when the raw key is no longer needed\n`;
/**
 * The custody nudge (PR #244 review L7): from the first unlock on, the
 * passphrase is the only key to every stored value and a lost one is
 * unrecoverable, and the one act that keeps a restorable copy -
 * `export` - must run while the operator still holds the values. Printed
 * on EVERY successful unlock, so an operator re-unlocking meets it again
 * before the wrap becomes the thing they rely on.
 */
const UNLOCK_NUDGE =
  "note: a lost passphrase is unrecoverable - the stored values stay unreadable forever " +
  `without it. To keep a restorable backup, run "o2b brain secret export --out FILE" with a ` +
  "passphrase you will not lose, before relying on the wrap.\n";

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

/**
 * Unlock a wrapped store ahead of a key-bearing operation, so one
 * command invocation can carry the passphrase AND its work. No-op when
 * the store is not wrapped, this process already holds the key, or the
 * well-known environment variable is set - in the last case the first
 * key operation consumes the variable itself, and an ingestion here
 * would read an empty source and refuse a store that is about to unlock.
 * `stdinFree` is false where the verb's own work occupies stdin (`set`
 * reads the VALUE from it): without a route the caller proceeds and the
 * store's named locked refusal, whose remedy text names every route, is
 * what the operator sees.
 */
async function ensureStoreUnlocked(
  vault: string,
  op: string,
  flags: Record<string, string | boolean | string[] | undefined>,
  stdinFree: boolean,
  ctx: { agent: string; now: Date },
): Promise<number | null> {
  if (!storeLockedForThisProcess(vault)) return null;
  if (process.env[SECRET_STORE_PASSPHRASE_ENV] !== undefined) return null;
  if (flags["passphrase-from-env"] === undefined && !stdinFree) return null;
  const ingested = await ingestPassphrase(op, flags);
  if ("exitCode" in ingested) return ingested.exitCode;
  unlockSecretKeyfile(vault, ingested.passphrase, ctx);
  return null;
}

/**
 * The store unlock a wrapped store needs from export/import: the SAME
 * passphrase the verb already ingested for the bundle, unless the
 * environment variable is set, in which case the key operation unlocks
 * from there and the ingested passphrase stays the bundle's alone.
 * Passphrase-protected store and bundle are one secret per invocation
 * here; an operator who keeps them apart sets the environment variable
 * to the keyfile passphrase.
 */
async function unlockStoreForBundleOp(
  vault: string,
  passphrase: string,
  ctx: { agent: string; now: Date },
): Promise<void> {
  if (!storeLockedForThisProcess(vault)) return;
  if (process.env[SECRET_STORE_PASSPHRASE_ENV] !== undefined) return;
  unlockSecretKeyfile(vault, passphrase, ctx);
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
    op !== "unwrap" &&
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
        // A wrapped store unlocks first; the value occupies stdin here,
        // so the passphrase must come from --passphrase-from-env or the
        // well-known environment variable (see ensureStoreUnlocked).
        const unlocked = await ensureStoreUnlocked(vault, "set", flags, fromEnv !== undefined, {
          agent,
          now,
        });
        if (unlocked !== null) return unlocked;
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
        const unlocked = await ensureStoreUnlocked(vault, "rm", flags, true, { agent, now });
        if (unlocked !== null) return unlocked;
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
        // The custody nudge rides every successful unlock, before the
        // success note: the wrap has just begun or been re-entered, and
        // this is the moment a restorable backup is still one command away.
        process.stderr.write(UNLOCK_NUDGE);
        if (asJson) okJson({ unlocked: true });
        else ok(UNLOCKED_NOTE);
        return 0;
      }
      case "unwrap": {
        const ingested = await ingestPassphrase("unwrap", flags);
        if ("exitCode" in ingested) return ingested.exitCode;
        // The way back from a wrapped store: the passphrase is verified
        // against the envelope first, then the raw key is written over it
        // (fsync'd atomic rename, 0600). A store that was never wrapped
        // refuses by name.
        unwrapSecretKeyfile(vault, ingested.passphrase, { agent, now });
        // The raw key material is back on disk - say so before the
        // success note, so the state change is what the operator reads.
        process.stderr.write(UNWRAPPED_WARNING);
        if (asJson) okJson({ unwrapped: true });
        else ok(UNWRAPPED_NOTE);
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
        // Exporting needs the plaintext values, so a wrapped store
        // unlocks first - with the same passphrase the bundle is sealed
        // under, unless the environment variable carries the keyfile's.
        await unlockStoreForBundleOp(vault, ingested.passphrase, { agent, now });
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
        // A redaction that edited an allow pattern changes the metadata
        // the values are authenticated against, so the merged bundle is
        // re-sealed under the metadata that actually ships.
        const payload = verdict.redacted
          ? resealBundleMetadata(
              bundleFromEgressScan(bundle, verdict.payload),
              ingested.passphrase,
              bundle,
            )
          : bundle;
        atomicWriteFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
        if (verdict.redacted) process.stderr.write(EGRESS_REDACTION_NOTICE);
        if (asJson) okJson({ out, exported: Object.keys(bundle.entries).length });
        else ok(`secret bundle exported: ${Object.keys(bundle.entries).length} entries -> ${out}`);
        return 0;
      }
      case "import": {
        const ingested = await ingestPassphrase("import", flags);
        if ("exitCode" in ingested) return ingested.exitCode;
        // Importing writes into the target store's ciphertext, so a
        // wrapped target unlocks first - with the same passphrase the
        // bundle opens under, unless the environment variable carries the
        // keyfile's.
        await unlockStoreForBundleOp(vault, ingested.passphrase, { agent, now });
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
        // The wildcard-allowlist warning (PR #244 review L2): an entry
        // carried with the open exec allowlist `*` lets `secret run`
        // execute ANY command. The bundle's AAD already proved the list
        // is exactly what was exported - what it cannot say is whether
        // exporting it was wise - so the import names every entry it
        // restored whose allowlist is the open one. A non-wildcard
        // bundle prints nothing and imports byte-identically.
        const restored = new Set([...result.imported, ...result.replaced]);
        const openAllowed = listSecrets(vault)
          .filter((s) => restored.has(s.name) && s.allow.includes("*"))
          .map((s) => s.name)
          .toSorted();
        if (openAllowed.length > 0) {
          process.stderr.write(
            `warning: secret import: ${openAllowed.map((n) => JSON.stringify(n)).join(", ")} ` +
              'carries the open exec allowlist "*" - every command is allowed. Narrow it ' +
              `("brain secret rm" + "brain secret set") if that is not intended.\n`,
          );
        }
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
        // A wrapped store unlocks first. The subprocess inherits this
        // process's stdin, so an operator piping the passphrase should
        // know the child sees the drained pipe; --passphrase-from-env is
        // the route that leaves stdin alone.
        const unlocked = await ensureStoreUnlocked(vault, "run", flags, true, { agent, now });
        if (unlocked !== null) return unlocked;
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
