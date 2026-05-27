/**
 * Shared test fixtures: build a sandbox vault and a plugin-repo skeleton.
 * Mirrors `tests/fixtures.py` used by the legacy Python suite.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_MANUAL_FILE, BRAIN_ROOT_REL } from "../../src/core/brain/paths.ts";

export function createSandboxVault(root: string, name = "Sandbox Brain"): string {
  const vault = join(root, "sandbox-vault");
  mkdirSync(join(vault, BRAIN_ROOT_REL), { recursive: true });
  writeFileSync(
    join(vault, BRAIN_ROOT_REL, BRAIN_MANUAL_FILE),
    `---\ntitle: ${name}\ntype: operating-manual\n---\n\n# ${name}\n`,
  );
  writeFileSync(
    join(vault, "Concept.md"),
    "---\ntitle: Sandbox Concept\n---\n\nLinked to [[Other]].\n",
  );
  writeFileSync(join(vault, "Other.md"), "# Other\n");
  return vault;
}

export function createPluginRepo(root: string, valid = true): string {
  const repo = join(root, "plugin-repo");
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  mkdirSync(join(repo, ".codex-plugin"), { recursive: true });
  mkdirSync(join(repo, "plugins", "hermes"), { recursive: true });
  if (valid) {
    writeFileSync(
      join(repo, ".claude-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "test",
          version: "1.0.0",
          description: "test manifest",
          author: { name: "tests" },
          license: "MIT",
          repository: "https://example.invalid/test",
          keywords: ["test"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repo, ".codex-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "test",
          version: "1.0.0",
          description: "test manifest",
          skills: "./skills",
          keywords: ["test"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repo, "plugins", "hermes", "plugin.yaml"),
      'name: test\nversion: "1.0.0"\ndescription: test manifest\n',
    );
    writeFileSync(
      join(repo, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "test-plugin",
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      ),
    );
    mkdirSync(join(repo, "openclaw"), { recursive: true });
    writeFileSync(join(repo, "openclaw", "index.js"), "// plugin entry\n");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "test-plugin", openclaw: { extensions: ["./openclaw/index.js"] } }),
    );
  } else {
    writeFileSync(join(repo, ".claude-plugin", "plugin.json"), '{"name": "test"}');
    writeFileSync(join(repo, ".codex-plugin", "plugin.json"), '{"name": "test"}');
    writeFileSync(join(repo, "plugins", "hermes", "plugin.yaml"), "name: test\n");
    writeFileSync(join(repo, "openclaw.plugin.json"), "{}");
  }
  return repo;
}
