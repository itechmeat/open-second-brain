/**
 * The automatic Brain upgrade settles on a vault that several devices share
 * through a file sync, instead of re-applying on every start.
 *
 * A live vault synced between a Mac (`/Users/<user>/Vault`) and Linux hosts
 * (`/root/vault`, `/srv/vault`, `~/vault`) collected hundreds of
 * `upgrade-*` snapshots: every device rendered `vault_name` in
 * `Brain/_BRAIN.md` from its OWN path basename, saw the synced manual the
 * other device wrote as a pending upgrade, and the start-up self-heal
 * rewrote it back, pre-apply snapshot included. The sync then carried the
 * rewrite to the other device, which did the same.
 *
 * Devices on different releases fought the same way: an older release saw
 * the manual a newer release wrote as a pending upgrade and rewrote it back
 * to its own template. The manual now carries a `template_revision` stamp,
 * and a release never rewrites a manual from a newer revision.
 *
 * Each device is modelled as its own directory; "sync" copies the synced
 * vault content (everything but the device-local snapshots) from one
 * device's copy to the other's, as a file sync would. The newer release is
 * real code: a copy of `src/` whose manual template has one more line and a
 * revision one higher, run in its own process.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainManualPath, snapshotsDir } from "../../../src/core/brain/paths.ts";
import {
  BRAIN_MANUAL_TEMPLATE_REVISION,
  templateRevisionOf,
} from "../../../src/core/brain/templates.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  runSelfHealUpgrade,
  SELF_HEAL_UPGRADE_OUTCOME,
} from "../../../src/core/maintenance/self-heal-upgrade.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let root: string;
let mac: string;
let linux: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-self-heal-synced-"));
  mac = join(root, "mac", "Vault");
  linux = join(root, "linux", "vault");
  mkdirSync(mac, { recursive: true });
  const configPath = join(root, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${mac}\n`);
  prevConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  bootstrapBrain(mac, { configPath });
  sync(mac, linux);
});

afterEach(() => {
  if (prevConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = prevConfigEnv;
  rmSync(root, { recursive: true, force: true });
});

/** Copy the synced vault content from one device's copy to another's. */
function sync(from: string, to: string): void {
  const local = relative(from, snapshotsDir(from));
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      return rel !== local && !rel.startsWith(`${local}${sep}`);
    },
  });
}

