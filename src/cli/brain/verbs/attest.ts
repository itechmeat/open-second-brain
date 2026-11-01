/**
 * `o2b brain attest <keygen|sign|list|verify>` (delivery trust, card
 * t_3bdb82b0): the operator surface over the attestation kernel.
 *
 * The split is the `brain_secrets` split applied to signatures: everything
 * that holds or mints a key is CLI-only, because a key lifecycle is an
 * operator decision and never an agent's. The MCP face
 * (`brain_attestations`) is read-only list/verify; no keygen or sign
 * surface exists anywhere but here.
 *
 * The passphrase never rides argv. It is ingested exactly the way the
 * secret verb ingests a value: `--passphrase-from-env NAME` (the
 * kernel-resolved route, `$secret:` references included) or stdin, with
 * ONE blankness rule - a value that is empty after trim is not a
 * passphrase. A wrap is optional at keygen; an operator who pipes nothing
 * gets the raw 0600 seed.
 *
 * Exit codes (the `brain log verify` contract): 0 on success and on a
 * verification where every shard is intact or merely appended, 1 on an
 * operational failure, a diverged or missing shard, or an invalid
 * signature, 2 on usage errors.
 */

import {
  buildAttestationRecord,
  listAttestationRecordFiles,
  readAttestationRecordFile,
  writeAttestationRecord,
  type AttestationRecord,
} from "../../../core/brain/attestation/record.ts";
import {
  attestationStoreDigest,
  collectAttestationManifest,
} from "../../../core/brain/attestation/digest.ts";
import {
  ATTESTATION_KEY_MISSING,
  AttestationKeyExistsError,
  AttestationKeyMissingError,
  AttestationPassphraseError,
  generateAttestationKeypair,
  signAttestationRecord,
} from "../../../core/brain/attestation/signing.ts";
import { verifyAttestation } from "../../../core/brain/attestation/verify.ts";
import { brainVerbContext, fail, info, parse, writeJson, ok, okJson } from "../helpers.ts";
import { readStdinText } from "../../stdin.ts";

const ATTEST_VERBS = Object.freeze({
  keygen: "keygen",
  sign: "sign",
  list: "list",
  verify: "verify",
} as const);

/** Printed for `o2b brain attest` with no verb, and for `--help`. */
const ATTEST_USAGE =
  "usage: o2b brain attest <verb> [args...]\n" +
  "Verbs:\n" +
  "  keygen [--passphrase-from-env NAME] [--json]\n" +
  "                  Generate the operator's Ed25519 attestation keypair under\n" +
  "                  .open-second-brain/keys/attestation/ (private half 0600, never\n" +
  "                  synced). The optional passphrase - an env var NAME or stdin,\n" +
  "                  never argv - wraps the private half. Key loss means every past\n" +
  "                  attestation stays unverifiable; there is no recovery.\n" +
  "  sign [--passphrase-from-env NAME] [--json]\n" +
  "                  Measure the store (log heads, ledger inventories, index\n" +
  "                  stamp), seal and sign one attestation record, and write it as\n" +
  "                  one JSON file. Signing never creates a key.\n" +
  "  list [--json]   Every attestation, newest first: id, created-at, device.\n" +
  "  verify [--json] Re-measure the store against the newest attestation: per-shard\n" +
  "                  intact / appended / diverged / missing, the signature, and the\n" +
  "                  store digest. Reports only - nothing here repairs a store.\n";

/**
 * The CLI-internal env bridge for a passphrase that arrived on stdin: the
 * kernel's contract takes an env var NAME (so `$secret:` resolution and
 * the named refusals stay in one place), so the value read from stdin is
 * parked here for the duration of the one kernel call and deleted after -
 * the consumed-once shape the secrets env bridge uses.
 */
const ATTEST_PASSPHRASE_STDIN_ENV = "OPEN_SECOND_BRAIN_ATTEST_PASSPHRASE_STDIN";

type IngestedPassphrase = { readonly name: string } | { readonly exitCode: number };

/**
 * Ingest the passphrase the secret verb's way: `--passphrase-from-env NAME`
 * or stdin, never argv. Returns the env var NAME for the kernel (its own
 * for the flag route; the CLI bridge's for the stdin route), or an exit
 * code when the route is broken. A blank stdin yields `null` - no
 * passphrase - which keygen reads as "store the raw seed" and sign reads
 * as "holder, env bridge, or the named locked refusal".
 */
