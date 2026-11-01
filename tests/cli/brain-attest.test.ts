/**
 * `o2b brain attest <keygen|sign|list|verify>` (delivery trust, Lane D
 * task D5).
 *
 * The operator surface over the attestation kernel. What these tests hold
 * the verb to:
 *
 *   - keygen prints paths only - never a byte of key material;
 *   - sign without keygen refuses by name (`attestation_key_missing`) and
 *     never mints a key;
 *   - the passphrase rides `--passphrase-from-env` or stdin, never argv,
 *     with the secret verb's blankness rule and exit code 2 for a broken
 *     route;
 *   - verify is the exit-code contract of `brain log verify`: 0 while the
 *     store is intact or merely appended, 1 on divergence or a bad
 *     signature, 2 on usage - because a check whose failure looks like
 *     its success is not a check;
 *   - `--json` carries the K4 shapes.
 *
 * Wrapped-key flows run in fresh subprocesses, the way a cron entry or a
 * script would reach the verb: one process holds an unlocked envelope,
 * the next does not.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLogLock, appendLogEvent } from "../../src/core/brain/log.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { attestationsDir } from "../../src/core/brain/attestation/record.ts";
import { writeVaultIdentity } from "../../src/core/brain/vault-identity.ts";
import { runCli } from "../helpers/run-cli.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";

/**
 * Passphrases assembled at runtime so no source line carries a literal
 * shaped like a real credential (the fake-credentials doctrine); the
 * two stdin routes use distinct values the way two operators would.
 */
const STDIN_PASSPHRASE = fakeCredential("attest", "-passphrase-", "9137");
const STDIN_PASSPHRASE_ALT = fakeCredential("attest", "-passphrase-", "2468");
const ENV_ROUTE_PASSPHRASE = fakeCredential("env-route", "-pass-", "5150");

