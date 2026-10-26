import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../src/core/brain/context-receipts.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-context-receipts-cli-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain context-receipts lists and shows prompt receipt records", async () => {
  const receipt = emitContextReceipt(vault, {
    options: {
      host: "cli-test",
      trigger: "context_pack",
      createdAt: "2026-05-20T12:00:00.000Z",
      sessionId: "session-cli",
    },
    finalText: "Packed visible context",
    items: [
      {
        id: "pref-alpha",
        path: join(vault, "Brain", "preferences", "pref-alpha.md"),
        text: "Prefer crisp answers",
        tokens: 4,
        tier: "core",
      },
    ],
    budget: { max_tokens: 100 },
  });

  const list = await runCli(["brain", "context-receipts", "list", "--vault", vault, "--json"]);
  expect(list.returncode).toBe(0);
  const listJson = JSON.parse(list.stdout);
  expect(listJson.total).toBe(1);
  expect(listJson.receipts[0]).toMatchObject({
    id: receipt.id,
    created_at: "2026-05-20T12:00:00.000Z",
    trigger: "context_pack",
    host: "cli-test",
    item_count: 1,
  });

  const show = await runCli([
    "brain",
    "context-receipts",
    "show",
    receipt.id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(show.returncode).toBe(0);
  const showJson = JSON.parse(show.stdout);
  expect(showJson.id).toBe(receipt.id);
  expect(showJson.payload.items[0]).toMatchObject({
    id: "pref-alpha",
    tier: "core",
    tokens: 4,
  });
});

test("brain context-receipts show joins the session's reply_presence and names unjoined honestly", async () => {
  const joined = emitContextReceipt(vault, {
    options: {
      host: "cli-test",
      trigger: "session_inject",
      createdAt: "2026-05-20T14:00:00.000Z",
      sessionId: "session-cli-present",
    },
    finalText: "eager layer",
    items: [{ id: "pref-alpha", path: "Brain/preferences/pref-alpha.md" }],
  });
  const lonely = emitContextReceipt(vault, {
    options: {
      host: "cli-test",
      trigger: "session_inject",
      createdAt: "2026-05-20T14:05:00.000Z",
      sessionId: "session-cli-absent",
    },
    finalText: "eager layer",
    items: [{ id: "pref-bravo", path: "Brain/preferences/pref-bravo.md" }],
  });
  const presence = appendContinuityRecord(vault, {
    kind: "reply_presence",
    createdAt: "2026-05-20T14:10:00.000Z",
    payload: {
      session_id: "session-cli-present",
      checked: 1,
      per_note: [
        {
          path: "Brain/preferences/pref-alpha.md",
          start_line: 2,
          end_line: 4,
          verdict: "verified",
        },
      ],
    },
  });

  // The joined show names the sibling record and carries its per-note verdicts.
  const showJoined = await runCli([
    "brain",
    "context-receipts",
    "show",
    joined.id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(showJoined.returncode).toBe(0);
  expect(JSON.parse(showJoined.stdout)["reply_presence"]).toEqual({
    joined: true,
    presence: {
      record_id: presence.id,
      created_at: "2026-05-20T14:10:00.000Z",
      checked: 1,
      per_note: [
        {
          path: "Brain/preferences/pref-alpha.md",
          start_line: 2,
          end_line: 4,
          verdict: "verified",
        },
      ],
    },
  });

  // No reply_presence record for this receipt's session: the outcome is
  // NAMED on the response, never a silent absence.
  const showLonely = await runCli([
    "brain",
    "context-receipts",
    "show",
    lonely.id,
    "--vault",
    vault,
    "--json",
  ]);
  expect(showLonely.returncode).toBe(0);
  expect(JSON.parse(showLonely.stdout)["reply_presence"]).toEqual({
    joined: false,
    reason: "unjoined",
    session_id: "session-cli-absent",
  });

  // The text show prints the verdicts, and the unjoined absence says why.
  const textJoined = await runCli([
    "brain",
    "context-receipts",
    "show",
    joined.id,
    "--vault",
    vault,
  ]);
  expect(textJoined.returncode).toBe(0);
  expect(textJoined.stdout).toContain(
    `reply_presence: joined (record ${presence.id} @ 2026-05-20T14:10:00.000Z, checked=1)`,
  );
  expect(textJoined.stdout).toContain("  Brain/preferences/pref-alpha.md#L2-L4: verified\n");

  const textLonely = await runCli([
    "brain",
    "context-receipts",
    "show",
    lonely.id,
    "--vault",
    vault,
  ]);
  expect(textLonely.returncode).toBe(0);
  expect(textLonely.stdout).toContain(
    "reply_presence: unjoined (no reply_presence record for session session-cli-absent)\n",
  );
});
