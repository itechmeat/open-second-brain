/**
 * Ctrl-C, and the four operations it cannot reach.
 *
 * The branch wired `onInterrupt()` into six verbs and claimed all six were
 * interruptible. Four of them - dream, bridges, clusters, architect - run
 * fully synchronously, and a JavaScript signal handler is dispatched from
 * the event loop, so it cannot run while they do. Registering the listener
 * anyway made those four STRICTLY worse: the listener suppresses Node's
 * default termination, so the first keystroke stopped killing the process
 * and started doing nothing at all.
 *
 * These tests pin the three rules that replaced the claim.
 *
 *   1. A handle may only be opened for an operation that yields to the
 *      event loop. Asking for one for an operation that does not is a
 *      defect reported by name, not a handle that quietly does nothing.
 *   2. A verb whose operation cannot observe the signal registers no
 *      listener at all, so the keystroke keeps its default meaning.
 *   3. An interrupt that arrived and that no operation acted on still ends
 *      the run. A verb cannot return 0 for a pass the operator stopped.
 *
 * Rules 3 and the platform fact underneath all of this are exercised in
 * child processes: they turn on real signal delivery and on real process
 * termination, neither of which can be faked in-process, and neither of
 * which may be aimed at the test runner itself.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { interruptIsObservable, onInterrupt } from "../../src/cli/interrupt.ts";
import { OPERATION, type Operation } from "../../src/core/brain/safeguard.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { runCli } from "../helpers/run-cli.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");

interface DriverResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * Run `body` as its own process and report how it ended.
 *
 * A child rather than the runner because every property here is about a
 * real SIGINT: delivered by the kernel, dispatched by the receiving
 * process's own event loop, and - in the cases that matter - killing the
 * process it reaches. A test that aimed any of that at the runner would
 * take the suite with it.
 */
