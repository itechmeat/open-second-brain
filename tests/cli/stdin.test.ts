/**
 * `readStdinText` drains piped stdin completely before the process exits.
 *
 * The bug it replaced was an exit, not a wrong value: on Windows Bun,
 * `await Bun.stdin.text()` did not keep the event loop alive, so a CLI
 * entry awaiting it exited 0 with nothing read. Only a real child process
 * with a real pipe reproduces that, so this spawns one, on every platform.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const STDIN_MODULE = resolve(join(import.meta.dir, "..", "..", "src", "cli", "stdin.ts"));

/** A child that awaits `readStdinText` through a promise chain, like the CLI entry. */
const CHILD = `
import { readStdinText } from ${JSON.stringify(STDIN_MODULE)};
async function main() {
  const text = await readStdinText();
  process.stdout.write(JSON.stringify({ length: text.length, head: text.slice(0, 16), tail: text.slice(-16) }));
}
main().then(() => process.exit(0));
`;

function run(input: string | Buffer) {
  return spawnSync(process.execPath, ["-e", CHILD], {
    input,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

describe("readStdinText", () => {
  test("returns the whole piped body, not an empty string", () => {
    const proc = run("hello from a pipe\n");
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual({
      length: 18,
      head: "hello from a pip",
      tail: "hello from a pipe\n".slice(-16),
    });
  });

  test("a body larger than one pipe buffer arrives complete, as UTF-8", () => {
    const body = "é".repeat(200_000) + "END";
    const proc = run(body);
    expect(proc.status).toBe(0);
    const out = JSON.parse(proc.stdout) as { length: number; head: string; tail: string };
    expect(out.length).toBe(body.length);
    expect(out.tail.endsWith("END")).toBe(true);
    expect(out.head).toBe("é".repeat(16));
  });

  test("an empty pipe is an empty string", () => {
    const proc = run("");
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual({ length: 0, head: "", tail: "" });
  });
});