async function ingestPassphrase(
  op: string,
  flags: Record<string, string | boolean | string[] | undefined>,
): Promise<IngestedPassphrase | null> {
  const fromEnv = flags["passphrase-from-env"] as string | undefined;
  if (fromEnv !== undefined) {
    const value = process.env[fromEnv];
    if (value === undefined || value.trim().length === 0) {
      process.stderr.write(
        `brain attest ${op}: env var ${fromEnv} is unset, empty, or blank; set it to a ` +
          "passphrase (or a $secret: reference), or pipe the passphrase via stdin\n",
      );
      return { exitCode: 2 };
    }
    return { name: fromEnv };
  }
  if (process.stdin.isTTY) return null;
  // A stream that cannot be read (the in-process test runner's already
  // consumed body) is an EMPTY pipe, not a passphrase: same answer an
  // empty pipe gives, so no second reading of "no input" exists.
  let text: string;
  try {
    text = await readStdinText();
  } catch {
    return null;
  }
  const passphrase = text.replace(/\r?\n$/, "");
  if (passphrase.trim().length === 0) return null;
  process.env[ATTEST_PASSPHRASE_STDIN_ENV] = passphrase;
  return { name: ATTEST_PASSPHRASE_STDIN_ENV };
}

/** Run `body` with the bridge env var cleaned up whichever way it ends. */
async function withPassphraseBridge(
  ingested: IngestedPassphrase | null,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } finally {
    if (ingested !== null && "name" in ingested && ingested.name === ATTEST_PASSPHRASE_STDIN_ENV) {
      delete process.env[ATTEST_PASSPHRASE_STDIN_ENV];
    }
  }
}

/** The named refusal every key-bearing operation maps to exit 1 through. */
function failAttestation(op: string, exc: unknown): number {
  if (exc instanceof AttestationKeyMissingError) {
    return fail(`${ATTESTATION_KEY_MISSING}: ${(exc as Error).message}`);
  }
  if (exc instanceof AttestationPassphraseError || exc instanceof AttestationKeyExistsError) {
    return fail(
      `${(exc as { code?: string }).code ?? "attestation_error"}: ${(exc as Error).message}`,
    );
  }
  return fail(`brain attest ${op} failed: ${(exc as Error).message ?? exc}`);
}

export async function cmdBrainAttest(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(ATTEST_USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0]!;
  const rest = argv.slice(1);
  switch (sub) {
    case ATTEST_VERBS.keygen:
      return await cmdBrainAttestKeygen([...rest]);
    case ATTEST_VERBS.sign:
      return await cmdBrainAttestSign([...rest]);
    case ATTEST_VERBS.list:
      return await cmdBrainAttestList([...rest]);
    case ATTEST_VERBS.verify:
      return await cmdBrainAttestVerify([...rest]);
    default:
      process.stderr.write(
        `unknown brain attest verb: ${sub}; supported: ${Object.values(ATTEST_VERBS).join(", ")}\n`,
      );
      return 2;
  }
}

async function cmdBrainAttestKeygen(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "passphrase-from-env": { type: "string" },
  });
  const { vault } = brainVerbContext(flags);
  const ingested = await ingestPassphrase("keygen", flags);
  if (ingested !== null && "exitCode" in ingested) return ingested.exitCode;
  return await withPassphraseBridge(ingested, async () => {
    let paths;
    try {
      paths = generateAttestationKeypair(
        vault,
        ingested === null ? {} : { passphraseFromEnv: ingested.name },
      );
    } catch (exc) {
      return failAttestation("keygen", exc);
    }
    if (flags["json"]) {
      okJson({ private_path: paths.privatePath, public_path: paths.publicPath });
      return 0;
    }
    ok("attestation keypair generated (a lost key leaves every past attestation unverifiable):");
    ok(`  private: ${paths.privatePath}`);
    ok(`  public:  ${paths.publicPath}`);
    return 0;
  });
}

