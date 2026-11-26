/**
 * The CLI's final flush: a large answer reaches its reader whole, and the
 * exit keeps its code and its diagnostics.
 *
 * The CLI writes its answer and then exits. Into a pipe, a write the reader
 * has not taken yet still waits in the process, and an exit that does not
 * wait for it throws it away: `o2b help --json | jq` once got the first
 * 131072 bytes of a 150 KB manifest, which is not JSON. The entry point now
 * exits only once stdout has handed over what was written, and leaves
 * stderr open for what is written to it later.
 *
 * The pipe cases run on an operating-system pipe built by `sh`, the pipe a
 * user's `| jq` gives: Bun's own spawn pipe drains so fast that it hid the
 * defect. Windows has no POSIX shell to build it with, so those cases are
 * POSIX-only; the unit cases below them run everywhere.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestForJson } from "../../src/cli/command-manifest.ts";
import {
  exitWhenFlushed,
  WINDOWS_FLUSH_BOUND_MS,
  type FlushableStream,
  type FlushExitDeps,
} from "../../src/cli/stdout-guard.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { lexSource } from "../helpers/source-lexer.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(ROOT, "src", "cli", "main.ts");
/** The entry a self-spawn uses when the dependency tree is missing; it exits the same way. */
const BOOTSTRAP_ENTRY = join(ROOT, "src", "cli", "deps-bootstrap.ts");
const HARNESS = join(ROOT, "tests", "helpers", "flush-exit-harness.ts");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

interface PipeRun {
  readonly out: string;
  /** The command's own exit status; NaN when it wrote none. */
  readonly code: number;
  readonly stderr: string;
}

/**
 * Run `argv` (after the Bun executable running this test) with its stdout
 * on an operating-system pipe into `reader`, its stderr on a second pipe
 * (a file hides an ended-stderr crash that a pipe shows), and its status
 * recorded by the shell.
 */
async function throughPipe(argv: ReadonlyArray<string>, reader: string): Promise<PipeRun> {
  const home = mkdtempSync(join(tmpdir(), "o2b-stdout-flush-"));
  homes.push(home);
  const status = join(home, "status");
  const errFile = join(home, "stderr");
  const line = [process.execPath, ...argv].map(quote).join(" ");
  const script =
    `{ { ${line}; echo $? > ${quote(status)}; } 2>&1 1>&3 3>&- | cat > ${quote(errFile)}; } ` +
    `3>&1 | ${reader}`;
  const proc = Bun.spawn(["sh", "-c", script], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, shellErr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const raw = existsSync(status) ? readFileSync(status, "utf8").trim() : "";
  const stderr = (existsSync(errFile) ? readFileSync(errFile, "utf8") : "") + shellErr;
  return { out, code: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN, stderr };
}

/** Run `argv` with stdout on `/dev/full`, every write failing with ENOSPC. */
async function intoFullDevice(
  argv: ReadonlyArray<string>,
): Promise<{ code: number; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "o2b-stdout-full-"));
  homes.push(home);
  const proc = Bun.spawn([process.execPath, ...argv], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home },
    stdin: "ignore",
    stdout: Bun.file("/dev/full"),
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

/** Resolve once `ready()` holds, looking every 20 ms. */
async function waitFor(ready: () => boolean): Promise<void> {
  while (!ready()) {
    // oxlint-disable-next-line no-await-in-loop -- polling a file the shell writes
    await Bun.sleep(20);
  }
}

/**
 * Run `help --json` with a reader that takes one byte and then pauses four
 * seconds, send `signal` once that byte arrived (the CLI is then waiting
 * for the reader), and report the CLI's status and how long after the
 * signal it ended. The CLI runs in the foreground of its shell, never as
 * a background job, which a shell starts with SIGINT ignored.
 */
