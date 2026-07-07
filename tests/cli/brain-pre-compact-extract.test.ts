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

test("brain pre-compact-extract --dry-run previews without writing to the vault", async () => {
  const argv = [
    "brain",
    "pre-compact-extract",
    "--vault",
    vault,
    "--session-id",
    "session-cli-dry",
    "--turn-start",
    "turn-1",
    "--turn-end",
    "turn-1",
    "--text",
    "Decision: Preview only, do not persist.",
    "--json",
  ];
  const preview = await runCli([...argv, "--dry-run"]);
  expect(preview.returncode).toBe(0);
  const previewBody = JSON.parse(preview.stdout);
  expect(previewBody).toMatchObject({ count: 1, dry_run: true, errors: [] });

  // The preview's timestamp-independent dedupe_key matches the record the
  // real run appends — the preview predicts real extraction. (record `id`
  // folds in the ms-precise createdAt, which differs across two un-pinned
  // calls, so compare dedupe_key.)
  const real = await runCli(argv);
  const realBody = JSON.parse(real.stdout);
  expect(realBody).toMatchObject({ count: 1, dry_run: false });
  expect(previewBody.records[0].payload.dedupe_key).toBe(realBody.records[0].payload.dedupe_key);
});
