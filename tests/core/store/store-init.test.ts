/**
 * `o2b store init` (`store-init.ts`): the only way a store is created.
 * It writes one store id into every requested partition, completes a
 * half-created store with the id it already has, and refuses an existing
 * store, a partial one, and partitions of two stores.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STORE_FORMAT_FILE,
  STORE_FORMAT_VERSION,
  STORE_IDENTITY_FILE,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import * as blobs from "../../../src/core/store/blobs.ts";
import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import { initStore, StoreInitRefusal } from "../../../src/core/store/store-init.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let parent: string;
let root: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-init-"));
  root = join(parent, "store");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function identity(partition: string): unknown {
  return JSON.parse(readFileSync(join(root, partition, STORE_IDENTITY_FILE), "utf8"));
}

function refusal(run: () => unknown): StoreInitRefusal {
  try {
    run();
  } catch (err) {
    if (err instanceof StoreInitRefusal) return err;
    throw err;
  }
  throw new Error("init did not refuse");
}

describe("store init", () => {
  test("creates both partitions with one store id and the format document everywhere", () => {
    const result = initStore({ root });
    expect(result.status).toBe("created");
    expect(result.partitions).toEqual(["shared", "private"]);
    for (const partition of ["shared", "private"]) {
      expect(identity(partition)).toEqual({
        store_id: result.storeId,
        format: STORE_FORMAT_VERSION,
      });
    }
    for (const dir of [root, join(root, "shared"), join(root, "private")]) {
      expect(readFileSync(join(dir, STORE_FORMAT_FILE), "utf8")).toBe(shippedFormatDoc());
    }
    expect(inspectStore(root)?.storeId).toBe(result.storeId);
  });

  test("a machine that must not hold private records creates shared only", () => {
    const result = initStore({ root, partitions: ["shared"] });
    expect(result.partitions).toEqual(["shared"]);
    expect(existsSync(join(root, "private"))).toBe(false);
  });

  test("refuses when the store already exists and leaves it as it was", () => {
    const first = initStore({ root });
    const before = readFileSync(join(root, "shared", STORE_IDENTITY_FILE), "utf8");
    const err = refusal(() => initStore({ root }));
    expect(err.reason).toBe("exists");
    expect(err.message).toContain(first.storeId);
    expect(readFileSync(join(root, "shared", STORE_IDENTITY_FILE), "utf8")).toBe(before);
  });

  test("a re-run completes a half-created store with the id it already has", () => {
    const first = initStore({ root });
    // The first run stopped after shared: private has its folder but no identity.
    rmSync(join(root, "private", STORE_IDENTITY_FILE));
    const second = initStore({ root });
    expect(second.status).toBe("completed");
    expect(second.storeId).toBe(first.storeId);
    expect(second.created).toEqual(["private"]);
    expect(identity("private")).toEqual({ store_id: first.storeId, format: STORE_FORMAT_VERSION });
  });

  test("a shared-only store gains private later with the same id", () => {
    const first = initStore({ root, partitions: ["shared"] });
    const second = initStore({ root });
    expect(second.storeId).toBe(first.storeId);
    expect(second.partitions).toEqual(["shared", "private"]);
  });

  test("a partition folder with records but no identity is refused by name, not given a new id", () => {
    initStore({ root, partitions: ["shared"] });
    mkdirSync(join(root, "private", "events"), { recursive: true });
    writeFileSync(join(root, "private", "events", "dev-a.jsonl"), "{}\n");
    const err = refusal(() => initStore({ root }));
    expect(err.reason).toBe("partial");
    expect(err.message).toContain(STORE_IDENTITY_FILE);
    expect(err.message).toContain("private");
    expect(existsSync(join(root, "private", STORE_IDENTITY_FILE))).toBe(false);
  });

  test("records synced without any identity file are refused, so no store id is minted", () => {
    mkdirSync(join(root, "shared", "events"), { recursive: true });
    writeFileSync(join(root, "shared", "events", "dev-a.jsonl"), "{}\n");
    expect(refusal(() => initStore({ root })).reason).toBe("partial");
    expect(inspectStore(root)).toBeNull();
  });

  test("sync tool markers and temp files do not make a folder partial", () => {
    mkdirSync(join(root, "shared", ".stfolder"), { recursive: true });
    writeFileSync(join(root, "shared", ".tmp-store.json.1"), "");
    expect(initStore({ root }).status).toBe("created");
  });

  test("partitions of two different stores are refused", () => {
    initStore({ root, partitions: ["shared"] });
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(
      join(root, "private", STORE_IDENTITY_FILE),
      `${JSON.stringify({ store_id: "01JBZ3NDEKTSV4RRFFQ69G5FAV", format: 1 })}\n`,
    );
    expect(refusal(() => initStore({ root })).reason).toBe("mixed");
  });

  test("an identity file that holds no store id is refused as corrupt", () => {
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared", STORE_IDENTITY_FILE), "{");
    expect(refusal(() => initStore({ root })).reason).toBe("corrupt");
  });

  test("an empty partition list is a caller error, not a refusal", () => {
    expect(() => initStore({ root, partitions: [] })).toThrow(TypeError);
  });
});

function env(): Record<string, string> {
  return { [STORE_ROOT_ENV]: root, HOME: join(parent, "home") };
}

describe("o2b store init", () => {
  test("creates the store, then refuses a second run with exit 1", async () => {
    const created = await runCli(["store", "init", "--json"], { env: env() });
    expect(created.returncode).toBe(0);
    const body = JSON.parse(created.stdout) as { ok: boolean; status: string; storeId: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("created");
    expect(inspectStore(root)?.storeId).toBe(body.storeId);

    const again = await runCli(["store", "init"], { env: env() });
    expect(again.returncode).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  test("--partitions shared leaves private out", async () => {
    const r = await runCli(["store", "init", "--partitions", "shared"], { env: env() });
    expect(r.returncode).toBe(0);
    expect([...(inspectStore(root)?.partitions ?? [])]).toEqual(["shared"]);
  });

  test("six processes running the init verb at once agree on one store and only one reports creating it", async () => {
    // Six processes run the `store init` verb (its handler, not the whole
    // CLI entry; the single-run tests above cover the CLI) against one root. Each loads the verb,
    // says it is ready and waits for one go signal, so the six really do
    // race on the store, whatever the runner's load: a process start
    // (a transpile of the CLI on a cold Windows runner takes seconds) is
    // not part of the race and cannot stagger it into six serial runs or
    // eat the test's budget while one run is still starting.
    const runs = 6;
    const go = join(parent, "go");
    const child = join(parent, "racer.ts");
    const storeVerb = join(import.meta.dir, "../../../src/cli/store.ts");
    writeFileSync(
      child,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        `import { handleStoreSubcommand } from ${JSON.stringify(storeVerb)};`,
        "writeFileSync(process.argv[2], '');",
        // Bounded on its own, so a racer whose test already gave up exits
        // instead of spinning after the run.
        "const deadline = Date.now() + 30_000;",
        `while (!existsSync(${JSON.stringify(go)})) {`,
        "  if (Date.now() > deadline) process.exit(2);",
        "  Bun.sleepSync(5);",
        "}",
        'process.exitCode = await handleStoreSubcommand(["init", "--json"]);',
      ].join("\n"),
    );
    const spawnRacer = (i: number) => {
      const home = join(parent, "home");
      const proc = Bun.spawn([process.execPath, child, join(parent, `ready-${i}`)], {
        cwd: parent,
        env: {
          ...process.env,
          ...env(),
          ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
          // A machine config of its own per run, as each CLI run gets.
          OPEN_SECOND_BRAIN_CONFIG: join(parent, `config-${i}.yaml`),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { proc, output };
    };
    const racers: Array<ReturnType<typeof spawnRacer>> = [];
    const readyUpTo = (count: number): boolean =>
      Array.from({ length: count }, (_, i) => join(parent, `ready-${i}`)).every((f) =>
        existsSync(f),
      );
    const waitReady = async (count: number): Promise<void> => {
      while (!readyUpTo(count)) {
        // A run that died before it got ready would leave the others waiting.
        for (const { proc } of racers) {
          if (proc.exitCode !== null) {
            throw new Error(`a racer exited ${proc.exitCode} before the start`);
          }
        }
        await Bun.sleep(10);
      }
    };
    let results: Array<[string, string, number]>;
    try {
      // The first racer starts alone and fills Bun's transpiler cache, so
      // the other five start warm instead of transpiling the verb's whole
      // module graph six times at once on a slow runner.
      racers.push(spawnRacer(0));
      await waitReady(1);
      for (let i = 1; i < runs; i++) racers.push(spawnRacer(i));
      await waitReady(runs);
      writeFileSync(go, "");
      results = await Promise.all(racers.map((r) => r.output));
    } finally {
      // Whatever happened above, no racer outlives the test.
      for (const { proc } of racers) if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    const answers = results.map(([stdout, stderr]) => {
      try {
        return JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        throw new Error(`a racer answered no JSON: ${stdout}${stderr}`);
      }
    });
    const done = answers.filter((a) => a["ok"] === true);
    // A run that lost is refused for the store the others made, never for another reason.
    const refused = answers.filter((a) => a["ok"] !== true).map((a) => a["reason"]);
    expect(refused.filter((reason) => reason !== "exists" && reason !== "partial")).toEqual([]);
    expect(done.length + refused.length).toBe(answers.length);
    expect(done.filter((a) => a["status"] === "created").length).toBe(1);
    const written = done.flatMap((a) => a["created"] as string[]);
    expect(written.toSorted()).toEqual(["private", "shared"]);
    expect(new Set(done.map((a) => a["storeId"]))).toEqual(new Set([inspectStore(root)?.storeId]));
  }, 30_000);

  test("with --json a usage error is a JSON answer too", async () => {
    const r = await runCli(["store", "init", "--partitions", "secret", "--json"], { env: env() });
    expect(r.returncode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, reason: "usage" });
  });

  test("with --json a filesystem error on the store root is a JSON answer", async () => {
    // The root sits under a regular file, so no folder can be made there.
    writeFileSync(join(parent, "blocker"), "");
    root = join(parent, "blocker", "store");
    const r = await runCli(["store", "init", "--json"], { env: env() });
    expect(r.returncode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, reason: "error" });
  });

  test("an unknown partition name is a usage error that creates nothing", async () => {
    const r = await runCli(["store", "init", "--partitions", "secret"], { env: env() });
    expect(r.returncode).toBe(2);
    expect(existsSync(root)).toBe(false);
  });
});

describe("an init that loses the race to one that stopped half way", () => {
  test("an identity file that never gets its id is refused as corrupt, with the way out", () => {
    // The winner created the name with an exclusive create (no hard links
    // on its filesystem) and stopped before writing the id into it.
    const lost = spyOn(blobs, "createFileOnce").mockImplementation((path: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
      return false;
    });
    try {
      const err = refusal(() => initStore({ root }));
      expect(err.reason).toBe("corrupt");
      expect(err.message).toContain(join(root, "shared", STORE_IDENTITY_FILE));
      expect(err.message).toContain("remove the file and run `o2b store init` again");
    } finally {
      lost.mockRestore();
    }
  });
});