async function signalDuringWait(
  signal: "SIGINT" | "SIGTERM",
): Promise<{ code: number; stderr: string; endedAfterMs: number }> {
  const home = mkdtempSync(join(tmpdir(), "o2b-stdout-signal-"));
  homes.push(home);
  const [pidFile, status, errFile, mark] = ["pid", "status", "stderr", "mark"].map((f) =>
    join(home, f),
  ) as [string, string, string, string];
  const cli = [process.execPath, CLI_ENTRY, "help", "--json"].map(quote).join(" ");
  const writer = `sh -c 'echo $$ > "$0"; exec "$@"' ${quote(pidFile)} ${cli}`;
  const script =
    `{ { ${writer}; echo $? > ${quote(status)}; } 2>&1 1>&3 3>&- | cat > ${quote(errFile)}; } ` +
    `3>&1 | { dd bs=1 count=1 of=${quote(mark)} 2>/dev/null; sleep 4; cat > /dev/null; }`;
  const proc = Bun.spawn(["sh", "-c", script], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const shellErr = new Response(proc.stderr).text();
  await waitFor(() => existsSync(mark) && readFileSync(mark).length > 0 && existsSync(pidFile));
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  const sentAt = Date.now();
  process.kill(pid, signal);
  await waitFor(() => existsSync(status) && readFileSync(status, "utf8").trim() !== "");
  const endedAfterMs = Date.now() - sentAt;
  await proc.exited;
  const raw = readFileSync(status, "utf8").trim();
  return {
    code: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN,
    stderr: readFileSync(errFile, "utf8") + (await shellErr),
    endedAfterMs,
  };
}

describe.skipIf(process.platform === "win32")("the final flush through a real pipe", () => {
  const manifest = `${JSON.stringify(manifestForJson(), null, 2)}\n`;

  for (const [label, entry] of [
    ["main", CLI_ENTRY],
    ["dependency bootstrap", BOOTSTRAP_ENTRY],
  ] as const) {
    test(`help --json arrives whole and parses (${label} entry)`, async () => {
      // A regression test only while the answer is larger than the pipe
      // sizes that hid the defect.
      expect(Buffer.byteLength(manifest)).toBeGreaterThan(131_072);
      const run = await throughPipe([entry, "help", "--json"], "cat");
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
      expect(run.out).toBe(manifest);
      expect(JSON.parse(run.out)).toEqual(manifestForJson());
    });

    test(`a reader that closes early ends the run cleanly (${label} entry)`, async () => {
      const run = await throughPipe([entry, "help", "--json"], "head -c 1");
      expect({ code: run.code, stderr: run.stderr, out: run.out }).toEqual({
        code: 0,
        stderr: "",
        out: "{",
      });
    });
  }

  test("a slow reader still gets the whole answer", async () => {
    // The reader starts a second late, so the pipe fills and the writer
    // waits on real backpressure before the exit.
    const run = await throughPipe([CLI_ENTRY, "help", "--json"], "{ sleep 1; cat; }");
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
    expect(run.out).toBe(manifest);
  });

  test("a reader that starts after a pause longer than any bound still receives everything", async () => {
    // The flush runs with a 100 ms bound configured; the reader takes one
    // byte, so the writer is in its wait, then pauses two seconds. Off
    // Windows no bound is armed, so nothing is cut and the code stays 0.
    const run = await throughPipe(
      [HARNESS, "0", "short-bound"],
      "{ dd bs=1 count=1 2>/dev/null; sleep 2; cat; }",
    );
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
    expect(run.out.length).toBe(300_000);
  });

  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${signal} during the wait for a paused reader ends the run at once`, async () => {
      const run = await signalDuringWait(signal);
      // The shell reports a child that SIGTERM ended as "Terminated"; the
      // CLI itself writes nothing.
      const stderr = run.stderr.replace(/^Terminated\n$/, "");
      expect({ code: run.code, stderr }).toEqual({ code: status, stderr: "" });
      // The reader pauses four seconds; the run ended long before that.
      expect(run.endedAfterMs).toBeLessThan(2_000);
    });
  }

  test("a reader that closes early leaves the command's own exit code", async () => {
    const run = await throughPipe([HARNESS, "2"], "head -c 1");
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 2, stderr: "" });
    expect(run.out).toBe("x");
  });

  test("a stderr line written while stdout drains is delivered, and nothing crashes", async () => {
    // One byte first: the pause starts only once the writer runs, however
    // long it took to start, so the line lands while stdout is held back.
    const run = await throughPipe(
      [HARNESS, "0", "late-stderr"],
      "{ dd bs=1 count=1 2>/dev/null; sleep 1; cat; }",
    );
    expect({ code: run.code, stderr: run.stderr }).toEqual({
      code: 0,
      stderr: "late stderr line\n",
    });
    expect(run.out.length).toBe(300_000);
  });

  test("what an exit hook writes to stderr after the flush still arrives", async () => {
    // The exit hooks of `o2b mcp` report on stderr as the process ends; a
    // flush that ended stderr lost those lines.
    const run = await throughPipe([HARNESS, "3", "exit-hook"], "cat");
    expect({ code: run.code, stderr: run.stderr }).toEqual({
      code: 3,
      stderr: "exit hook line\n",
    });
    expect(run.out.length).toBe(300_000);
  });

  // `/dev/full` is a Linux device.
  test.skipIf(!existsSync("/dev/full"))(
    "a full device fails the command and says why on stderr",
    async () => {
      const run = await intoFullDevice([CLI_ENTRY, "help", "--json"]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("ENOSPC");
    },
  );
});

/** A stdout whose end completes only when the test says so. */
function stream(state: Partial<FlushableStream> = {}): FlushableStream & {
  finish(): void;
  readonly ended: boolean;
} {
  let done: (() => void) | null = null;
  let ended = false;
  return {
    ...state,
    end(callback: () => void) {
      ended = true;
      done = callback;
    },
    finish() {
      done?.();
    },
    get ended() {
      return ended;
    },
  };
}

function fakeDeps(stdout: FlushableStream, platform: NodeJS.Platform = "linux") {
  const exits: number[] = [];
  const bounds: Array<{ readonly fire: () => void; readonly ms: number }> = [];
  const diagnostics: string[] = [];
  const deps: FlushExitDeps = {
    stdout,
    exit: (code) => exits.push(code),
    platform,
    boundMs: 50,
    setBound: (fire, ms) => bounds.push({ fire, ms }),
    writeDiagnostic: (message) => diagnostics.push(message),
    state: { code: null },
  };
  return { deps, exits, bounds, diagnostics };
}

describe("exitWhenFlushed", () => {
  test("exits with the command's code once stdout has settled, not before", () => {
    const out = stream();
    const { deps, exits } = fakeDeps(out);
    exitWhenFlushed(3, deps);
    expect([out.ended, exits]).toEqual([true, []]);
    out.finish();
    out.finish();
    expect(exits).toEqual([3]);
    expect(deps.state.code).toBe(3);
  });

  test("waits for no stdout that is already closed", () => {
    for (const closed of [stream({ destroyed: true }), stream({ writableEnded: true })]) {
      const { deps, exits } = fakeDeps(closed);
      exitWhenFlushed(0, deps);
      expect([closed.ended, exits]).toEqual([false, [0]]);
    }
  });

  test("a stdout whose end throws exits at once", () => {
    const throwing: FlushableStream = {
      end() {
        throw new Error("closed");
      },
    };
    const { deps, exits } = fakeDeps(throwing);
    exitWhenFlushed(1, deps);
    expect(exits).toEqual([1]);
  });

  test("arms no bound off Windows: it waits for the reader however long", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      const { deps, exits, bounds } = fakeDeps(stream(), platform);
      exitWhenFlushed(0, deps);
      expect({ platform, bounds: bounds.length, exits }).toEqual({
        platform,
        bounds: 0,
        exits: [],
      });
    }
  });

  test("on Windows a bound that fires says so and never exits 0", () => {
    const out = stream();
    const { deps, exits, bounds, diagnostics } = fakeDeps(out, "win32");
    exitWhenFlushed(0, deps);
    expect(bounds.map((b) => b.ms)).toEqual([50]);
    bounds[0]?.fire();
    bounds[0]?.fire();
    out.finish();
    expect(exits).toEqual([1]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toStartWith("error: standard output did not finish within");
    expect(WINDOWS_FLUSH_BOUND_MS).toBeGreaterThan(0);
  });

  test("on Windows a bound that fires keeps a failing command's own code", () => {
    const { deps, exits, bounds, diagnostics } = fakeDeps(stream(), "win32");
    exitWhenFlushed(4, deps);
    bounds[0]?.fire();
    expect([exits, diagnostics.length]).toEqual([[4], 1]);
  });

  test("on Windows a callback before the bound exits quietly with the command's code", () => {
    const out = stream();
    const { deps, exits, bounds, diagnostics } = fakeDeps(out, "win32");
    exitWhenFlushed(0, deps);
    out.finish();
    bounds[0]?.fire();
    expect([exits, diagnostics]).toEqual([[0], []]);
  });

  test("a flush on test doubles leaves the process's own exit state alone", () => {
    const before = process.exitCode;
    const { deps } = fakeDeps(stream());
    exitWhenFlushed(5, deps);
    expect(process.exitCode).toBe(before);
  });
});

/** Source files under `src/` that exit through the final flush (any call but its definition). */
function flushExitEntries(): Array<{ readonly file: string; readonly text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts")) {
        // Code only: a comment or a string that names the call is no call.
        const text = lexSource(readFileSync(path, "utf8")).code;
        if (/(?<!function\s)\bexitWhenFlushed\(/.test(text)) {
          out.push({ file: relative(ROOT, path).split("\\").join("/"), text });
        }
      }
    }
  };
  visit(join(ROOT, "src"));
  return out;
}

describe("the entry points", () => {
  test("every entry that exits through the final flush installs the guard before it", () => {
    // Without the guard a late write after the flush ended stdout, or an
    // EPIPE during it, was an unhandled error event that crashed the run.
    const entries = flushExitEntries();
    expect(entries.map((e) => e.file).toSorted()).toEqual([
      "src/cli/deps-bootstrap.ts",
      "src/cli/main.ts",
    ]);
    for (const { file, text } of entries) {
      const guard = text.search(/\binstallStdoutEpipeGuard\(\)/);
      const exit = text.search(/(?<!function\s)\bexitWhenFlushed\(/);
      expect({ file, guardFirst: guard !== -1 && guard < exit }).toEqual({
        file,
        guardFirst: true,
      });
    }
  });
});
