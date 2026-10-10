/**
 * Inbound Telegram capture core (Knowledge intake suite, t_f8f5ef6a).
 *
 * The update-handling core is exercised with an injected transport - no real
 * network is ever touched. Every accepted text update becomes one capture
 * note through the contract; every rejected, refused, or malformed update is
 * one explicit logged decision (a vocabulary refusal records
 * `refused-contract` and the run advances past it); `/catchup` replies with
 * captures since the last acknowledged one.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CATCHUP_COMMAND,
  MissingTelegramTokenError,
  handleCaptureUpdate,
  requireTelegramToken,
  runTelegramCapture,
  type TelegramTransport,
  type TelegramUpdate,
} from "../../../../src/core/brain/capture/telegram-capture.ts";
import {
  listStagedCaptures,
  readCatchupWatermark,
} from "../../../../src/core/brain/capture/capture-note.ts";
import { captureDecisionLogPath } from "../../../../src/core/brain/paths.ts";
import { escapeMarkdownV2 } from "../../../../src/core/discipline/telegram.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";

const NOW = new Date("2026-07-19T12:00:00Z");
const ALLOW = new Set(["100"]);

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-telegram-capture-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function textUpdate(id: number, chatId: string | number, text: string): TelegramUpdate {
  return { update_id: id, message: { message_id: id, text, chat: { id: chatId } } };
}

function baseOpts() {
  return { allowlist: ALLOW, agent: "tester", now: () => NOW, source: "telegram" };
}

test("an allowlisted text update becomes one capture note through the contract", () => {
  const res = handleCaptureUpdate(vault, textUpdate(1, "100", "an idea worth keeping"), baseOpts());
  expect(res.decision.result).toBe("captured");
  expect(res.decision.chatId).toBe("100");
  expect(res.reply).toBeNull();
  const staged = listStagedCaptures(vault);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.body).toBe("an idea worth keeping");
  expect(staged[0]!.provenance.sender).toBe("100");
});

test("a non-allowlisted chat is rejected with a decision and writes no capture", () => {
  const res = handleCaptureUpdate(vault, textUpdate(2, "999", "hello"), baseOpts());
  expect(res.decision.result).toBe("rejected-chat");
  expect(res.reply).toBeNull();
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("a malformed update (no text) is a decision, not a throw", () => {
  const res = handleCaptureUpdate(
    vault,
    { update_id: 3, message: { message_id: 3, chat: { id: 100 } } },
    baseOpts(),
  );
  expect(res.decision.result).toBe("malformed");
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("/catchup replies with captures since the last acknowledged one; watermark advances only on commit", () => {
  handleCaptureUpdate(vault, textUpdate(1, "100", "first thought"), baseOpts());
  handleCaptureUpdate(vault, textUpdate(2, "100", "second thought"), baseOpts());
  const res = handleCaptureUpdate(vault, textUpdate(3, "100", CATCHUP_COMMAND), baseOpts());
  expect(res.decision.result).toBe("catchup");
  expect(res.reply).not.toBeNull();
  expect(res.reply!.chatId).toBe("100");
  expect(res.reply!.text).toContain("first thought");
  expect(res.reply!.text).toContain("second thought");
  // Rendering the reply must NOT advance the watermark: only a successful
  // delivery (commit) does, so a failed send cannot lose the catchup forever.
  expect(readCatchupWatermark(vault)).toBeNull();
  res.reply!.commit!();
  expect(readCatchupWatermark(vault)).not.toBeNull();

  // A second catchup after commit reports the empty state.
  const again = handleCaptureUpdate(vault, textUpdate(4, "100", CATCHUP_COMMAND), baseOpts());
  expect(again.reply!.text).not.toContain("first thought");
});

test("runTelegramCapture advances the catchup watermark only after the send succeeds", async () => {
  handleCaptureUpdate(vault, textUpdate(1, "100", "alpha"), baseOpts());
  handleCaptureUpdate(vault, textUpdate(2, "100", "beta"), baseOpts());
  expect(readCatchupWatermark(vault)).toBeNull();

  // A failed send must leave the watermark unchanged.
  const failing: TelegramTransport = {
    getUpdates: (offset) =>
      Promise.resolve(offset === 0 ? [textUpdate(3, "100", CATCHUP_COMMAND)] : []),
    sendMessage: () => Promise.reject(new Error("network down")),
  };
  const failedRun = await runTelegramCapture(vault, {
    transport: failing,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 1,
  });
  expect(readCatchupWatermark(vault)).toBeNull();
  expect(failedRun.decisions.some((d) => d.result === "transport-error")).toBe(true);

  // A successful send advances it.
  const okTransport: TelegramTransport = {
    getUpdates: (offset) =>
      Promise.resolve(offset === 0 ? [textUpdate(4, "100", CATCHUP_COMMAND)] : []),
    sendMessage: () => Promise.resolve(),
  };
  await runTelegramCapture(vault, {
    transport: okTransport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 1,
  });
  expect(readCatchupWatermark(vault)).not.toBeNull();
});

test("runTelegramCapture survives a transport throw, logs one decision, and keeps polling", async () => {
  let call = 0;
  const transport: TelegramTransport = {
    getUpdates: () => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("transient network failure"));
      return Promise.resolve(call === 2 ? [textUpdate(20, "100", "after the failure")] : []);
    },
    sendMessage: () => Promise.resolve(),
  };
  const result = await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 3,
  });
  // The loop did not crash: it ran every cycle, logged the transport error as a
  // decision, and still captured the update delivered after the failure.
  expect(result.cycles).toBe(3);
  expect(result.decisions.filter((d) => d.result === "transport-error")).toHaveLength(1);
  const staged = listStagedCaptures(vault);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.body).toBe("after the failure");
});

test("repeated getUpdates transport failures back off exponentially and a success resets the counter", async () => {
  const slept: number[] = [];
  let call = 0;
  const transport: TelegramTransport = {
    getUpdates: () => {
      call += 1;
      // Fail on calls 1-3, succeed (empty) on call 4, fail again on call 5.
      if (call === 4) return Promise.resolve([]);
      return Promise.reject(new Error("transport down"));
    },
    sendMessage: () => Promise.resolve(),
  };

  await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 5,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });

  // Failures 1-3 double the wait (1000, 2000, 4000); the success on call 4
  // records no sleep and resets the counter, so the failure on call 5 starts
  // the ladder over at the base wait.
  expect(slept).toEqual([1000, 2000, 4000, 1000]);
});

test("the backoff wait is capped and never grows without bound", async () => {
  const slept: number[] = [];
  const transport: TelegramTransport = {
    getUpdates: () => Promise.reject(new Error("transport down")),
    sendMessage: () => Promise.resolve(),
  };

  await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 8,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });

  // 1000, 2000, 4000, 8000, 16000, then capped at 30000 thereafter.
  expect(slept).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("a stop request during a transport backoff ends the loop promptly", async () => {
  const slept: number[] = [];
  let stop = false;
  let calls = 0;
  const transport: TelegramTransport = {
    getUpdates: () => {
      calls += 1;
      return Promise.reject(new Error("transport down"));
    },
    sendMessage: () => Promise.resolve(),
  };

  const result = await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    // No maxCycles: only shouldStop can end the loop, proving the backoff path
    // honors a stop rather than hot-looping the API forever.
    shouldStop: () => stop,
    sleep: (ms) => {
      slept.push(ms);
      stop = true;
      return Promise.resolve();
    },
  });

  // One failed poll, one backoff, then the stop observed after the sleep ends
  // the loop: no second getUpdates is issued.
  expect(calls).toBe(1);
  expect(result.cycles).toBe(1);
  expect(slept).toEqual([1000]);
  expect(result.decisions.filter((d) => d.result === "transport-error")).toHaveLength(1);
});

test("requireTelegramToken throws a typed error when the token is absent", () => {
  expect(() => requireTelegramToken(null)).toThrow(MissingTelegramTokenError);
  expect(requireTelegramToken("abc")).toBe("abc");
});

test("runTelegramCapture polls the injected transport, advances the offset, and sends replies", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const batches: TelegramUpdate[][] = [
    [textUpdate(10, "100", "captured via poll"), textUpdate(11, "999", "blocked")],
    [],
  ];
  let call = 0;
  const offsets: number[] = [];
  const transport: TelegramTransport = {
    getUpdates: (offset) => {
      offsets.push(offset);
      return Promise.resolve(batches[call++] ?? []);
    },
    sendMessage: (chatId, text) => {
      sent.push({ chatId: String(chatId), text });
      return Promise.resolve();
    },
  };

  const result = await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 2,
  });

  expect(result.cycles).toBe(2);
  expect(offsets[0]).toBe(0);
  expect(offsets[1]).toBe(12); // last update_id 11 + 1
  expect(listStagedCaptures(vault)).toHaveLength(1);
  expect(result.decisions.map((d) => d.result)).toEqual(["captured", "rejected-chat"]);
  // No unsolicited replies for plain captures or rejections.
  expect(sent).toHaveLength(0);
});

test("every handled update writes exactly one decision to the ledger", () => {
  handleCaptureUpdate(vault, textUpdate(1, "100", "keep this"), baseOpts());
  handleCaptureUpdate(vault, textUpdate(2, "999", "nope"), baseOpts());
  const log = readFileSync(captureDecisionLogPath(vault), "utf8").trim().split("\n");
  expect(log).toHaveLength(2);
  const kinds = log.map((line) => (JSON.parse(line) as { result: string }).result);
  expect(kinds).toEqual(["captured", "rejected-chat"]);
  expect(existsSync(captureDecisionLogPath(vault))).toBe(true);
});

test("two capture hosts append to their own decision shards (t_774dea61)", () => {
  withDeviceId("a", () => handleCaptureUpdate(vault, textUpdate(1, "100", "host a"), baseOpts()));
  withDeviceId("b", () => handleCaptureUpdate(vault, textUpdate(2, "200", "host b"), baseOpts()));
  const logDir = join(vault, "Brain", "log");
  expect(existsSync(join(logDir, "capture-decisions.a.jsonl"))).toBe(true);
  expect(existsSync(join(logDir, "capture-decisions.b.jsonl"))).toBe(true);
  expect(existsSync(join(logDir, "capture-decisions.jsonl"))).toBe(false);
});

// ── t_151a564c: the typed vocabulary refusal surfaces through this lane ──────

test("a pack declaring page_types without brain-capture records the refusal as a decision", () => {
  // The vault made a declaration that omits the kind this lane stamps, so
  // the capture contract refuses - and the refusal is one named decision
  // (the same refusal message the drain lane records for an unroutable
  // capture), never a throw that would kill the run before the offset
  // advances. No capture is written behind it.
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema:\n  page_types: [note]\n", "utf8");
  const res = handleCaptureUpdate(vault, textUpdate(1, "100", "an idea worth keeping"), baseOpts());
  expect(res.decision.result).toBe("refused-contract");
  expect(res.decision.reason).toContain("brain-capture");
  expect(res.decision.reason).toContain("declare it in Brain/_brain.yaml");
  expect(res.decision.capturePath).toBeNull();
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("a contract refusal replies with the escaped remedy text", () => {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema:\n  page_types: [note]\n", "utf8");
  const res = handleCaptureUpdate(vault, textUpdate(1, "100", "an idea worth keeping"), baseOpts());
  expect(res.reply).not.toBeNull();
  expect(res.reply!.chatId).toBe("100");
  expect(res.reply!.text).toContain("capture refused");
  // The reply rides the MarkdownV2 send the catchup path uses, so the
  // remedy text arrives escaped, not as a failed send.
  expect(res.reply!.text).toContain(escapeMarkdownV2("declare it in Brain/_brain.yaml"));
});

test("the run advances past a refused update and processes the valid one behind it", async () => {
  // Regression pin (v1.78.0 review round): one refused update used to reject
  // the whole poll before the offset advanced, so every restart re-fetched
  // it and died on it again, blocking every later message. Here the run
  // survives the refusal; once the operator declares the kind (the config
  // the fake transport fixes at the batch boundary), the next update in the
  // same run is captured instead of being blocked behind the refusal.
  const configPath = join(vault, "Brain", "_brain.yaml");
  writeFileSync(configPath, "schema:\n  page_types: [note]\n", "utf8");
  let call = 0;
  const offsets: number[] = [];
  const transport: TelegramTransport = {
    getUpdates: (offset) => {
      offsets.push(offset);
      call += 1;
      if (call === 1) return Promise.resolve([textUpdate(10, "100", "refused vocabulary")]);
      // The operator declared the kind between polls; the backlog flows.
      writeFileSync(configPath, "schema:\n  page_types: [note, brain-capture]\n", "utf8");
      return Promise.resolve([textUpdate(11, "100", "valid idea")]);
    },
    sendMessage: () => Promise.resolve(),
  };

  const result = await runTelegramCapture(vault, {
    transport,
    allowlist: ALLOW,
    agent: "tester",
    now: () => NOW,
    maxCycles: 2,
  });

  // The refusal is recorded, not thrown, and the offset moved past BOTH
  // updates so the valid one behind the refusal is captured.
  expect(offsets).toEqual([0, 11]);
  expect(result.lastOffset).toBe(12);
  expect(result.decisions.map((d) => d.result)).toEqual(["refused-contract", "captured"]);
  const refused = result.decisions[0]!;
  expect(refused.updateId).toBe(10);
  expect(refused.reason).toContain("brain-capture");
  const staged = listStagedCaptures(vault);
  expect(staged).toHaveLength(1);
  expect(staged[0]!.body).toBe("valid idea");
});

test("the refusal decision lands in the decision ledger like every other", () => {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema:\n  page_types: [note]\n", "utf8");
  handleCaptureUpdate(vault, textUpdate(1, "100", "an idea worth keeping"), baseOpts());
  const log = readFileSync(captureDecisionLogPath(vault), "utf8").trim().split("\n");
  expect(log).toHaveLength(1);
  const row = JSON.parse(log[0]!) as { result: string; reason: string };
  expect(row.result).toBe("refused-contract");
  expect(row.reason).toContain("schema.page_types");
});
