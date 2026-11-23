/**
 * The dream agent's machine settings and presets (change
 * `dream-launched-agent`, design D1; spec "The launch command is a
 * machine setting with fallbacks"; task 3.1).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import {
  dreamAgentCommandHash,
  parseDreamAgentCommand,
  resolveDreamAgentConfig,
} from "../../../../src/core/brain/dream-queue/agent-config.ts";
import {
  DREAM_AGENT_PRESETS,
  dreamAgentPreset,
} from "../../../../src/core/brain/dream-queue/agent-presets.ts";
import { discoverConfig, setConfigJsonValue } from "../../../../src/core/config.ts";
import { SETTING_KEYS } from "../../../../src/core/store/constants.ts";
import { tempDirs } from "../../../helpers/temp-dir.ts";

const mkTemp = tempDirs();

describe("dream_agent_command", () => {
  test("a JSON array is the program and its arguments, nothing split", () => {
    const args = ["two words", `"quoted" 'single'`, "Привет", "{prompt}"];
    const command = parseDreamAgentCommand(JSON.stringify(["/usr/bin/agent", ...args]));
    expect(command).toEqual({ label: "custom", preset: null, program: "/usr/bin/agent", args });
  });

  test("an invalid value is an error that names the key, never the value", () => {
    for (const raw of ["[1, 2]", "[]", "[not json", "no-such-preset-secret-word"]) {
      const cfg = resolveDreamAgentConfig({ config: { dream_agent_command: raw }, env: {} });
      expect(cfg.command).toBeNull();
      expect(cfg.errors).toHaveLength(1);
      expect(cfg.errors[0]).toContain("dream_agent_command");
      expect(cfg.errors[0]).not.toContain("secret-word");
    }
  });

  test("read from the machine config and from its environment twin, the twin first", () => {
    const dir = mkTemp("o2b-agent-config-");
    const path = join(dir, "config.yaml");
    writeFileSync(path, "device_id: dev-a\n");
    setConfigJsonValue("dream_agent_command", ["/opt/a b/agent", `say "hi" \\ there`], path);
    const data = discoverConfig(path).data;
    expect(resolveDreamAgentConfig({ config: data, env: {} }).command?.args).toEqual([
      `say "hi" \\ there`,
    ]);
    const twin = resolveDreamAgentConfig({
      config: data,
      env: { OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND: '["/usr/bin/other"]' },
    });
    expect(twin.command?.program).toBe("/usr/bin/other");
  });

  test("the keys are not shared settings", () => {
    for (const key of [
      "dream_agent_command",
      "dream_agent_fallbacks",
      "dream_agent_budget_ms",
      "dream_agent_items",
      "dream_agent_private",
    ]) {
      expect((SETTING_KEYS as ReadonlyArray<string>).includes(key)).toBe(false);
    }
  });

  test("fallbacks, bounds and the private switch", () => {
    const cfg = resolveDreamAgentConfig({
      config: {
        dream_agent_command: '["/usr/bin/a"]',
        dream_agent_fallbacks: '[["/usr/bin/b", "x"], 7]',
        dream_agent_budget_ms: "60000",
        dream_agent_items: "3",
        dream_agent_private: "off",
      },
      env: {},
    });
    expect(cfg.fallbacks.map((c) => c.program)).toEqual(["/usr/bin/b"]);
    expect(cfg.errors).toHaveLength(1);
    expect(cfg.budgetMs).toBe(60_000);
    expect(cfg.items).toBe(3);
    expect(cfg.privateAllowed).toBe(false);
    expect(resolveDreamAgentConfig({ config: {}, env: {} })).toMatchObject({
      command: null,
      budgetMs: 300_000,
      items: 50,
      privateAllowed: true,
    });
  });

  test("the hash follows the program and the arguments", () => {
    const a = parseDreamAgentCommand('["/usr/bin/a", "x"]')!;
    const b = parseDreamAgentCommand('["/usr/bin/a", "y"]')!;
    expect(dreamAgentCommandHash(a)).not.toBe(dreamAgentCommandHash(b));
    expect(dreamAgentCommandHash(a)).toBe(
      dreamAgentCommandHash(parseDreamAgentCommand('["/usr/bin/a", "x"]')!),
    );
  });
});

describe("presets", () => {
  test("every shipped preset restricts the session and names its verified version", () => {
    for (const [name, preset] of Object.entries(DREAM_AGENT_PRESETS)) {
      expect(preset.restricts).toBe(true);
      expect(preset.verifiedWith).not.toBe("");
      expect(dreamAgentPreset(name)).toBe(preset);
    }
  });
});
