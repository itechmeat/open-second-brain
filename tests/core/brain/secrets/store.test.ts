/**
 * Capability-gated secret custody store (t_0b134404, part 1):
 * per-value AES-256-GCM ciphertext under the vault-local state dir
 * with a 0600 keyfile, set/list/rm surface that never returns
 * plaintext, fail-closed tamper detection, and a no-values audit
 * trail in Brain/log/secret-custody/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { loadOrCreateKey } from "../../../../src/core/brain/secrets/crypto.ts";
import {
  clearHeldKey,
  heldUnlockedKey,
  isEnvelopeFile,
  SecretStoreKeyfileMissingError,
  SecretStoreLockedError,
  unlockKeyfile,
  wrapKeyfile,
} from "../../../../src/core/brain/secrets/envelope.ts";
import {
  listSecrets,
  removeSecret,
  resolveSecretForExec,
  resolveSecretReadOnly,
  setSecret,
  secretsDir,
  unlockSecretKeyfile,
} from "../../../../src/core/brain/secrets/store.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";

const NOW = new Date("2026-06-05T10:00:00Z");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-secrets-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function set(name = "embed-key", value = "sk-super-secret-value"): void {
  setSecret(vault, {
    name,
    value,
    envVar: "EMBED_API_KEY",
    allow: ["curl *"],
    agent: "tester",
    now: NOW,
  });
}

describe("setSecret / listSecrets / removeSecret", () => {
  test("set + list round-trips metadata and never the value", () => {
    set();
    const secrets = listSecrets(vault);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      name: "embed-key",
      env_var: "EMBED_API_KEY",
      allow: ["curl *"],
      created_at: "2026-06-05T10:00:00Z",
    });
    expect(JSON.stringify(secrets)).not.toContain("sk-super-secret-value");
  });

  test("the value is encrypted at rest and the keyfile is 0600", () => {
    set();
    const dir = secretsDir(vault);
    const storeRaw = readFileSync(join(dir, "secrets.json"), "utf8");
    expect(storeRaw).not.toContain("sk-super-secret-value");
    // Windows has no POSIX mode bits (stat reports 0o666 for any writable
    // file); access there is an owner-only ACL, pinned in owner-acl.test.ts.
    if (IS_WINDOWS) return;
    const keyMode = statSync(join(dir, "keyfile")).mode & 0o777;
    expect(keyMode).toBe(0o600);
    const storeMode = statSync(join(dir, "secrets.json")).mode & 0o777;
    expect(storeMode).toBe(0o600);
  });

  test("resolveSecretForExec decrypts; tampered ciphertext fails closed", () => {
    set();
    expect(resolveSecretForExec(vault, "embed-key").value).toBe("sk-super-secret-value");

    const storePath = join(secretsDir(vault), "secrets.json");
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as {
      secrets: Record<string, { ciphertext: string }>;
    };
    const ct = Buffer.from(parsed.secrets["embed-key"]!.ciphertext, "base64");
    ct[0] = ct[0]! ^ 0xff;
    parsed.secrets["embed-key"]!.ciphertext = ct.toString("base64");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(storePath, JSON.stringify(parsed));
    expect(() => resolveSecretForExec(vault, "embed-key")).toThrow();
  });

  test("an unknown name fails without enumerating the stored set (t_sec_secret_names)", () => {
    set();
    // The name inventory is `list`'s job, metadata only, by design; an
    // error path that hands the same inventory to any caller that can
    // spell a wrong name would give it away for nothing.
    expect(() => resolveSecretForExec(vault, "ghost")).toThrow(/unknown secret "ghost"/);
    expect(() => resolveSecretForExec(vault, "ghost")).not.toThrow(/embed-key/);
  });

  test("removeSecret deletes the entry; the value is unrecoverable", () => {
    set();
    expect(removeSecret(vault, "embed-key", { agent: "tester", now: NOW })).toBe(true);
    expect(listSecrets(vault)).toHaveLength(0);
    expect(removeSecret(vault, "embed-key", { agent: "tester", now: NOW })).toBe(false);
  });

  test("set validates the name and refuses empty values", () => {
    expect(() =>
      setSecret(vault, { name: "bad name!", value: "x", agent: "tester", now: NOW }),
    ).toThrow(/name/);
    expect(() =>
      setSecret(vault, { name: "ok-name", value: "  ", agent: "tester", now: NOW }),
    ).toThrow(/value/);
  });

  test("every operation lands a no-values audit record", () => {
    set();
    resolveSecretForExec(vault, "embed-key");
    removeSecret(vault, "embed-key", { agent: "tester", now: NOW });
    const auditDir = join(vault, "Brain", "log", "secret-custody");
    const files = readdirSync(auditDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const lines = files
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { action: string });
    const actions = lines.map((l) => l.action);
    expect(actions).toContain("secret_set");
    expect(actions).toContain("secret_resolved_for_exec");
    expect(actions).toContain("secret_removed");
    expect(JSON.stringify(lines)).not.toContain("sk-super-secret-value");
  });
});

describe("a wrapped store (t_e6667a56)", () => {
  const PASSPHRASE = fakeCredential("store-wrap", "-phrase-", "42");

  function wrap(): string {
    const keyPath = join(secretsDir(vault), "keyfile");
    wrapKeyfile(keyPath, PASSPHRASE, loadOrCreateKey(keyPath));
    return keyPath;
  }

  test("metadata stays readable while locked; every key-bearing op refuses by name", () => {
    set();
    const keyPath = wrap();
    expect(listSecrets(vault)).toHaveLength(1);
    expect(() =>
      setSecret(vault, { name: "second", value: "v", agent: "tester", now: NOW }),
    ).toThrow(SecretStoreLockedError);
    expect(() => resolveSecretForExec(vault, "embed-key")).toThrow(SecretStoreLockedError);
    expect(() => resolveSecretReadOnly(vault, "embed-key")).toThrow(SecretStoreLockedError);
    expect(() => removeSecret(vault, "embed-key", { agent: "tester", now: NOW })).toThrow(
      SecretStoreLockedError,
    );
    // Cleanup: the holder stays empty; clear is a no-op but explicit.
    clearHeldKey(keyPath);
  });

  test("an unknown name fails without enumerating the stored set, even while locked", () => {
    set();
    wrap();
    expect(() => resolveSecretReadOnly(vault, "ghost")).toThrow(/unknown secret "ghost"/);
    expect(() => resolveSecretReadOnly(vault, "ghost")).not.toThrow(/embed-key/);
  });

  test("the read-only resolve decrypts without the last_used_at stamp or an exec audit record", () => {
    set();
    expect(resolveSecretReadOnly(vault, "embed-key").value).toBe("sk-super-secret-value");
    const storeRaw = readFileSync(join(secretsDir(vault), "secrets.json"), "utf8");
    expect(storeRaw).toContain('"last_used_at": null');
    const auditDir = join(vault, "Brain", "log", "secret-custody");
    const actions = readdirSync(auditDir)
      .flatMap((f) => readFileSync(join(auditDir, f), "utf8").split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { action: string }).action);
    expect(actions).not.toContain("secret_resolved_for_exec");
  });

  test("after unlock the held key serves both resolves; only the exec resolve stamps", () => {
    set();
    const keyPath = wrap();
    unlockKeyfile(keyPath, PASSPHRASE);
    expect(resolveSecretReadOnly(vault, "embed-key").value).toBe("sk-super-secret-value");
    const unstamped = readFileSync(join(secretsDir(vault), "secrets.json"), "utf8");
    expect(unstamped).toContain('"last_used_at": null');
    expect(resolveSecretForExec(vault, "embed-key").value).toBe("sk-super-secret-value");
    const stamped = readFileSync(join(secretsDir(vault), "secrets.json"), "utf8");
    expect(stamped).not.toContain('"last_used_at": null');
    clearHeldKey(keyPath);
  });
});

describe("unlock/lock lifecycle", () => {
  const PASSPHRASE = fakeCredential("lifecycle-wrap-", "phrase-3f08");

  test("the FIRST unlock on a raw keyfile leaves this process unlocked", () => {
    // The wrap-on-first-unlock writes the envelope but used to hold
    // nothing: the same process - the one the verb's success note
    // addresses, and the one the locked-store remedy sends to `unlock` -
    // still read as locked afterwards.
    set();
    unlockSecretKeyfile(vault, PASSPHRASE, { agent: "tester", now: NOW });
    const keyPath = join(secretsDir(vault), "keyfile");
    expect(isEnvelopeFile(keyPath)).toBe(true);
    expect(heldUnlockedKey(keyPath)).not.toBeNull();
    expect(resolveSecretReadOnly(vault, "embed-key").value).toBe("sk-super-secret-value");
    clearHeldKey(keyPath);
  });

  test("the first-unlock wrap holds the store writer lock", () => {
    // Every other read-modify-write of the custody directory serialises
    // through the writer lock; the wrap that replaces the only copy of
    // the DEK must too, so two racers cannot interleave on the shared
    // tmp path. Holding the lock the way a concurrent first unlock
    // would, the wrap refuses instead of proceeding.
    set();
    const release = lockfile.lockSync(secretsDir(vault), { stale: 10_000, realpath: false });
    try {
      expect(() => unlockSecretKeyfile(vault, PASSPHRASE, { agent: "tester", now: NOW })).toThrow(
        /secrets store lock/,
      );
      expect(isEnvelopeFile(join(secretsDir(vault), "keyfile"))).toBe(false);
    } finally {
      void release();
    }
    // With the lock free, the same call wraps AND unlocks this process.
    unlockSecretKeyfile(vault, PASSPHRASE, { agent: "tester", now: NOW });
    expect(isEnvelopeFile(join(secretsDir(vault), "keyfile"))).toBe(true);
    clearHeldKey(join(secretsDir(vault), "keyfile"));
  });

  test("a second unlock over the winner's envelope unlocks instead of failing locked", () => {
    // The shape check re-runs UNDER the writer lock, so the loser of a
    // wrap race - the keyfile it saw as raw is an envelope by the time it
    // holds the lock - takes the unlock path with its own passphrase check
    // rather than minting over the winner's envelope or refusing it
    // locked. Sequenced here as the second of two awaited unlocks: the
    // interleaving itself is pinned by the writer-lock test above.
    set();
    unlockSecretKeyfile(vault, PASSPHRASE, { agent: "tester", now: NOW });
    // A second unlock over the now-wrapped store with the SAME
    // passphrase succeeds and keeps the same key held.
    unlockSecretKeyfile(vault, PASSPHRASE, { agent: "tester", now: NOW });
    const keyPath = join(secretsDir(vault), "keyfile");
    expect(resolveSecretReadOnly(vault, "embed-key").value).toBe("sk-super-secret-value");
    clearHeldKey(keyPath);
  });

  test("the locked-store refusal names the remedy without the keyfile path", () => {
    // The refusal travels into model context through consumers that
    // surface error prose (a config-probe error list, a search refusal);
    // the path under the vault is exactly what
    // `src/mcp/vault-path-field.ts` degrades to keep out. The remedy is
    // named; the structured `keyPath` field stays for the callers that
    // may name it.
    set();
    const keyPath = join(secretsDir(vault), "keyfile");
    wrapKeyfile(keyPath, PASSPHRASE, loadOrCreateKey(keyPath));
    try {
      let refusal: unknown;
      try {
        resolveSecretReadOnly(vault, "embed-key");
        throw new Error("expected the locked-store refusal");
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(SecretStoreLockedError);
      const message = (refusal as Error).message;
      expect(message).not.toContain(keyPath);
      expect(message).toContain("o2b brain secret unlock");
    } finally {
      clearHeldKey(keyPath);
    }
  });

  test("a missing keyfile over held entries refuses by name instead of minting", () => {
    // The read-only resolve composes loadOrCreateKey, which CREATES a fresh
    // key on first use. Over a store that still holds entries, that mint
    // silently orphaned every stored value - the resolve answered a raw
    // cipher error and left a new keyfile on disk, with nothing naming the
    // destruction. The named refusal is the locked refusal's sibling state,
    // and it must be equally path-free in the prose that travels into model
    // context.
    set();
    const keyPath = join(secretsDir(vault), "keyfile");
    const storeBefore = readFileSync(join(secretsDir(vault), "secrets.json"), "utf8");
    rmSync(keyPath);
    let refusal: unknown;
    try {
      resolveSecretReadOnly(vault, "embed-key");
      throw new Error("expected the missing-keyfile refusal");
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(SecretStoreKeyfileMissingError);
    expect((refusal as { code: string }).code).toBe("secret_store_keyfile_missing");
    const message = (refusal as Error).message;
    expect(message).not.toContain(keyPath);
    // The refusal left no custody state behind: no keyfile was minted, and
    // the stored ciphertext is exactly as it was.
    expect(existsSync(keyPath)).toBe(false);
    expect(readFileSync(join(secretsDir(vault), "secrets.json"), "utf8")).toBe(storeBefore);
  });
});
