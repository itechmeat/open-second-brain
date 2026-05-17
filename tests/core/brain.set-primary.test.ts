import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import {
  BrainConfigError,
  validateBrainConfig,
  parseBrainYaml,
} from "../../src/core/brain/policy.ts";
import { setPrimaryAgent } from "../../src/core/brain/set-primary.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-brain-setprim-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-setprim-cfg-"));
  configPath = join(configHome, "config.yaml");
  mkdirSync(configHome, { recursive: true });
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function readPrimary(): string | null {
  const text = readFileSync(brainConfigPath(vault), "utf8");
  return validateBrainConfig(parseBrainYaml(text), brainConfigPath(vault))
    .primary_agent;
}

describe("setPrimaryAgent — happy path", () => {
  test("writes a non-null value into _brain.yaml", () => {
    const r = setPrimaryAgent(vault, "hermes-vps");
    expect(r.previous).toBeNull();
    expect(r.next).toBe("hermes-vps");
    expect(r.changed).toBe(true);
    expect(readPrimary()).toBe("hermes-vps");
    expect(readFileSync(brainConfigPath(vault), "utf8")).toMatch(
      /^primary_agent: "hermes-vps"$/m,
    );
  });

  test("quotes values so inline-comment text round-trips", () => {
    const r = setPrimaryAgent(vault, "hermes lead # primary");
    expect(r.next).toBe("hermes lead # primary");
    expect(readPrimary()).toBe("hermes lead # primary");
    expect(readFileSync(brainConfigPath(vault), "utf8")).toMatch(
      /^primary_agent: "hermes lead # primary"$/m,
    );
  });

  test("trims whitespace around the new value", () => {
    setPrimaryAgent(vault, "  hermes-vps  ");
    expect(readPrimary()).toBe("hermes-vps");
  });

  test("no-op repeat returns changed: false and leaves bytes intact", () => {
    setPrimaryAgent(vault, "hermes-vps");
    const before = readFileSync(brainConfigPath(vault), "utf8");
    const r = setPrimaryAgent(vault, "hermes-vps");
    const after = readFileSync(brainConfigPath(vault), "utf8");
    expect(r.previous).toBe("hermes-vps");
    expect(r.next).toBe("hermes-vps");
    expect(r.changed).toBe(false);
    expect(after).toBe(before);
  });

  test("clears via null", () => {
    setPrimaryAgent(vault, "hermes-vps");
    const r = setPrimaryAgent(vault, null);
    expect(r.previous).toBe("hermes-vps");
    expect(r.next).toBeNull();
    expect(r.changed).toBe(true);
    expect(readPrimary()).toBeNull();
  });

  test("clear on already-null is a no-op", () => {
    const r = setPrimaryAgent(vault, null);
    expect(r.previous).toBeNull();
    expect(r.next).toBeNull();
    expect(r.changed).toBe(false);
  });

  test("preserves neighbouring blocks (dream/retire/confidence/snapshots)", () => {
    // Custom edit to a different block, then set primary.
    const cfgPath = brainConfigPath(vault);
    const original = readFileSync(cfgPath, "utf8")
      .replace(/^  candidate_threshold: 3$/m, "  candidate_threshold: 5");
    writeFileSync(cfgPath, original, "utf8");

    setPrimaryAgent(vault, "hermes-vps");
    const final = readFileSync(cfgPath, "utf8");
    expect(final).toMatch(/^primary_agent: "hermes-vps"$/m);
    expect(final).toMatch(/^  candidate_threshold: 5$/m);
  });
});

describe("setPrimaryAgent — error cases", () => {
  test("throws BrainConfigError when _brain.yaml does not exist", () => {
    const fresh = mkdtempSync(join(tmpdir(), "o2b-brain-setprim-empty-"));
    try {
      expect(() => setPrimaryAgent(fresh, "anything")).toThrow(BrainConfigError);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("empty-string name is rejected (use --clear instead)", () => {
    expect(() => setPrimaryAgent(vault, "   ")).toThrow(/non-empty/);
  });

  test("line breaks are rejected rather than written into YAML", () => {
    expect(() => setPrimaryAgent(vault, "agent\nsnapshots:")).toThrow(
      /disallowed character/,
    );
  });

  test("rewritten file still validates against the schema", () => {
    setPrimaryAgent(vault, "hermes-vps");
    const cfg = validateBrainConfig(
      parseBrainYaml(readFileSync(brainConfigPath(vault), "utf8")),
      brainConfigPath(vault),
    );
    expect(cfg.primary_agent).toBe("hermes-vps");
    expect(cfg.dream.candidate_threshold).toBe(3); // defaults intact
  });
});

describe("setPrimaryAgent — missing primary_agent line", () => {
  test("inserts the declaration after schema_version when absent", () => {
    // Hand-craft a YAML missing the primary_agent line entirely.
    const cfgPath = brainConfigPath(vault);
    const trimmed = readFileSync(cfgPath, "utf8").replace(
      /^# Optional.*\nprimary_agent: null\n\n/m,
      "",
    );
    writeFileSync(cfgPath, trimmed, "utf8");

    setPrimaryAgent(vault, "hermes-vps");
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toMatch(/^primary_agent: "hermes-vps"$/m);
    expect(text.indexOf("schema_version:")).toBeLessThan(
      text.indexOf("primary_agent:"),
    );
  });
});
