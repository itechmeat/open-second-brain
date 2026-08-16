/**
 * `describeErrorChain` - the CLI renderer that stopped throwing away `cause`.
 *
 * GitHub #167 is the case this exists for. The snapshot gate's id-exhaustion
 * error attaches the real failure as `cause`; every catch arm rendered
 * `(exc as Error).message` and stopped, so the operator saw a summary that
 * was not merely incomplete but WRONG - it described a full archive directory
 * while the cause said `mkdir Brain/.snapshots` had failed. An error that
 * builds a `cause` has already decided the detail is load-bearing.
 */

import { describe, expect, test } from "bun:test";

import { describeErrorChain, failWith } from "../../src/cli/output.ts";

describe("describeErrorChain", () => {
  test("renders a bare error as its own message", () => {
    expect(describeErrorChain(new Error("plain failure"))).toBe("plain failure");
  });

  test("renders the cause behind the message", () => {
    const cause = new Error("EEXIST: file already exists, mkdir '/v/Brain/.snapshots'");
    expect(describeErrorChain(new Error("could not reserve a unique run id", { cause }))).toBe(
      "could not reserve a unique run id; caused by: " +
        "EEXIST: file already exists, mkdir '/v/Brain/.snapshots'",
    );
  });

  test("renders a nested chain in order", () => {
    const inner = new Error("inner");
    const middle = new Error("middle", { cause: inner });
    expect(describeErrorChain(new Error("outer", { cause: middle }))).toBe(
      "outer; caused by: middle; caused by: inner",
    );
  });

  test("skips a cause the outer message already quotes", () => {
    // The common wrapper re-states its cause; printing it twice reads as two
    // separate failures.
    const cause = new Error("no space left on device");
    expect(describeErrorChain(new Error("zstd failed: no space left on device", { cause }))).toBe(
      "zstd failed: no space left on device",
    );
  });

  test("terminates on a cyclic chain instead of hanging", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    // Bounded walk: it returns, and it returns something finite.
    expect(describeErrorChain(a).length).toBeLessThan(200);
    expect(describeErrorChain(a)).toContain("caused by: b");
  });

  test("renders a non-Error throw as its own text", () => {
    expect(describeErrorChain("just a string")).toBe("just a string");
    expect(describeErrorChain(null)).toBe("null");
  });
});

describe("failWith", () => {
  test("puts the cause on stderr with the action line", () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: string): boolean => {
      written.push(chunk);
      return true;
    };
    try {
      const code = failWith(
        "take a snapshot",
        new Error("gate refused", { cause: new Error("Brain/.snapshots is a regular file") }),
      );
      expect(code).toBe(1);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
    expect(written.join("")).toBe(
      "error: failed to take a snapshot: gate refused; caused by: " +
        "Brain/.snapshots is a regular file\n",
    );
  });
});