const DATE = "2026-06-03";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-attest-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
  writeVaultIdentity(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function append(count: number, deviceId = ""): void {
  for (let i = 0; i < count; i++) {
    appendLogEvent(
      vault,
      {
        timestamp: `${DATE}T10:00:0${i}Z`,
        eventType: "note",
        body: { text: `event ${i}`, agent: "@tester" },
      },
      { deviceId },
    );
  }
}

function recordFiles(): string[] {
  const dir = attestationsDir(vault);
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

/** Edit one chained line in place: a forgery, not an append. */
function forgeLine(shardName: string): void {
  const path = join(vault, "Brain", "log", shardName);
  const rows = readFileSync(path, "utf8").trim().split("\n");
  const row = JSON.parse(rows[rows.length - 1]!);
  row.payload.text = "forged after the fact";
  rows[rows.length - 1] = JSON.stringify(row);
  writeFileSync(path, rows.join("\n") + "\n", "utf8");
}

test("keygen creates the key pair and prints paths only", async () => {
  const res = await runCli(["brain", "attest", "keygen", "--vault", vault]);
  expect(res.returncode).toBe(0);
  const privatePath = join(vault, ".open-second-brain", "keys", "attestation", "attestation.key");
  const publicPath = join(vault, ".open-second-brain", "keys", "attestation", "attestation.pub");
  expect(existsSync(privatePath)).toBe(true);
  expect(existsSync(publicPath)).toBe(true);
  expect(res.stdout).toContain(privatePath);
  expect(res.stdout).toContain(publicPath);
  // Paths only: no seed, no PEM body, nothing a screenshot could leak.
  expect(res.stdout).not.toMatch(/[0-9a-f]{64}/);
  expect(readFileSync(privatePath, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
});

test("keygen twice refuses, and the refusal never replaces the key", async () => {
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  const before = readFileSync(
    join(vault, ".open-second-brain", "keys", "attestation", "attestation.key"),
    "utf8",
  );
  const res = await runCli(["brain", "attest", "keygen", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("already exists");
  expect(
    readFileSync(
      join(vault, ".open-second-brain", "keys", "attestation", "attestation.key"),
      "utf8",
    ),
  ).toBe(before);
});

test("sign without keygen refuses by name and names the keygen remedy", async () => {
  append(2);
  const res = await runCli(["brain", "attest", "sign", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("attestation_key_missing");
  expect(res.stderr).toContain("attest keygen");
  expect(recordFiles()).toEqual([]);
});

test("sign writes one file and list shows it with id, created_at and device", async () => {
  append(2);
  expect(await runCli(["brain", "attest", "keygen", "--vault", vault])).toMatchObject({
    returncode: 0,
  });
  const signed = await runCli(["brain", "attest", "sign", "--vault", vault]);
  expect(signed.returncode).toBe(0);
  expect(recordFiles()).toHaveLength(1);
  expect(recordFiles()[0]).toMatch(/^attest-\d{8}T\d{6}\d{3}Z\.json$/);

  const list = await runCli(["brain", "attest", "list", "--vault", vault]);
  expect(list.returncode).toBe(0);
  expect(list.stdout).toContain("attest-");
  expect(list.stdout).toMatch(/created/);
  expect(list.stdout).toMatch(/device/);
});

test("list is newest-first", async () => {
  append(1);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // A second sign lands a later instant; nudge the clock so the two
  // millisecond ids cannot collide.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await runCli(["brain", "attest", "sign", "--vault", vault]);
  expect(second.returncode).toBe(0);
  const list = await runCli(["brain", "attest", "list", "--vault", vault]);
  const ids = [...list.stdout.matchAll(/attest-\d{8}T\d{6}\d{3}Z/g)].map((m) => m[0]);
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect(ids[0]).toBe(recordFiles().at(-1)!.replace(".json", ""));
});

test("verify on an untouched vault exits zero with every shard intact", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("intact");
});

test("verify after a legitimate append exits zero naming the appended shard", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  append(2);
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toContain("appended");
});

test("verify after a forged edit exits one naming the diverged shard", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // Forge an APPENDED row: the attested head itself is the anchor the
  // record signed, and integrity below it is `brain log verify`'s
  // question, not this one.
  append(2);
  forgeLine("2026-06-03.jsonl");
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stdout).toContain("diverged");
  expect(res.stdout).toContain("2026-06-03.jsonl");
});

test("a shard created after signing is growth, not unexplained drift", async () => {
  append(2);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // The next write lands in a NEW day shard: it is not an attested
  // shard, so no verdict says appended - but its file joining the log
  // directory and its head joining the manifest is exactly the growth
  // the cron contract reads as progress.
  appendLogEvent(
    vault,
    {
      timestamp: "2026-06-04T10:00:00Z",
      eventType: "note",
      body: { text: "the next day's first event", agent: "@tester" },
    },
    { deviceId: "" },
  );
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  // The digest differs and the report reads it as growth, not damage -
  // the new shard is not an attested row, so the prose names the growth
  // itself instead of pointing at shard verdicts that do not exist.
  expect(res.stdout).toContain("(log growth since signing explains it)");
  expect(res.stdout).not.toContain("no shard above explains it");
});

test("an appended shard does not hide ledger drift elsewhere", async () => {
  append(2);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  append(1);
  // Real drift in another inventoried directory, beside the append.
  mkdirSync(join(vault, "Brain", "metrics"), { recursive: true });
  writeFileSync(join(vault, "Brain", "metrics", "surface-a.tester.jsonl"), "{}\n", "utf8");
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stdout).toContain("store digest differs");
});

test("a store-digest drift no appended shard explains exits one", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // An inventoried ledger directory gains a file the log shards know
  // nothing about: every shard stays intact, the signature stays valid,
  // and only the store digest moves - damage the shard report cannot
  // name, which is exactly what this exit code exists to report.
  mkdirSync(join(vault, "Brain", "metrics"), { recursive: true });
  writeFileSync(join(vault, "Brain", "metrics", "surface-a.tester.jsonl"), "{}\n", "utf8");
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stdout).toContain("store digest differs");
  expect(res.stdout).toContain("no shard above explains it");
});

test("verify --public-key verifies against exactly the named exported half", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  const exported = join(vault, ".open-second-brain", "keys", "attestation", "attestation.pub");
  const outside = join(tmp, "operator-copy.pub");
  writeFileSync(outside, readFileSync(exported, "utf8"), "utf8");
  rmSync(exported);

  // The named half verifies the record even though the vault no longer
  // carries an export.
  const named = await runCli([
    "brain",
    "attest",
    "verify",
    "--vault",
    vault,
    "--public-key",
    outside,
  ]);
  expect(named.returncode).toBe(0);

  // A named half that does not exist is an invalid signature, never a
  // silent fall back.
  const missing = await runCli([
    "brain",
    "attest",
    "verify",
    "--vault",
    vault,
    "--public-key",
    join(tmp, "never-was.pub"),
  ]);
  expect(missing.returncode).toBe(1);

  // The operator CLI's own run may still derive the public half from the
  // local seed when the export is lost - the operator's machine, the
  // operator's key.
  const local = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(local.returncode).toBe(0);
});