function snapshotCount(vault: string): number {
  const dir = snapshotsDir(vault);
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("self-heal upgrade on a vault synced between devices", () => {
  test("devices whose vault directories are named differently do not re-apply", () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 2; round++) {
      outcomes.push(runSelfHealUpgrade(linux).outcome);
      sync(linux, mac);
      outcomes.push(runSelfHealUpgrade(mac).outcome);
      sync(mac, linux);
    }

    expect(outcomes).toEqual(Array(4).fill(SELF_HEAL_UPGRADE_OUTCOME.current));
    expect(snapshotCount(mac)).toBe(0);
    expect(snapshotCount(linux)).toBe(0);
  });
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The line only the newer release's manual template carries. */
const NEWER_TEMPLATE_LINE = "A rule only the newer release ships.";

/**
 * Build a newer release under `dir`: a copy of this release's `src/` whose
 * manual template has one more line and a revision one higher, plus a
 * runner that bootstraps a vault or runs the self-heal upgrade on one.
 * Returns the runner's path.
 */
function buildNewerRelease(dir: string): string {
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  // A junction needs no privilege on Windows; other platforms ignore the type.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "junction");

  const templatesTs = join(dir, "src", "core", "brain", "templates.ts");
  const source = readFileSync(templatesTs, "utf8");
  const bumped = source.replace(
    /BRAIN_MANUAL_TEMPLATE_REVISION = (\d+);/,
    (_m, n: string) => `BRAIN_MANUAL_TEMPLATE_REVISION = ${Number(n) + 1};`,
  );
  if (bumped === source) throw new Error("templates.ts no longer declares the revision");
  writeFileSync(templatesTs, bumped);
  const template = join(dir, "src", "core", "brain", "templates", "_BRAIN.md.tpl");
  writeFileSync(template, `${readFileSync(template, "utf8")}\n${NEWER_TEMPLATE_LINE}\n`);

  const runner = join(dir, "run.ts");
  writeFileSync(
    runner,
    [
      'import { bootstrapBrain } from "./src/core/brain/init.ts";',
      'import { runSelfHealUpgrade } from "./src/core/maintenance/self-heal-upgrade.ts";',
      "const [verb, vault, configPath] = process.argv.slice(2);",
      'if (verb === "bootstrap") bootstrapBrain(vault!, { configPath: configPath! });',
      "else process.stdout.write(runSelfHealUpgrade(vault!).outcome);",
      "",
    ].join("\n"),
  );
  return runner;
}

/** Run the newer release's runner; returns its stdout. */
function runNewer(runner: string, ...args: string[]): string {
  const proc = Bun.spawnSync([process.execPath, runner, ...args], {
    env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG: join(root, "config.yaml") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`newer release failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

describe("self-heal upgrade on a vault synced between releases", () => {
  // `mac` runs the newer release, `linux` this one. The vault paths are
  // reused from the setup above; only the release differs.
  // Built once for the block, in its own temp directory: both tests only
  // read the release, and copying `src/` per test doubled the run time.
  let runner: string;
  let releaseRoot: string;

  beforeAll(() => {
    releaseRoot = mkdtempSync(join(tmpdir(), "o2b-self-heal-newer-release-"));
    runner = buildNewerRelease(join(releaseRoot, "newer-release"));
  });

  afterAll(() => {
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  function alternate(rounds: number): string[] {
    const outcomes: string[] = [];
    for (let round = 0; round < rounds; round++) {
      outcomes.push(runNewer(runner, "self-heal", mac));
      sync(mac, linux);
      outcomes.push(runSelfHealUpgrade(linux).outcome);
      sync(linux, mac);
    }
    return outcomes;
  }

  test("a manual the newer release wrote is kept by the older one", () => {
    rmSync(mac, { recursive: true, force: true });
    rmSync(linux, { recursive: true, force: true });
    mkdirSync(mac, { recursive: true });
    runNewer(runner, "bootstrap", mac, join(root, "config.yaml"));
    sync(mac, linux);
    const written = readFileSync(brainManualPath(mac), "utf8");
    expect(templateRevisionOf(written)).toBe(BRAIN_MANUAL_TEMPLATE_REVISION + 1);

    const outcomes = alternate(2);

    expect(outcomes).toEqual(Array(4).fill(SELF_HEAL_UPGRADE_OUTCOME.current));
    expect(snapshotCount(mac)).toBe(0);
    expect(snapshotCount(linux)).toBe(0);
    expect(readFileSync(brainManualPath(linux), "utf8")).toBe(written);
    expect(readFileSync(brainManualPath(mac), "utf8")).toBe(written);
  }, 60_000);

  test("the newer release upgrades an older manual once and both then settle", () => {
    const outcomes = alternate(3);

    expect(outcomes).toEqual([
      SELF_HEAL_UPGRADE_OUTCOME.applied,
      ...Array(5).fill(SELF_HEAL_UPGRADE_OUTCOME.current),
    ]);
    // The one forward upgrade: one archive (with its sidecar manifest).
    expect(readdirSync(snapshotsDir(mac)).filter((f) => f.endsWith(".tar.zst"))).toHaveLength(1);
    expect(snapshotCount(linux)).toBe(0);
    const kept = readFileSync(brainManualPath(linux), "utf8");
    expect(kept).toContain(NEWER_TEMPLATE_LINE);
    expect(templateRevisionOf(kept)).toBe(BRAIN_MANUAL_TEMPLATE_REVISION + 1);
  }, 60_000);
});
