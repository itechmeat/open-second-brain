import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-pre-compact-extract-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain pre-compact-extract emits typed records without writing raw media", async () => {
  const result = await runCli([
    "brain",
    "pre-compact-extract",
    "--vault",
    vault,
    "--session-id",
    "session-cli",
    "--turn-start",
    "turn-1",
    "--turn-end",
    "turn-2",
    "--text",
    "Decision: Keep it bounded.\nOpen question: data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    "--json",
  ]);

  expect(result.returncode).toBe(0);
  expect(result.stderr).toBe("");
  const body = JSON.parse(result.stdout);
  expect(body).toMatchObject({ count: 2, errors: [] });
  expect(
    body.records.map(
      (record: { payload: { extract_type: string } }) => record.payload.extract_type,
    ),
  ).toEqual(["decision", "open_question"]);
  expect(result.stdout).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo");
});
