/**
 * A large answer written into a pipe reaches its reader whole.
 *
 * The CLI writes its answer and then exits. Into a pipe, a write the reader
 * has not taken yet still waits in the process, and an exit that does not
 * wait for it throws it away: `o2b help --json | jq` once got the first
 * 131072 bytes of a 150 KB manifest, which is not JSON. The entry point now
 * exits only once stdout and stderr have handed over what was written.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestForJson } from "../../src/cli/command-manifest.ts";
import { exitWhenFlushed, type FlushableStream } from "../../src/cli/stdout-guard.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(ROOT, "src", "cli", "main.ts");

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Run the CLI with its stdout on an operating-system pipe read by `cat`,
 * the way `o2b help --json | jq` runs. Bun's own spawn pipe drains so fast
 * that it hid the defect; the shell pipe is the one that showed it.
 */
async function throughPipe(args: ReadonlyArray<string>): Promise<{ out: string; code: number }> {
  const home = mkdtempSync(join(tmpdir(), "o2b-stdout-flush-"));
  homes.push(home);
  const line = ["bun", CLI_ENTRY, ...args].map(quote).join(" ");
  // `exit "${PIPESTATUS}"` is bash; plain sh keeps the CLI's status in a file.
  const status = join(home, "status");
  const script = `{ ${line}; echo $? > ${quote(status)}; } | cat`;
  const proc = Bun.spawn(["sh", "-c", script], {
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "", HOME: home, USERPROFILE: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { out, code: Number(readFileSync(status, "utf8").trim()) };
}

// Windows has no POSIX shell to build the pipe with.
describe.skipIf(process.platform === "win32")("a large answer through a pipe", () => {
  test("help --json arrives whole and parses", async () => {
    const expected = `${JSON.stringify(manifestForJson(), null, 2)}\n`;
    // The case is only a regression test while the answer is larger than
    // the pipe sizes that hid the defect.
    expect(Buffer.byteLength(expected)).toBeGreaterThan(131_072);
    const { out, code } = await throughPipe(["help", "--json"]);
    expect(code).toBe(0);
    expect(out).toBe(expected);
    expect(JSON.parse(out)).toEqual(manifestForJson());
  });
});

/** A stream whose end completes only when the test says so. */
function stream(state: Partial<FlushableStream> = {}): FlushableStream & { finish(): void } {
  let done: (() => void) | null = null;
  return {
    ...state,
    end(callback: () => void) {
      done = callback;
    },
    finish() {
      done?.();
    },
  };
}

describe("exitWhenFlushed", () => {
  test("exits once every open stream has finished, with the command's code", () => {
    const out = stream();
    const err = stream();
    const exits: number[] = [];
    exitWhenFlushed(3, { streams: [out, err], exit: (code) => exits.push(code) });
    expect(exits).toEqual([]);
    out.finish();
    expect(exits).toEqual([]);
    err.finish();
    expect(exits).toEqual([3]);
  });

  test("waits for no stream that is already closed", () => {
    const exits: number[] = [];
    exitWhenFlushed(0, {
      streams: [stream({ destroyed: true }), stream({ writableEnded: true })],
      exit: (code) => exits.push(code),
    });
    expect(exits).toEqual([0]);
  });
});
