import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBrainConfig } from "../../../src/core/brain/policy.ts";

function vaultWith(yaml: string): string {
  const v = mkdtempSync(join(tmpdir(), "o2b-policy-"));
  mkdirSync(join(v, "Brain"), { recursive: true });
  writeFileSync(join(v, "Brain", "_brain.yaml"), yaml, "utf8");
  return v;
}

describe("discipline_report config", () => {
  test("missing section → discipline_report undefined", () => {
    const v = vaultWith("schema_version: 1\n");
    const cfg = loadBrainConfig(v);
    expect(cfg.discipline_report).toBeUndefined();
    rmSync(v, { recursive: true });
  });

  test("populated section is parsed verbatim", () => {
    const v = vaultWith(
      "schema_version: 1\n" +
        "discipline_report:\n" +
        "  enabled: true\n" +
        "  timezone: Europe/Belgrade\n" +
        "  watched_paths:\n" +
        "    - /srv/projects/foo\n" +
        "  known_agents:\n" +
        "    - '@claude-vps-agent'\n",
    );
    const cfg = loadBrainConfig(v);
    expect(cfg.discipline_report).toEqual({
      enabled: true,
      timezone: "Europe/Belgrade",
      watched_paths: ["/srv/projects/foo"],
      known_agents: ["@claude-vps-agent"],
    });
    rmSync(v, { recursive: true });
  });
});
