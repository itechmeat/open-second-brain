import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe(".mcp.json shipped with the plugin", () => {
  const file = JSON.parse(
    readFileSync("/srv/projects/open-second-brain/.mcp.json", "utf8"),
  );
  test("declares both open-second-brain and -writer entries", () => {
    expect(Object.keys(file.mcpServers).sort()).toEqual([
      "open-second-brain",
      "open-second-brain-writer",
    ]);
  });
  test("writer entry passes --scope writer and alwaysLoad: true", () => {
    const w = file.mcpServers["open-second-brain-writer"];
    expect(w.command).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/o2b");
    expect(w.args).toEqual(["mcp", "--scope", "writer"]);
    expect(w.alwaysLoad).toBe(true);
  });
  test("full server has no alwaysLoad flag", () => {
    const f = file.mcpServers["open-second-brain"];
    expect(f.alwaysLoad).toBeUndefined();
  });
});
