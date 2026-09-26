/**
 * Raw exception prose never tells a remote caller the host layout
 * (audit L11).
 *
 * The INTERNAL_ERROR channel and the tool-level error envelope forward an
 * exception's message, and Node's fs errors embed absolute paths. At
 * remote reach the vault, home and temp roots are replaced with named
 * placeholders; at local reach the operator's own transport keeps the
 * paths it needs to act on (the vault root is still redacted on the
 * INTERNAL_ERROR channel, as it always was).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { redactErrorForCaller } from "../../src/mcp/error-redaction.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

describe("redactErrorForCaller", () => {
  const vault = join(homedir(), "vaults", "main");

  test("remote reach: vault, home and temp roots become placeholders", () => {
    const raw =
      `ENOENT: no such file or directory, open '${join(vault, "notes", "x.md")}' ` +
      `(also ${join(homedir(), ".ssh", "id_ed25519")} and ${join(tmpdir(), "o2b-x", "f")})`;
    const out = redactErrorForCaller(raw, vault, "remote");
    expect(out).toContain(`<vault>${join("/", "notes", "x.md")}`);
    expect(out).toContain(`<home>${join("/", ".ssh", "id_ed25519")}`);
    expect(out).toContain(`<tmp>${join("/", "o2b-x", "f")}`);
    expect(out).not.toContain(homedir());
    expect(out).not.toContain(tmpdir());
  });

  test("a root is replaced only as a whole path segment", () => {
    const home = homedir();
    const sibling = `${home}-other${join("/", "file")}`;
    expect(redactErrorForCaller(`open '${sibling}'`, vault, "remote")).toContain(sibling);
  });

  test("local reach: only the vault root is redacted", () => {
    const outside = join(homedir(), ".config", "o2b", "config.yaml");
    const raw = `cannot read ${outside} or ${join(vault, "a.md")}`;
    const out = redactErrorForCaller(raw, vault, "local");
    expect(out).toContain(outside);
    expect(out).not.toContain(join(vault, "a.md"));
  });
});

describe("the server's error channels", () => {
  let tmp: string;
  let vault: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-error-redaction-"));
    vault = join(tmp, "vault");
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("INTERNAL_ERROR at remote reach names the page under <vault>, not the host path", async () => {
    // A preference with no `kind` makes the resource reader throw a plain
    // Error carrying the file's absolute path.
    writeFileSync(join(vault, "Brain", "preferences", "pref-x.md"), "---\nid: pref-x\n---\nb\n");
    const server = new MCPServer({ vault, configPath: null }, { reach: "remote" });
    const response = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "resources/read",
      params: { uri: "osb://preference/pref-x" },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(-32603);
    expect(response.error!.message).toContain("<vault>");
    expect(response.error!.message).not.toContain(tmp);
  });

  test.skipIf(IS_WINDOWS)(
    "a tool error at remote reach redacts a path outside the vault; at local it does not",
    async () => {
      // An unreadable o2b config makes the write tool throw a plain Error
      // naming the config file, which lives OUTSIDE the vault.
      const configPath = join(tmp, "config.yaml");
      writeFileSync(configPath, `vault: ${vault}\n`);
      chmodSync(configPath, 0o000);
      const call = async (reach: "local" | "remote"): Promise<string> => {
        const server = new MCPServer({ vault, configPath }, { reach });
        const r = (await server.handleRequest({
          jsonrpc: JSONRPC_VERSION,
          id: 2,
          method: "tools/call",
          params: {
            name: "brain_feedback",
            arguments: {
              topic: "redaction-probe",
              signal: "positive",
              principle: "Always name the config file in the error message.",
            },
          },
        })) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
        return r.error?.message ?? r.result!.content[0]!.text;
      };
      try {
        const remote = await call("remote");
        expect(remote).toContain("<tmp>");
        expect(remote).not.toContain(tmp);
        expect(await call("local")).toContain(configPath);
      } finally {
        chmodSync(configPath, 0o600);
      }
    },
  );
});