async function cmdBrainAttestSign(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "passphrase-from-env": { type: "string" },
  });
  const { vault } = brainVerbContext(flags);
  const ingested = await ingestPassphrase("sign", flags);
  if (ingested !== null && "exitCode" in ingested) return ingested.exitCode;
  return await withPassphraseBridge(ingested, async () => {
    let record: AttestationRecord;
    try {
      const manifest = collectAttestationManifest(vault);
      const sealed = buildAttestationRecord(vault, manifest);
      record = signAttestationRecord(
        sealed,
        vault,
        ingested === null ? {} : { passphraseFromEnv: ingested.name },
      );
      const { path } = writeAttestationRecord(vault, record);
      if (flags["json"]) {
        okJson({
          id: record.id,
          created_at: record.createdAt,
          device_id: record.deviceId,
          store_digest: attestationStoreDigest(record.manifest),
          path,
        });
        return 0;
      }
      ok(`attestation written: ${path}`);
      ok(`  id: ${record.id}  device: ${record.deviceId}`);
      return 0;
    } catch (exc) {
      return failAttestation("sign", exc);
    }
  });
}

async function cmdBrainAttestList(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  // Name order is time order (the id is the compact UTC instant), so
  // newest-first is a reverse of the oldest-first listing.
  let records: ReadonlyArray<{ path: string; record: AttestationRecord }>;
  try {
    records = listAttestationRecordFiles(vault)
      .toReversed()
      .map((entry) => ({ path: entry.path, record: readAttestationRecordFile(entry.path) }));
  } catch (exc) {
    return failAttestation("list", exc);
  }

  if (flags["json"]) {
    writeJson({
      attestations: records.map(({ path, record }) => ({
        id: record.id,
        created_at: record.createdAt,
        device_id: record.deviceId,
        store_digest: record.storeDigest,
        path,
      })),
    });
    return 0;
  }
  if (records.length === 0) {
    info("no attestation on record; `o2b brain attest sign` writes one");
    return 0;
  }
  info(`attestations: ${records.length} (newest first)`);
  for (const { path, record } of records) {
    info(`  ${record.id}  created: ${record.createdAt}  device: ${record.deviceId}`);
    info(`    ${path}`);
  }
  return 0;
}

/**
 * Re-measure the store against the newest attestation and print the
 * per-shard verdict.
 *
 * Exit 1 when anything reports damage - a diverged or missing shard, or a
 * signature that does not verify. `appended` shards and a false
 * store-digest match beside nothing but appends are a store that MOVED,
 * not a store that broke, and they exit 0: a cron entry keyed on this
 * verb reports breakage, not progress.
 */
async function cmdBrainAttestVerify(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);

  let record: AttestationRecord;
  try {
    const files = listAttestationRecordFiles(vault);
    const newest = files.at(-1);
    if (newest === undefined) {
      if (flags["json"]) {
        writeJson({ verified: null });
        return 0;
      }
      info("no attestation on record: nothing to verify");
      return 0;
    }
    record = readAttestationRecordFile(newest.path);
  } catch (exc) {
    return failAttestation("verify", exc);
  }

  const result = verifyAttestation(vault, record);
  const damaged = result.shards.some(
    (shard) => shard.state === "diverged" || shard.state === "missing",
  );
  const healthy = !damaged && result.signatureValid;

  if (flags["json"]) {
    // The K4 AttestationVerification shape, field for field.
    writeJson(result);
    return healthy ? 0 : 1;
  }

  info(
    `attestation ${result.recordId} (${result.createdAt}): ` +
      `${result.shards.length} ${result.shards.length === 1 ? "shard" : "shards"}, ` +
      `signature ${result.signatureValid ? "valid" : "INVALID"}`,
  );
  for (const shard of result.shards) info(`  ${shard.shardId}: ${shard.state}`);
  info(
    result.storeDigestMatches
      ? "store digest matches the attested one"
      : "store digest differs from the attested one" +
          (healthy ? " (the appended shards above name why)" : ""),
  );
  if (healthy) return 0;
  info(
    "the store diverged from the point this attestation vouches for: the shards named " +
      "above were edited, removed, or rewritten after it was signed. Nothing here repairs " +
      "a store; `o2b brain log verify` answers whether the chain itself still links up.",
  );
  return 1;
}
