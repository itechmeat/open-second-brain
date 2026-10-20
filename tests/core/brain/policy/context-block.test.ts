/**
 * The two blocks of the cycle-20261020 substrate wave (`cross_topic:`
 * and `context:`) plus the environment channel that overrides the
 * context window. Both blocks are operator opt-ins whose ABSENCE must
 * leave a vault byte-identical, so the acceptance cases pin the stored
 * shape and the rejection cases make a typo a named load error rather
 * than a silently ignored key: an unknown top-level key only warns
 * forward-compat, so a misspelled block would otherwise resolve to the
 * default with no sign of why.
 *
 * Out-of-range but well-formed numeric values are ACCEPTED here - these
 * parsers store what the operator declared, they do not second-guess it.
 * What the consumer does next differs by block: the cross-topic resolver
 * floors its knobs (disclosing every clamp), while the context window's
 * operator declarations pass through the resolver UNCLAMPED - only the
 * resolver's guessed answers clamp to its band (model-window.ts;
 * design decision 2).
 */

import { describe, expect, test } from "bun:test";

import {
  MODEL_CONTEXT_WINDOW_ENV_KEY,
  resolveModelContextWindowEnvTokens,
} from "../../../../src/core/config.ts";
import {
  CONTEXT_WINDOW_TOKENS_DEFAULT,
  parseContextBlock,
  parseCrossTopicBlock,
} from "../../../../src/core/brain/policy.ts";
import { BrainConfigError } from "../../../../src/core/brain/policy/errors.ts";
import {
  validateBrainConfig,
  validateBrainConfigDetailed,
} from "../../../../src/core/brain/policy/validate.ts";
import {
  KeyIndexCollector,
  type BlockParseContext,
} from "../../../../src/core/brain/policy/key-index.ts";
import { parseBrainYaml } from "../../../../src/core/brain/yaml-parse.ts";

function load(block: string) {
  return validateBrainConfigDetailed(
    parseBrainYaml(`schema_version: 1\n${block}`),
    "<test fixture>",
  );
}

function blockContext(obj: Record<string, unknown>): BlockParseContext {
  return { obj, source: "<test fixture>", warnings: [], keys: new KeyIndexCollector() };
}

function expectFieldError(block: string, field: string): void {
  let caught: unknown;
  try {
    load(block);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BrainConfigError);
  expect((caught as BrainConfigError).field).toBe(field);
}

describe("cross_topic block", () => {
  test("the parsers are re-exported from the public policy surface", () => {
    expect(parseCrossTopicBlock(blockContext({ cross_topic: { enabled: true } }))).toEqual({
      enabled: true,
    });
    expect(parseContextBlock(blockContext({ context: { window_tokens: 400000 } }))).toEqual({
      window_tokens: 400000,
    });
  });

  test("the full block parses to a frozen partial config", () => {
    const { config, warnings } = load(
      "cross_topic:\n  enabled: true\n  min_topics: 3\n  jaccard: 0.5\n",
    );
    expect(warnings).toEqual([]);
    expect(config.cross_topic).toEqual({ enabled: true, min_topics: 3, jaccard: 0.5 });
    expect(Object.isFrozen(config.cross_topic)).toBe(true);
  });

  test("a vault without the block has no cross_topic key", () => {
    const config = validateBrainConfig(parseBrainYaml("schema_version: 1\n"), "<test fixture>");
    expect("cross_topic" in config).toBe(false);
  });

  test("an absent sub-key stays absent, exactly as declared", () => {
    expect(load("cross_topic:\n  enabled: true\n").config.cross_topic).toEqual({ enabled: true });
  });

  test("enabled: false parses - the explicit spelling of the absent behaviour", () => {
    expect(load("cross_topic:\n  enabled: false\n").config.cross_topic).toEqual({
      enabled: false,
    });
  });

  test("a non-boolean enabled is a hard error", () => {
    expectFieldError("cross_topic:\n  enabled: yes\n", "cross_topic.enabled");
    expectFieldError("cross_topic:\n  enabled: 1\n", "cross_topic.enabled");
  });

  test("min_topics outside the positive integers is a hard error", () => {
    expectFieldError("cross_topic:\n  min_topics: 0\n", "cross_topic.min_topics");
    expectFieldError("cross_topic:\n  min_topics: -1\n", "cross_topic.min_topics");
    expectFieldError("cross_topic:\n  min_topics: 2.5\n", "cross_topic.min_topics");
    expectFieldError("cross_topic:\n  min_topics: two\n", "cross_topic.min_topics");
  });

  test("min_topics: 1 is stored as declared - the resolver floors it, not the parser (finding 82)", () => {
    expect(load("cross_topic:\n  min_topics: 1\n").config.cross_topic).toEqual({
      min_topics: 1,
    });
  });

  test("jaccard outside [0, 1] is a hard error, and the endpoints are accepted", () => {
    expectFieldError("cross_topic:\n  jaccard: 1.5\n", "cross_topic.jaccard");
    expectFieldError("cross_topic:\n  jaccard: -0.1\n", "cross_topic.jaccard");
    expect(load("cross_topic:\n  jaccard: 0\n").config.cross_topic?.jaccard).toBe(0);
    expect(load("cross_topic:\n  jaccard: 1\n").config.cross_topic?.jaccard).toBe(1);
  });

  test("an unknown sub-key warns and does not error", () => {
    const { config, warnings } = load("cross_topic:\n  enabled: true\n  future_knob: 3\n");
    expect(config.cross_topic?.enabled).toBe(true);
    expect(warnings.map((w) => w.message)).toEqual([
      "cross_topic.future_knob: unknown field ignored (forward-compat)",
    ]);
  });

  test("a block that is not a map is a hard error", () => {
    expectFieldError("cross_topic: 5\n", "cross_topic");
  });
});

