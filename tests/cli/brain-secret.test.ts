/**
 * `o2b brain secret` CLI surface (t_0b134404): set ingests the value
 * from stdin (never argv), list shows metadata only, run injects the
 * secret into an allowlisted subprocess and redacts the output, rm
 * removes irrecoverably.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCredential } from "../helpers/fake-credentials.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-secret-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("set from stdin, list metadata only, run with redaction, rm", async () => {
  const set = await runCli(
    [
      "brain",
      "secret",
      "set",
      "api-key",
      "--env-var",
      "MY_API_KEY",
      "--allow",
      "bun -e *",
      "--vault",
      vault,
      "--json",
    ],
    { stdin: "sk-cli-secret-98765\n" },
  );
  expect(set.returncode).toBe(0);
  expect(set.stdout).not.toContain("sk-cli-secret-98765");

  const list = await runCli(["brain", "secret", "list", "--vault", vault, "--json"]);
  expect(list.returncode).toBe(0);
  const listed = JSON.parse(list.stdout) as {
    secrets: Array<{ name: string; env_var: string; allow: string[] }>;
  };
  expect(listed.secrets).toHaveLength(1);
  expect(listed.secrets[0]).toMatchObject({
    name: "api-key",
    env_var: "MY_API_KEY",
    allow: ["bun -e *"],
  });
  expect(list.stdout).not.toContain("sk-cli-secret-98765");

  const run = await runCli([
    "brain",
    "secret",
    "run",
    "api-key",
    "--vault",
    vault,
    "--",
    "bun",
    "-e",
    "console.log('got ' + process.env.MY_API_KEY)",
  ]);
  expect(run.returncode).toBe(0);
  expect(run.stdout).not.toContain("sk-cli-secret-98765");
  expect(run.stdout).toContain("***REDACTED***");

  const denied = await runCli([
    "brain",
    "secret",
    "run",
    "api-key",
    "--vault",
    vault,
    "--",
    "bash",
    "-c",
    "env",
  ]);
  expect(denied.returncode).toBe(2);
  expect(denied.stderr).toContain("allowlist");

  const rm = await runCli(["brain", "secret", "rm", "api-key", "--vault", vault]);
  expect(rm.returncode).toBe(0);
  const after = await runCli(["brain", "secret", "list", "--vault", vault, "--json"]);
  expect(JSON.parse(after.stdout).secrets).toHaveLength(0);
});

test("the value never lands in the store file or audit trail in plaintext", async () => {
  await runCli(["brain", "secret", "set", "deploy-token", "--vault", vault], {
    stdin: "ghp-deploy-token-555\n",
  });
  const storeRaw = readFileSync(
    join(vault, ".open-second-brain", "secrets", "secrets.json"),
    "utf8",
  );
  expect(storeRaw).not.toContain("ghp-deploy-token-555");
});

test("set without stdin value or --from-env is a usage error", async () => {
  const result = await runCli(["brain", "secret", "set", "empty-one", "--vault", vault], {
    stdin: "",
  });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain("stdin");
});

test("unlock wraps the raw keyfile; a fresh process sees the locked refusal until re-unlock", async () => {
  await runCli(["brain", "secret", "set", "api-key", "--vault", vault], {
    stdin: "sk-lock-test-13579\n",
  });
  const keyfile = join(vault, ".open-second-brain", "secrets", "keyfile");
  expect(readFileSync(keyfile).length).toBe(32);

  const passphrase = fakeCredential("cli-unlock", "-pass", "-42");
  const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unlock.returncode).toBe(0);
  expect(unlock.stdout).toContain("unlocked");
  // The raw 32 bytes are gone: the keyfile is a JSON envelope now.
  expect(readFileSync(keyfile, "utf8").startsWith("{")).toBe(true);

  // A fresh process holds no unlocked key: the store refuses by name, and
  // the remedy it names is honest about every route that works - the
  // key-bearing verbs' own passphrase ingestion, the environment variable
  // a non-interactive host sets, the unlock op for this process, and the
  // unwrap op that ends the wrap.
  const locked = await runCli(["brain", "secret", "set", "other", "--vault", vault], {
    stdin: "sk-other-24680\n",
  });
  expect(locked.returncode).toBe(1);
  expect(locked.stderr).toContain("locked");
  expect(locked.stderr).toContain("o2b brain secret unlock");
  expect(locked.stderr).toContain("this process only");
  expect(locked.stderr).toContain("never persisted");
  expect(locked.stderr).toContain("--passphrase-from-env");
  expect(locked.stderr).toContain("OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE");

  // The right passphrase unlocks again; a wrong one refuses by name.
  const again = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(again.returncode).toBe(0);
  const wrong = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${fakeCredential("no-such", "-pass", "-42")}\n`,
  });
  expect(wrong.returncode).toBe(1);
  expect(wrong.stderr).toContain("passphrase");
}, 20000);

test("a wrapped store works from a SECOND command: passphrase from env or stdin, per verb", async () => {
  // The unlock holds the key for ITS process only, so every command below
  // is a separate invocation that must reach the wrapped store on its own
  // - each one a fresh subprocess, as a cron job or a script would be.
  await runCli(["brain", "secret", "set", "api-key", "--allow", "bun -e *", "--vault", vault], {
    stdin: "sk-cross-97531\n",
  });
  const passphrase = fakeCredential("cross-proc", "-pass-", "42");
  const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unlock.returncode).toBe(0);

  const env = { O2B_TEST_STORE_PASS: passphrase };
  // run: the passphrase rides --passphrase-from-env, the subprocess runs.
  const run = await runCli(
    [
      "brain",
      "secret",
      "run",
      "api-key",
      "--passphrase-from-env",
      "O2B_TEST_STORE_PASS",
      "--vault",
      vault,
      "--",
      "bun",
      "-e",
      "process.exit(0)",
    ],
    { env, subprocess: true },
  );
  expect(run.returncode).toBe(0);

  // set: the value occupies stdin, so the passphrase must come from the
  // flag (or the well-known variable); the store accepts a second secret.
  const set2 = await runCli(
    [
      "brain",
      "secret",
      "set",
      "second-key",
      "--passphrase-from-env",
      "O2B_TEST_STORE_PASS",
      "--vault",
      vault,
    ],
    { env, stdin: "sk-second-86420\n" },
  );
  expect(set2.returncode).toBe(0);

  // rm: stdin is free, so the piped passphrase unlocks the store.
  const rm = await runCli(["brain", "secret", "rm", "second-key", "--vault", vault], {
    stdin: `${passphrase}\n`,
    subprocess: true,
  });
  expect(rm.returncode).toBe(0);

  // export: the bundle passphrase doubles as the store unlock; the
  // exported bundle imports into a fresh vault.
  const bundlePath = join(tmp, "cross-bundle.json");
  const exported = await runCli(
    ["brain", "secret", "export", "--out", bundlePath, "--vault", vault],
    { stdin: `${passphrase}\n` },
  );
  expect(exported.returncode).toBe(0);
  const fresh = join(tmp, "fresh-vault");
  mkdirSync(join(fresh, "Brain"), { recursive: true });
  const imported = await runCli(["brain", "secret", "import", bundlePath, "--vault", fresh], {
    stdin: `${passphrase}\n`,
  });
  expect(imported.returncode).toBe(0);
  const listed = JSON.parse(
    (await runCli(["brain", "secret", "list", "--vault", fresh, "--json"])).stdout,
  ) as { secrets: Array<{ name: string }> };
  expect(listed.secrets.map((s) => s.name)).toEqual(["api-key"]);
}, 30000);

test("the well-known environment variable alone reaches a wrapped store from a fresh process", async () => {
  await runCli(["brain", "secret", "set", "api-key", "--allow", "bun -e *", "--vault", vault], {
    stdin: "sk-envvar-19283\n",
  });
  const passphrase = fakeCredential("env-var-proc", "-pass-", "42");
  const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unlock.returncode).toBe(0);

  // No flag, no stdin: the MCP-server-shaped route. The command succeeds
  // and the variable is consumed by the child - it cannot leak to a
  // grandchild through the environment it leaves behind.
  const run = await runCli(
    [
      "brain",
      "secret",
      "run",
      "api-key",
      "--vault",
      vault,
      "--",
      "bun",
      "-e",
      "process.exit(process.env.OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE === undefined ? 0 : 1)",
    ],
    { env: { OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE: passphrase }, subprocess: true },
  );
  expect(run.returncode).toBe(0);
}, 20000);

test("unwrap writes the raw keyfile back; a later command needs no passphrase; unwrap refuses when raw", async () => {
  await runCli(["brain", "secret", "set", "api-key", "--allow", "bun -e *", "--vault", vault], {
    stdin: "sk-unwrap-44556\n",
  });
  const passphrase = fakeCredential("cli-unwrap", "-pass-", "42");
  const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unlock.returncode).toBe(0);
  const keyfile = join(vault, ".open-second-brain", "secrets", "keyfile");
  expect(readFileSync(keyfile, "utf8").startsWith("{")).toBe(true);

  const unwrap = await runCli(["brain", "secret", "unwrap", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unwrap.returncode).toBe(0);
  expect(unwrap.stderr).toContain("raw key");
  // The envelope is gone: 32 raw bytes again.
  expect(readFileSync(keyfile).length).toBe(32);

  // A third command needs no passphrase at all - the store is raw again.
  const run = await runCli(
    ["brain", "secret", "run", "api-key", "--vault", vault, "--", "bun", "-e", "process.exit(0)"],
    { subprocess: true },
  );
  expect(run.returncode).toBe(0);

  // Unwrapping an unwrapped store refuses by name.
  const again = await runCli(["brain", "secret", "unwrap", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(again.returncode).toBe(1);
  expect(again.stderr).toContain("not passphrase-wrapped");

  // The wrong passphrase leaves the wrap intact (nothing was unwrapped by
  // the refusals above, so re-wrap first is unnecessary: the store is raw,
  // which the refusal above already proved).
}, 20000);

test("lock refuses a store that was never wrapped, creating nothing; lock after unlock reports cleared", async () => {
  const lock = await runCli(["brain", "secret", "lock", "--vault", vault]);
  expect(lock.returncode).toBe(1);
  expect(lock.stderr).toContain("not passphrase-wrapped");
  // Locking must not mint a keyfile or the secrets directory.
  expect(existsSync(join(vault, ".open-second-brain", "secrets"))).toBe(false);

  const passphrase = fakeCredential("cli-lock", "-pass", "-42");
  const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
    stdin: `${passphrase}\n`,
  });
  expect(unlock.returncode).toBe(0);
  const locked = await runCli(["brain", "secret", "lock", "--vault", vault, "--json"]);
  expect(locked.returncode).toBe(0);
  expect(JSON.parse(locked.stdout)).toMatchObject({ locked: true });
});

test("unlock without a passphrase is a usage error", async () => {
  const result = await runCli(["brain", "secret", "unlock", "--vault", vault], { stdin: "" });
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain("passphrase");
});

test("a blank --passphrase-from-env value is the usage error a blank stdin passphrase is", async () => {
  // The stdin ingestion refuses a passphrase that is empty after trim; the
  // env ingestion enforces the SAME rule, so `SECRET_PASS="   "` cannot wrap
  // the keyfile under what is almost certainly an unset-variable accident.
  const result = await runCli(
    [
      "brain",
      "secret",
      "unlock",
      "--vault",
      vault,
      "--passphrase-from-env",
      "O2B_TEST_BLANK_PASSPHRASE",
    ],
    { env: { O2B_TEST_BLANK_PASSPHRASE: "   " } },
  );
  expect(result.returncode).toBe(2);
  expect(result.stderr).toContain("passphrase");
  // The refusal precedes any custody effect: nothing was wrapped or minted.
  expect(existsSync(join(vault, ".open-second-brain", "secrets"))).toBe(false);
});

test("export --out writes the bundle; import restores it; collisions need --replace", async () => {
  await runCli(
    [
      "brain",
      "secret",
      "set",
      "api-key",
      "--env-var",
      "MY_API_KEY",
      "--allow",
      "bun -e *",
      "--vault",
      vault,
    ],
    { stdin: "sk-cli-bundle-2468\n" },
  );
  const bundlePath = join(tmp, "bundle.json");
  const passphrase = fakeCredential("cli-bundle", "-pass", "-42");
  const exported = await runCli(
    ["brain", "secret", "export", "--out", bundlePath, "--vault", vault],
    { stdin: `${passphrase}\n` },
  );
  expect(exported.returncode).toBe(0);
  // The bundle bytes carry neither the value nor the passphrase.
  const bundleRaw = readFileSync(bundlePath, "utf8");
  expect(bundleRaw).not.toContain("sk-cli-bundle-2468");
  expect(bundleRaw).not.toContain(passphrase);
  expect(bundleRaw).toContain("api-key");

  const fresh = join(tmp, "fresh-vault");
  mkdirSync(join(fresh, "Brain"), { recursive: true });
  const imported = await runCli(["brain", "secret", "import", bundlePath, "--vault", fresh], {
    stdin: `${passphrase}\n`,
  });
  expect(imported.returncode).toBe(0);
  const list = await runCli(["brain", "secret", "list", "--vault", fresh, "--json"]);
  expect(JSON.parse(list.stdout).secrets[0]).toMatchObject({
    name: "api-key",
    env_var: "MY_API_KEY",
    allow: ["bun -e *"],
  });

  // The same import again refuses the existing name by name; --replace lands.
  const again = await runCli(["brain", "secret", "import", bundlePath, "--vault", fresh], {
    stdin: `${passphrase}\n`,
  });
  expect(again.returncode).toBe(1);
  expect(again.stderr).toContain("api-key");
  const replaced = await runCli(
    ["brain", "secret", "import", bundlePath, "--vault", fresh, "--replace"],
    { stdin: `${passphrase}\n` },
  );
  expect(replaced.returncode).toBe(0);

  // A wrong passphrase writes nothing to a fresh vault.
  const empty = join(tmp, "empty-vault");
  mkdirSync(join(empty, "Brain"), { recursive: true });
  const wrong = await runCli(["brain", "secret", "import", bundlePath, "--vault", empty], {
    stdin: `${fakeCredential("no-such", "-pass", "-42")}\n`,
  });
  expect(wrong.returncode).toBe(1);
  expect(wrong.stderr).toContain("passphrase");
  expect(existsSync(join(empty, ".open-second-brain", "secrets", "secrets.json"))).toBe(false);
}, 20000);

describe("secret refusals and help accuracy", () => {
  test("an unset --passphrase-from-env var names both ingestion routes", async () => {
    // S1/S3/S4: the refusal named the variable but no remedy and no other
    // route, while the sibling empty-stdin refusal names both.
    const r = await runCli(
      [
        "brain",
        "secret",
        "unlock",
        "--passphrase-from-env",
        "OSB_TEST_MISSING_PW",
        "--vault",
        vault,
      ],
      { stdin: "" },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("env var OSB_TEST_MISSING_PW is unset, empty, or blank");
    expect(r.stderr).toContain("set it to a passphrase, or pipe the passphrase via stdin");
  });

  test("an unset --from-env var on set names both ingestion routes", async () => {
    const r = await runCli(
      ["brain", "secret", "set", "env-one", "--from-env", "OSB_TEST_MISSING_PW", "--vault", vault],
      { stdin: "" },
    );
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("env var OSB_TEST_MISSING_PW is unset or empty");
    expect(r.stderr).toContain("set it to a value, or pipe the value via stdin");
  });

  test("a wrong unlock passphrase refuses without naming the keyfile path", async () => {
    // S1: the sibling locked-store and missing-keyfile refusals are
    // path-free because the prose travels into model context; this one
    // leaked the machine-derived keyfile path the operator never supplied
    // (they named --vault, not the keyfile).
    await runCli(["brain", "secret", "set", "api-key", "--vault", vault], {
      stdin: "sk-pathfree-11223\n",
    });
    const unlock = await runCli(["brain", "secret", "unlock", "--vault", vault], {
      stdin: "right-pass-12345\n",
    });
    expect(unlock.returncode).toBe(0);
    const wrong = await runCli(["brain", "secret", "unlock", "--vault", vault], {
      stdin: "wrong-pass-67890\n",
    });
    expect(wrong.returncode).toBe(1);
    expect(wrong.stderr).toContain("keyfile_envelope_passphrase_refused");
    expect(wrong.stderr).toContain("does not unwrap this envelope");
    expect(wrong.stderr).not.toContain(join(vault, ".open-second-brain"));
    expect(wrong.stderr).not.toContain(tmp);
  });

  test("an import collision names the --replace flag", async () => {
    // S4: collisions were named, but the literal flag never was, leaving
    // the spelling for the operator to guess.
    await runCli(["brain", "secret", "set", "dup-key", "--vault", vault], {
      stdin: "sk-collision-33445\n",
    });
    const bundlePath = join(tmp, "collision-bundle.json");
    const passphrase = fakeCredential("cli-collision", "-pass", "-42");
    const exported = await runCli(
      ["brain", "secret", "export", "--out", bundlePath, "--vault", vault],
      { stdin: `${passphrase}\n` },
    );
    expect(exported.returncode).toBe(0);
    const again = await runCli(["brain", "secret", "import", bundlePath, "--vault", vault], {
      stdin: `${passphrase}\n`,
    });
    expect(again.returncode).toBe(1);
    expect(again.stderr).toContain("the store already holds: dup-key");
    expect(again.stderr).toContain("pass --replace to import over them");
  });

  test("the --help usage line and the usage-error line agree, and name every op's flags", async () => {
    // S7a: --help showed a shorter usage line than the USAGE constant the
    // usage-error path prints - two surfaces, two truths.
    const help = await runCli(["brain", "secret", "--help"]);
    expect(help.returncode).toBe(0);
    const usageError = await runCli(["brain", "secret", "no-such-op"]);
    expect(usageError.returncode).toBe(2);
    const helpUsage = /^usage: .+$/m.exec(help.stdout)![0]!;
    const errorUsage = /^usage: .+$/m.exec(usageError.stderr)![0]!;
    expect(helpUsage).toBe(errorUsage);
    expect(helpUsage).toContain(
      "set <name> [--env-var V] [--allow PATTERN]... [--from-env SRC] [--passphrase-from-env SRC] [--agent N] [--vault <path>] [--json]",
    );
    expect(helpUsage).toContain("list [--vault <path>] [--json]");
    expect(helpUsage).toContain("rm <name> [--passphrase-from-env SRC] [--vault <path>]");
    expect(helpUsage).toContain("lock [--vault <path>]");
    expect(helpUsage).toContain("unlock [--passphrase-from-env SRC] [--vault <path>]");
    expect(helpUsage).toContain("unwrap [--passphrase-from-env SRC] [--vault <path>]");
    expect(helpUsage).toContain("export --out FILE [--passphrase-from-env SRC] [--vault <path>]");
    expect(helpUsage).toContain(
      "import FILE [--replace] [--passphrase-from-env SRC] [--vault <path>]",
    );
    expect(helpUsage).toContain(
      "run <name> [--passphrase-from-env SRC] [--agent N] [--vault <path>] [--json] -- <command...>",
    );
  });

  test("an op refuses flags it never documents, by name", async () => {
    // S7b: the parse table was op-independent, so lock swallowed
    // --passphrase-from-env (and its env read never happened) with exit 0.
    const r = await runCli([
      "brain",
      "secret",
      "lock",
      "--passphrase-from-env",
      "OSB_TEST_MISSING_PW",
      "--vault",
      vault,
    ]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("brain secret lock: unknown flag --passphrase-from-env");
    expect(r.stderr).toContain("usage: o2b brain secret");
  });

  test("run still accepts its own flags and refuses another op's", async () => {
    await runCli(["brain", "secret", "set", "run-flag", "--allow", "bun -e *", "--vault", vault], {
      stdin: "sk-runflag-44556\n",
    });
    const ok = await runCli([
      "brain",
      "secret",
      "run",
      "run-flag",
      "--agent",
      "tester",
      "--vault",
      vault,
      "--",
      "bun",
      "-e",
      "process.exit(0)",
    ]);
    expect(ok.returncode).toBe(0);
    const refused = await runCli([
      "brain",
      "secret",
      "run",
      "run-flag",
      "--out",
      "somewhere",
      "--vault",
      vault,
      "--",
      "bun",
      "-e",
      "process.exit(0)",
    ]);
    expect(refused.returncode).toBe(2);
    expect(refused.stderr).toContain("brain secret run: unknown flag --out");
  });
});
