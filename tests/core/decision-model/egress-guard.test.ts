/**
 * The private-data guard of the topic and agent-context uses (design
 * D10, "Private data stays local"): a hosted provider entry never
 * receives a private record unless the operator opted the use in through
 * `decision_model_private_uses`; a chain that mixes local and hosted
 * entries counts as hosted, because a fallthrough must not carry private
 * text to the hosted entry; `<private>` regions never leave the machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDecisionModelConfig,
  resolvedProviderEntries,
} from "../../../src/core/decision-model/config.ts";
import {
  isLoopbackUrl,
  mayShareRecord,
  providerKeepsDataLocal,
  shareableHeadFields,
} from "../../../src/core/decision-model/egress-guard.ts";
import { runDecision } from "../../../src/core/decision-model/run.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeSystemOne } from "../../helpers/fake-decision-provider.ts";

const KEY_VAR = "O2B_TEST_EGRESS_KEY";
const ENV = { [KEY_VAR]: FAKE_DECISION_KEY } as NodeJS.ProcessEnv;

function config(extra: Record<string, string> = {}): Record<string, string> {
  return {
    decision_model_enabled: "true",
    decision_model_provider: "typesafe",
    decision_model_env_key: KEY_VAR,
    decision_model_uses: "topic_route:shadow",
    ...extra,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dm-egress-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("providerKeepsDataLocal", () => {
  const cfg = resolveDecisionModelConfig({ env: ENV, config: config(), vault: null });

  test("a loopback entry keeps data local", () => {
    const entry = {
      ...resolvedProviderEntries(cfg)[0]!,
      baseUrl: "http://127.0.0.1:8000",
    };
    expect(providerKeepsDataLocal(entry)).toBe(true);
    const localhost = { ...entry, baseUrl: "http://localhost:3000" };
    expect(providerKeepsDataLocal(localhost)).toBe(true);
    const v6 = { ...entry, baseUrl: "http://[::1]:8080" };
    expect(providerKeepsDataLocal(v6)).toBe(true);
  });

  test("a hosted entry does not", () => {
    const hosted = {
      ...resolvedProviderEntries(cfg)[0]!,
      baseUrl: "https://api.typesafe.ai",
    };
    expect(providerKeepsDataLocal(hosted)).toBe(false);
  });
});

describe("isLoopbackUrl at the edges", () => {
  test("hosts that only look local count as hosted", () => {
    // Userinfo before a loopback address: the host is the part after `@`.
    expect(isLoopbackUrl("http://127.0.0.1@evil.example/v1")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.example:8000")).toBe(false);
    // A trailing dot and an IPv4-mapped address err towards hosted.
    expect(isLoopbackUrl("http://localhost.:8000")).toBe(false);
    expect(isLoopbackUrl("http://[::ffff:127.0.0.1]:8000")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  test("a loopback server that redirects elsewhere is refused: the target receives nothing", async () => {
    const target = await startFakeSystemOne();
    const local = await startFakeSystemOne();
    try {
      local.setReply(() => ({ status: 302, headers: { location: `${target.url}/v1/systemone` } }));
      const cfg = resolveDecisionModelConfig({
        env: ENV,
        config: {
          decision_model_enabled: "true",
          decision_model_provider: "compatible",
          decision_model_base_url: local.url,
          decision_model_id: "local-model",
          decision_model_env_key: KEY_VAR,
          decision_model_uses: "rerank:shadow",
        },
        vault: null,
        thresholdsPath: null,
      });
      const result = await runDecision(
        "rerank",
        () => ({
          kind: "ok",
          state: { query: "q", passages: { P0: "text" } },
          candidateCount: 1,
          context: null,
        }),
        () => ({ rel_0: { type: "noul", instructions: "relevant?" } }),
        { config: cfg, env: ENV },
      );
      expect(result.status).toBe("degraded");
      expect(local.requests).toHaveLength(1);
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
      await local.close();
    }
  });
});

describe("mayShareRecord", () => {
  test("a record that is not private may always be sent", () => {
    const hosted = resolveDecisionModelConfig({ env: ENV, config: config(), vault: null });
    expect(mayShareRecord(hosted, "topic_route", false)).toBe(true);
    const loopback = resolveDecisionModelConfig({
      env: {},
      config: { decision_model_enabled: "true", decision_model_provider: "laya" },
      vault: null,
    });
    expect(mayShareRecord(loopback, "topic_route", false)).toBe(true);
  });

  test("a private record goes only to a chain that is local end to end", () => {
    const loopback = resolveDecisionModelConfig({
      env: {},
      config: { decision_model_enabled: "true", decision_model_provider: "laya" },
      vault: null,
    });
    expect(mayShareRecord(loopback, "topic_route", true)).toBe(true);
    const hosted = resolveDecisionModelConfig({ env: ENV, config: config(), vault: null });
    expect(mayShareRecord(hosted, "topic_route", true)).toBe(false);
  });

  test("a mixed chain counts as hosted", () => {
    const mixed = resolveDecisionModelConfig({
      env: ENV,
      config: config({
        decision_model_providers: "typesafe,laya",
      }),
      vault: null,
    });
    expect(resolvedProviderEntries(mixed).length).toBe(2);
    expect(mayShareRecord(mixed, "topic_route", true)).toBe(false);
  });

  test("the opt-in arms one use at a time", () => {
    const opted = resolveDecisionModelConfig({
      env: ENV,
      config: config({
        decision_model_uses: "topic_route:shadow,neighbour_relevant:shadow",
        decision_model_private_uses: "topic_route",
      }),
      vault: null,
    });
    expect(mayShareRecord(opted, "topic_route", true)).toBe(true);
    expect(mayShareRecord(opted, "neighbour_relevant", true)).toBe(false);
  });
});

describe("shareableHeadFields", () => {
  const head = {
    title: "Halcyon acquisition",
    description: "Shard compaction",
    goal: null,
    privateFields: { title: true, description: false, goal: false },
  };

  test("a private head field of a shared topic stays home with a hosted chain", () => {
    const hosted = resolveDecisionModelConfig({ env: ENV, config: config(), vault: null });
    expect(shareableHeadFields(hosted, "topic_route", head)).toEqual({
      title: "",
      description: "Shard compaction",
      goal: "",
    });
  });

  test("the opt-in lets the private field go", () => {
    const opted = resolveDecisionModelConfig({
      env: ENV,
      config: config({ decision_model_private_uses: "topic_route" }),
      vault: null,
    });
    expect(shareableHeadFields(opted, "topic_route", head).title).toBe("Halcyon acquisition");
  });
});

describe("decision_model_private_uses parsing", () => {
  test("a valid list resolves into privateHostedUses", () => {
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: config({ decision_model_private_uses: "topic_route,neighbour_relevant" }),
      vault: null,
    });
    expect(cfg.privateHostedUses).toEqual(["topic_route", "neighbour_relevant"]);
  });

  test("absent means empty", () => {
    const cfg = resolveDecisionModelConfig({ env: ENV, config: config(), vault: null });
    expect(cfg.privateHostedUses ?? []).toEqual([]);
  });

  test("an unknown use makes the config invalid, naming the key", () => {
    const cfg = resolveDecisionModelConfig({
      env: ENV,
      config: config({ decision_model_private_uses: "topic_route,rerank" }),
      vault: null,
    });
    expect(cfg.status).toBe("invalid");
    expect(cfg.errors.join("\n")).toContain("decision_model_private_uses");
    expect(cfg.errors.join("\n")).toContain("rerank");
  });

  test("the environment override wins over the machine config", () => {
    const cfg = resolveDecisionModelConfig({
      env: { ...ENV, OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: "event_kind" },
      config: config({ decision_model_private_uses: "topic_route" }),
      vault: null,
    });
    expect(cfg.privateHostedUses).toEqual(["event_kind"]);
  });
});