describe("context block", () => {
  test("window_tokens parses to the declared value", () => {
    const { config, warnings } = load("context:\n  window_tokens: 1000000\n");
    expect(warnings).toEqual([]);
    expect(config.context).toEqual({ window_tokens: 1000000 });
    expect(Object.isFrozen(config.context)).toBe(true);
  });

  test("a vault without the block has no context key", () => {
    const config = validateBrainConfig(parseBrainYaml("schema_version: 1\n"), "<test fixture>");
    expect("context" in config).toBe(false);
  });

  test("out-of-range values are accepted and stored - the parser never clamps", () => {
    expect(load("context:\n  window_tokens: 50\n").config.context).toEqual({ window_tokens: 50 });
    expect(load("context:\n  window_tokens: 5000000\n").config.context).toEqual({
      window_tokens: 5000000,
    });
  });

  test("a value outside the positive integers is a hard error", () => {
    expectFieldError("context:\n  window_tokens: 0\n", "context.window_tokens");
    expectFieldError("context:\n  window_tokens: -100\n", "context.window_tokens");
    expectFieldError("context:\n  window_tokens: 2.5\n", "context.window_tokens");
    expectFieldError("context:\n  window_tokens: big\n", "context.window_tokens");
  });

  test("an unknown sub-key warns and does not error", () => {
    const { config, warnings } = load("context:\n  window_tokens: 400000\n  future_knob: 1\n");
    expect(config.context?.window_tokens).toBe(400000);
    expect(warnings.map((w) => w.message)).toEqual([
      "context.future_knob: unknown field ignored (forward-compat)",
    ]);
  });

  test("a block that is not a map is a hard error", () => {
    expectFieldError("context: 200000\n", "context");
  });
});

describe("the model context window env helper", () => {
  function withEnv(value: string | undefined, run: () => void): void {
    const previous = process.env[MODEL_CONTEXT_WINDOW_ENV_KEY];
    if (value === undefined) delete process.env[MODEL_CONTEXT_WINDOW_ENV_KEY];
    else process.env[MODEL_CONTEXT_WINDOW_ENV_KEY] = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env[MODEL_CONTEXT_WINDOW_ENV_KEY];
      else process.env[MODEL_CONTEXT_WINDOW_ENV_KEY] = previous;
    }
  }

  test("the env key is the documented one and the default constant is exported", () => {
    expect(MODEL_CONTEXT_WINDOW_ENV_KEY).toBe("OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW");
    expect(CONTEXT_WINDOW_TOKENS_DEFAULT).toBe(200_000);
  });

  test("an unset variable resolves to undefined", () => {
    withEnv(undefined, () => {
      expect(resolveModelContextWindowEnvTokens()).toBeUndefined();
    });
  });

  test("a blank variable is unset", () => {
    withEnv("   ", () => {
      expect(resolveModelContextWindowEnvTokens()).toBeUndefined();
    });
  });

  test("an integer is parsed", () => {
    withEnv("400000", () => {
      expect(resolveModelContextWindowEnvTokens()).toBe(400_000);
    });
  });

  test("out-of-range integers are accepted - passed through downstream, not refused", () => {
    withEnv("50", () => {
      expect(resolveModelContextWindowEnvTokens()).toBe(50);
    });
    withEnv("5000000", () => {
      expect(resolveModelContextWindowEnvTokens()).toBe(5_000_000);
    });
  });

  test("a value outside the positive integers fails fast, naming the key", () => {
    for (const garbage of ["big", "2.5", "0", "-5"]) {
      withEnv(garbage, () => {
        expect(() => resolveModelContextWindowEnvTokens()).toThrow(
          `${MODEL_CONTEXT_WINDOW_ENV_KEY} must be a positive integer`,
        );
      });
    }
  });
});
