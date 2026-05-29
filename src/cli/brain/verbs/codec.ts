import { readFileSync } from "node:fs";

import { compress, expand } from "../../../core/brain/portability/codec.ts";
import { fail, parse } from "../helpers.ts";

/**
 * `o2b brain codec --compress|--expand [--in <file>]` - run the
 * deterministic session codec over stdin (or `--in <file>`) and print
 * the result to stdout. Read-only; does not touch the vault.
 */
export async function cmdBrainCodec(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    compress: { type: "boolean" },
    expand: { type: "boolean" },
    in: { type: "string" },
  });
  if (flags["compress"] === flags["expand"]) {
    return fail("usage: o2b brain codec --compress | --expand [--in <file>]");
  }

  let input: string;
  try {
    input =
      typeof flags["in"] === "string"
        ? readFileSync(flags["in"], "utf8")
        : await Bun.stdin.text();
  } catch (exc) {
    return fail(`codec: failed to read input: ${(exc as Error).message ?? exc}`);
  }

  process.stdout.write(flags["compress"] ? compress(input) : expand(input));
  return 0;
}