test("list reports a record that cannot be read on its own row and still lists the rest", async () => {
  append(2);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  writeFileSync(
    join(vault, ".open-second-brain", "attestations", "attest-20990101T000000000Z.json"),
    "{not json at all",
    "utf8",
  );
  const list = await runCli(["brain", "attest", "list", "--vault", vault]);
  expect(list.returncode).toBe(0);
  expect(list.stdout).toContain("UNREADABLE");
  expect(list.stdout).toContain("attest-20990101T000000000Z.json");
  expect(list.stdout).toContain("corrupted JSON");

  const asJson = await runCli(["brain", "attest", "list", "--vault", vault, "--json"]);
  expect(asJson.returncode).toBe(0);
  const parsed = JSON.parse(asJson.stdout) as {
    attestations: unknown[];
    unreadable: Array<Record<string, string>>;
  };
  expect(parsed.attestations).toHaveLength(1);
  expect(parsed.unreadable).toHaveLength(1);
  expect(parsed.unreadable[0]!["reason"]).toContain("corrupted JSON");
});

test("verify with nothing signed says so and exits zero", async () => {
  append(1);
  const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(res.returncode).toBe(0);
  expect(res.stdout).toMatch(/no attestation|nothing to verify/i);
});

test("a store that cannot be measured reads as its own fact, not as damage", async () => {
  append(3);
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // A log lock held past the collector's bounded retry: the manifest
  // cannot be recomputed. The shard walk and the signature still ran,
  // so the report names what it knows and words the unknown as unknown.
  const release = acquireLogLock(brainDirs(vault).log);
  try {
    const res = await runCli(["brain", "attest", "verify", "--vault", vault]);
    expect(res.returncode).toBe(1);
    expect(res.stdout).toContain("could not be measured");
    expect(res.stdout).toContain("re-run");
    expect(res.stdout).not.toContain("diverged");
  } finally {
    release();
  }
}, 30_000);

test("a twin that predates its JSONL, and a JSONL whose twin never lands, are both growth", async () => {
  append(2);
  // A markdown day file with no JSONL yet (a legacy md-only day): it
  // joins the attested inventory with no chain head to attest.
  writeFileSync(join(vault, "Brain", "log", "2026-06-04.md"), "a markdown-only day\n", "utf8");
  await runCli(["brain", "attest", "keygen", "--vault", vault]);
  await runCli(["brain", "attest", "sign", "--vault", vault]);
  // The day then gains its JSONL: a new attested shard whose twin was
  // already in the inventory - the set reading, not a doubled list.
  appendLogEvent(
    vault,
    {
      timestamp: "2026-06-04T10:00:00Z",
      eventType: "note",
      body: { text: "the md-only day gains its sidecar", agent: "@tester" },
    },
    { deviceId: "" },
  );
  const lateTwin = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(lateTwin.returncode).toBe(0);

  // A new JSONL shard whose markdown twin never landed (the appender's
  // own partial-failure shape): growth with a missing twin is not drift.
  appendLogEvent(
    vault,
    {
      timestamp: "2026-06-05T10:00:00Z",
      eventType: "note",
      body: { text: "the next day", agent: "@tester" },
    },
    { deviceId: "" },
  );
  rmSync(join(vault, "Brain", "log", "2026-06-05.md"));
  const noTwin = await runCli(["brain", "attest", "verify", "--vault", vault]);
  expect(noTwin.returncode).toBe(0);
});

test("usage errors exit two and the usage line names every verb", async () => {
  const bare = await runCli(["brain", "attest"]);
  expect(bare.returncode).toBe(2);
  expect(bare.stdout).toContain("keygen");
  expect(bare.stdout).toContain("verify");
  const unknown = await runCli(["brain", "attest", "frobnicate", "--vault", vault]);
  expect(unknown.returncode).toBe(2);
  expect(unknown.stderr).toContain("frobnicate");
  expect(unknown.stderr).toContain("keygen");
  // `brain attest --help` is answered by the shared VERB_HELP table, not
  // by this dispatcher, and is the help surface's row to pin.
});

