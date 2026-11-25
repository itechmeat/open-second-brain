import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { cleanupPacked, packCheckout } from "../helpers/packed-install.ts";
import {
  bunInstallError,
  isLocalTarball,
  registrySmoke,
  retryRegistryInstall,
} from "../../scripts/registry-smoke.ts";
import { makeEnvironment } from "../../scripts/scratch-environment.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);
const packed = packCheckout();
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
afterAll(() => cleanupPacked(packed.root));

test("smoke installs local tarball into scratch and runs version and setup plan", async () => {
  const result = await registrySmoke(packed.tarball, version);
  expect(result.version).toBe(version);
  expect(result.setupExitCode).toBe(0);
  expect(result.paths.every((path) => path.startsWith(result.root))).toBe(true);
  expect(existsSync(result.root)).toBe(false);
});

test("scratch install bins precede host paths", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "o2b-scratch-path-test-")));
  try {
    const binDir = join(root, "install-bin");
    const env = makeEnvironment(root, binDir, "bun");
    expect(env.PATH!.split(delimiter).slice(0, 2)).toEqual([binDir, join(root, "bun-bin")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bun missing-version diagnostic is retryable but age policy is not", async () => {
  let clock = 0;
  let attempts = 0;
  const budgets: number[] = [];
  const diagnostic =
    'No version matching "open-second-brain@1.2.3" found for specifier "open-second-brain" (but package exists)';
  await expect(
    retryRegistryInstall(
      (budget) => {
        attempts++;
        budgets.push(budget);
        if (attempts === 1) throw bunInstallError(diagnostic);
        return "installed";
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
  ).resolves.toBe("installed");
  expect(attempts).toBe(2);
  expect(clock).toBe(10_000);
  expect(budgets).toEqual([900_000, 890_000]);

  attempts = 0;
  await expect(
    retryRegistryInstall(() => {
      attempts++;
      throw bunInstallError("No version matching version due to minimum-release-age policy");
    }),
  ).rejects.toThrow("minimum-release-age");
  expect(attempts).toBe(1);
});

test("registry version retry stops at fifteen minutes using the injected clock", async () => {
  let clock = 0;
  let calls = 0;
  await expect(
    retryRegistryInstall(
      async (timeoutMs) => {
        calls++;
        expect(timeoutMs).toBeGreaterThan(0);
        throw Object.assign(new Error("version not found"), { code: "E404" });
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
  ).rejects.toThrow("fifteen minutes");
  expect(clock).toBe(900_000);
  expect(calls).toBe(90);
});

test("registry retry does not start an attempt after the injected deadline", async () => {
  let clock = 0;
  const budgets: number[] = [];
  const missing = Object.assign(new Error("version not found"), { code: "E404" });
  await expect(
    retryRegistryInstall(
      (timeoutMs) => {
        budgets.push(timeoutMs);
        clock += timeoutMs - 1;
        throw missing;
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
  ).rejects.toMatchObject({
    message: "registry version was not served within fifteen minutes",
    cause: missing,
  });
  expect(budgets).toEqual([900_000]);
  expect(clock).toBe(900_000);
});

test("registry version specs ending in .tgz are not treated as local tarballs", () => {
  const root = mkdtempSync(join(tmpdir(), "o2b-tarball-spec-test-"));
  const tarball = join(root, "package.tgz");
  try {
    writeFileSync(tarball, "fixture");
    expect(isLocalTarball("open-second-brain@2.1.0-rc.tgz")).toBe(false);
    expect(isLocalTarball(tarball)).toBe(true);
    expect(isLocalTarball("./missing/package.tgz")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the install timeout is a whole number of milliseconds on a fractional clock", async () => {
  const seen: number[] = [];
  await retryRegistryInstall(
    (timeoutMs) => {
      seen.push(timeoutMs);
      return "installed";
    },
    { now: () => 0.25, sleep: async () => {} },
  );
  expect(seen).toHaveLength(1);
  expect(Number.isInteger(seen[0])).toBe(true);
  expect(seen[0]).toBeGreaterThan(0);
});