async function runDriver(body: string): Promise<DriverResult> {
  const dir = mkdtempSync(join(tmpdir(), "o2b-interrupt-driver-"));
  try {
    const file = join(dir, "driver.ts");
    writeFileSync(file, body, "utf8");
    const proc = Bun.spawn(["bun", "run", file], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return {
      stdout,
      stderr,
      code: proc.exitCode,
      signal: proc.signalCode,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the platform fact the rules rest on", () => {
  test("a delivered SIGINT is invisible to a fully synchronous checkpoint loop", async () => {
    // `dreamRun`, `detectCommunitiesRun`, `discoverBridgesRun` and
    // `generateRun` are all declared `function`, not `async`, and contain
    // no `await`. This drives production `onInterrupt` and production
    // `createSafeguard` through exactly that shape, with a real signal
    // pending for most of it, and records what the checkpoint saw.
    const result = await runDriver(`
      import { onInterrupt } from ${JSON.stringify(join(SRC, "cli", "interrupt.ts"))};
      import { createSafeguard, SafeguardAbortError, OPERATION } from ${JSON.stringify(join(SRC, "core", "brain", "safeguard.ts"))};

      const interrupt = onInterrupt(OPERATION.reindex);
      const safeguard = createSafeguard({ operation: "dream", signal: interrupt.signal });
      Bun.spawn(["bash", "-c", \`sleep 0.3; kill -INT \${process.pid}\`]);

      let checkpoints = 0;
      let stoppedByCtrlC = false;
      const start = Date.now();
      try {
        while (Date.now() - start < 1500) { safeguard.checkpoint(); checkpoints++; }
      } catch (e) { stoppedByCtrlC = e instanceof SafeguardAbortError; }
      const duringRun = interrupt.received();
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({
        checkpoints, stoppedByCtrlC, duringRun, afterOneEventLoopTurn: interrupt.received(),
      }));
      interrupt.acknowledge();
      interrupt.release();
    `);
    const seen = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    // Millions of checkpoints, every one of them past the moment the key
    // was pressed, and not one of them saw it.
    expect(seen["checkpoints"]).toBeGreaterThan(100_000);
    expect(seen["stoppedByCtrlC"]).toBe(false);
    expect(seen["duringRun"]).toBeNull();
    // And it was never in doubt that the signal arrived: one turn of the
    // event loop later, it is there.
    expect(seen["afterOneEventLoopTurn"]).toBe("SIGINT");
  }, 30_000);
});

describe("a handle is opened only where the operation can observe it", () => {
  const SYNCHRONOUS: Operation[] = [
    OPERATION.dream,
    OPERATION.bridges,
    OPERATION.clusters,
    OPERATION.architect,
  ];

  test.each(SYNCHRONOUS)("%s cannot observe an interrupt, and says so", (operation) => {
    expect(interruptIsObservable(operation)).toBe(false);
    // Not a no-op handle: a handle that installs nothing would make the
    // wrong call site look like the right one.
    expect(() => onInterrupt(operation)).toThrow(
      new RegExp(`${operation}[\\s\\S]*runs to completion without yielding`),
    );
  });

  const ASYNCHRONOUS: Operation[] = [OPERATION.reindex, OPERATION.maintenance];

  test.each(ASYNCHRONOUS)("%s yields to the event loop, so it may hold a handle", (operation) => {
    expect(interruptIsObservable(operation)).toBe(true);
    const handle = onInterrupt(operation);
    try {
      expect(handle.signal.aborted).toBe(false);
      expect(handle.received()).toBeNull();
    } finally {
      handle.release();
    }
  });

  test("every operation in the vocabulary has an answer", () => {
    for (const operation of Object.values(OPERATION)) {
      expect(typeof interruptIsObservable(operation)).toBe("boolean");
    }
  });
});

describe("a verb that cannot observe the signal leaves it alone", () => {
  /**
   * Registering a SIGINT listener suppresses the default terminate for as
   * long as it is registered. So for the four synchronous operations the
   * observable property is not "the handle works" - it cannot - it is
   * that no listener is installed, which is what keeps the keystroke
   * lethal. Counting after the run would see nothing either way, because
   * `release()` removes what it added; the registration itself is what
   * has to be watched.
   */
  async function signalListenersRegisteredDuring(
    args: ReadonlyArray<string>,
    env: Record<string, string>,
  ): Promise<string[]> {
    const registered: string[] = [];
    const realOnce = process.once.bind(process);
    const spy = ((event: string, listener: (...a: unknown[]) => void) => {
      if (event === "SIGINT" || event === "SIGTERM") registered.push(event);
      return realOnce(event as never, listener as never);
    }) as typeof process.once;
    process.once = spy;
    try {
      await runCli(args, { env });
    } finally {
      process.once = realOnce;
    }
    return registered;
  }

  test("`brain dream` registers no signal listener", async () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-interrupt-vault-"));
    const cfgHome = mkdtempSync(join(tmpdir(), "o2b-interrupt-cfg-"));
    const configPath = join(cfgHome, "config.yaml");
    try {
      atomicWriteFileSync(configPath, `vault: ${vault}\n`);
      bootstrapBrain(vault, { configPath });
      const registered = await signalListenersRegisteredDuring(["brain", "dream", "--dry-run"], {
        OPEN_SECOND_BRAIN_CONFIG: configPath,
      });
      expect(registered).toEqual([]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(cfgHome, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("an interrupt nobody acted on still ends the run", () => {
  test("release re-raises a signal the operation never observed", async () => {
    // The window every one of the six verbs leaves open: `Store.open`, a
    // proposal write, a report render - work inside the handle's lifetime
    // that never consults the signal. Before this rule the controller
    // aborted, nobody read it, and the verb returned 0.
    const result = await runDriver(`
      import { onInterrupt } from ${JSON.stringify(join(SRC, "cli", "interrupt.ts"))};
      import { OPERATION } from ${JSON.stringify(join(SRC, "core", "brain", "safeguard.ts"))};

      const interrupt = onInterrupt(OPERATION.reindex);
      try {
        Bun.spawn(["bash", "-c", \`sleep 0.2; kill -INT \${process.pid}\`]);
        await new Promise((r) => setTimeout(r, 600));
        console.log("the operation finished without ever reading the signal");
      } finally {
        interrupt.release();
      }
      console.log("UNREACHABLE: the verb returned normally");
      process.exit(0);
    `);
    expect(result.stdout).toContain("without ever reading the signal");
    expect(result.stdout).not.toContain("UNREACHABLE");
    expect(result.stderr).toContain("interrupted");
    // The keystroke's own code, so a shell and a parent process read it
    // the way they read any other Ctrl-C. Asserted as the code rather
    // than as `signalCode`: Bun's default SIGINT disposition surfaces to
    // a parent as `exitCode: 130, signalCode: null` where a re-raise under
    // Node's would surface as the signal. What must hold is the number a
    // caller gates on, and that it is not 0.
    expect(result.code).toBe(130);
  }, 30_000);

  test("an acknowledged interrupt lets the verb report its own exit code", async () => {
    const result = await runDriver(`
      import { onInterrupt, reportInterrupted, EXIT_INTERRUPTED } from ${JSON.stringify(join(SRC, "cli", "interrupt.ts"))};
      import { OPERATION, SafeguardAbortError } from ${JSON.stringify(join(SRC, "core", "brain", "safeguard.ts"))};

      const interrupt = onInterrupt(OPERATION.reindex);
      let code;
      try {
        Bun.spawn(["bash", "-c", \`sleep 0.2; kill -INT \${process.pid}\`]);
        await new Promise((r) => setTimeout(r, 600));
        // What the real catch arm does when the operation stopped at a
        // checkpoint of its own.
        code = reportInterrupted(interrupt, new SafeguardAbortError("reindex"), false);
      } finally {
        interrupt.release();
      }
      console.log("verb returned " + code);
      process.exit(code);
    `);
    // Reported, not re-raised: the verb's own answer stands, and the line
    // after `reportInterrupted` still runs - which is the whole difference
    // from the unacknowledged case above.
    expect(result.stdout).toContain("verb returned 130");
    expect(result.stderr).not.toContain("stopping now");
    expect(result.code).toBe(130);
  }, 30_000);

  test("a run nobody interrupted releases silently and exits 0", async () => {
    const result = await runDriver(`
      import { onInterrupt } from ${JSON.stringify(join(SRC, "cli", "interrupt.ts"))};
      import { OPERATION } from ${JSON.stringify(join(SRC, "core", "brain", "safeguard.ts"))};

      const interrupt = onInterrupt(OPERATION.reindex);
      try { await new Promise((r) => setTimeout(r, 20)); } finally { interrupt.release(); }
      console.log("clean");
      process.exit(0);
    `);
    expect(result.stdout).toContain("clean");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  }, 30_000);
});