test("json shapes: keygen paths, sign record, list rows, verify K4", async () => {
  append(2);
  const keygen = await runCli(["brain", "attest", "keygen", "--vault", vault, "--json"]);
  expect(keygen.returncode).toBe(0);
  const keygenJson = JSON.parse(keygen.stdout);
  expect(keygenJson.private_path).toContain("attestation.key");
  expect(keygenJson.public_path).toContain("attestation.pub");

  const signed = await runCli(["brain", "attest", "sign", "--vault", vault, "--json"]);
  expect(signed.returncode).toBe(0);
  const signJson = JSON.parse(signed.stdout);
  expect(signJson.id).toMatch(/^attest-\d{8}T\d{6}\d{3}Z$/);
  expect(signJson.path).toContain("attestations");
  expect(typeof signJson.store_digest).toBe("string");

  const list = await runCli(["brain", "attest", "list", "--vault", vault, "--json"]);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.attestations).toHaveLength(1);
  expect(listJson.attestations[0].id).toBe(signJson.id);
  expect(typeof listJson.attestations[0].created_at).toBe("string");

  const verified = await runCli(["brain", "attest", "verify", "--vault", vault, "--json"]);
  expect(verified.returncode).toBe(0);
  const verifyJson = JSON.parse(verified.stdout);
  // The K4 AttestationVerification shape, field for field.
  expect(verifyJson.recordId).toBe(signJson.id);
  expect(verifyJson.signatureValid).toBe(true);
  expect(Array.isArray(verifyJson.shards)).toBe(true);
  expect(verifyJson.shards[0].shardId).toBe("2026-06-03.jsonl");
  expect(verifyJson.shards[0].state).toBe("intact");
  expect(verifyJson.storeDigestMatches).toBe(true);
});

// Each of these three rungs boots two cold CLIs (bun startup, the full
// import graph, Ed25519 keygen and sign), which the 5 s default does not
// leave headroom for in CI; the plugin suite's hung-shim test carries the
// same explicit bound.
test("passphrase ladder: wrap at keygen, sign from stdin in a fresh process", async () => {
  append(1);
  const first = await runCli(["brain", "attest", "keygen", "--vault", vault], {
    stdin: `${STDIN_PASSPHRASE}\n`,
    subprocess: true,
  });
  expect(first.returncode).toBe(0);
  const keyBytes = readFileSync(
    join(vault, ".open-second-brain", "keys", "attestation", "attestation.key"),
    "utf8",
  );
  expect(keyBytes).not.toMatch(/^[0-9a-f]{64}\s*$/); // wrapped, not raw seed

  const signed = await runCli(["brain", "attest", "sign", "--vault", vault], {
    stdin: `${STDIN_PASSPHRASE}\n`,
    subprocess: true,
  });
  expect(signed.returncode).toBe(0);
  expect(recordFiles()).toHaveLength(1);
}, 30_000);

test("passphrase ladder: a wrapped key with no source refuses by name", async () => {
  append(1);
  await runCli(["brain", "attest", "keygen", "--vault", vault], {
    stdin: `${STDIN_PASSPHRASE_ALT}\n`,
    subprocess: true,
  });
  const res = await runCli(["brain", "attest", "sign", "--vault", vault], { subprocess: true });
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("passphrase");
  expect(recordFiles()).toEqual([]);
}, 30_000);

test("passphrase ladder: --passphrase-from-env with an unset variable exits two", async () => {
  const res = await runCli(
    ["brain", "attest", "keygen", "--vault", vault, "--passphrase-from-env", "O2B_ATTEST_MISSING"],
    {
      env: { O2B_ATTEST_MISSING: "" },
      subprocess: true,
    },
  );
  expect(res.returncode).toBe(2);
  expect(res.stderr).toContain("O2B_ATTEST_MISSING");
  expect(res.stderr).toContain("stdin");
});

test("passphrase ladder: --passphrase-from-env with a set variable wraps and signs", async () => {
  append(1);
  const keygen = await runCli(
    ["brain", "attest", "keygen", "--vault", vault, "--passphrase-from-env", "O2B_ATTEST_PASS"],
    { env: { O2B_ATTEST_PASS: ENV_ROUTE_PASSPHRASE }, subprocess: true },
  );
  expect(keygen.returncode).toBe(0);
  const signed = await runCli(
    ["brain", "attest", "sign", "--vault", vault, "--passphrase-from-env", "O2B_ATTEST_PASS"],
    { env: { O2B_ATTEST_PASS: ENV_ROUTE_PASSPHRASE }, subprocess: true },
  );
  expect(signed.returncode).toBe(0);
  expect(recordFiles()).toHaveLength(1);
}, 30_000);
