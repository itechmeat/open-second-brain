/**
 * `pathsForCaller` at remote reach rewrites a host path wherever it sits in
 * a string, prose included, but only a path under one of this machine's
 * own roots (home, vault, store, device state, temp, config folder): a
 * path that merely looks like one (another user's home in a quoted note,
 * a URL path, a sibling that only shares a name prefix with a root) is
 * left exactly as written. Local reach and `expose_host_paths` keep the
 * result as it is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { VIEW_TARGET_ENV } from "../../src/core/view/constants.ts";
import { forgetMachineStateCache } from "../../src/core/state/machine-state.ts";
import { pathsForCaller, REDACTED_DEVICE_PATH } from "../../src/mcp/brain/device-path.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

const remote = (e: StoreEnv, value: unknown, configPath = e.configPath) =>
  pathsForCaller(value, e.vault, TRANSPORT_REACH.remote, configPath);

describe("pathsForCaller in prose", () => {
  test("a host path inside a message is named as the device-path rule names it", () => {
    env = makeStoreEnv("osb-paths-prose-");
    const note = join(env.vault, "notes", "a.md");
    const out = remote(env, {
      checks: [{ message: `vault exists and is writable: ${env.vault}` }],
      warning: `could not read ${note}: busy`,
      list: [`config at ${env.configPath}.`],
    }) as { checks: Array<{ message: string }>; warning: string; list: string[] };
    expect(out.checks[0]!.message).toBe("vault exists and is writable: <vault>");
    expect(out.warning).toBe("could not read notes/a.md: busy");
    expect(out.list[0]).toBe(`config at ${REDACTED_DEVICE_PATH}.`);
  });

  test("text that only looks like a path is left as written", () => {
    env = makeStoreEnv("osb-paths-lookalike-");
    // A sibling of the temp root is a lookalike only when the temp root is
    // not itself under the home root (a `TMPDIR` under `$HOME` makes the
    // sibling a real home path, which is rewritten as it should be).
    const tmpUnderHome = resolve(tmpdir()).startsWith(`${resolve(homedir())}${sep}`);
    const text = [
      "> my old laptop kept it in /home/bob/notes and /Users/alice/x.md",
      "GET /v1/models, see /etc/hosts",
      ...(tmpUnderHome
        ? []
        : [`a sibling of the temp root: ${tmpdir()}x/old.md and ${tmpdir()}-old`]),
      "C:\\Users\\someone\\file.txt",
    ].join("\n");
    expect(remote(env, { body: text })).toEqual({ body: text });
  });

  test("a root inside a longer path or a URL is not a root", () => {
    env = makeStoreEnv("osb-paths-prefix-");
    const tmp = tmpdir();
    const text = [`kept in /var${tmp}/x.md`, `see https://host${tmp}/a`, `relative${tmp}/b`].join(
      "\n",
    );
    expect(remote(env, { body: text })).toEqual({ body: text });
  });

  test("a parsed body keeps a __proto__ key as a key", () => {
    env = makeStoreEnv("osb-paths-proto-");
    const body = JSON.parse('{"__proto__": {"polluted": true}, "a": "b"}') as unknown;
    const out = remote(env, { body }) as { body: Record<string, unknown> };
    expect(Object.keys(out.body)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(JSON.stringify(out.body)).toBe('{"__proto__":{"polluted":true},"a":"b"}');
  });

  test("a field that is the vault root itself never reads as empty", () => {
    env = makeStoreEnv("osb-paths-vault-root-");
    expect(remote(env, { vault: env.vault })).toEqual({ vault: "<vault>" });
  });

  test.skipIf(process.platform !== "win32" && process.platform !== "darwin")(
    "a host path spelled in another case is named in prose too",
    () => {
      env = makeStoreEnv("osb-paths-case-");
      const note = join(env.vault, "notes", "a.md").toUpperCase();
      const out = remote(env, { message: `could not read ${note}` }) as { message: string };
      expect(out.message).not.toContain(note);
    },
  );

  test("a JSON text body names no host path, whatever escapes spell it", () => {
    env = makeStoreEnv("osb-paths-json-");
    const note = join(env.vault, "notes", "a.md");
    // `JSON.stringify` doubles every backslash of a Windows path; a
    // serializer may also escape each forward slash as `\/`.
    const native = JSON.stringify({ file: note, says: `see ${note}` }, null, 2);
    const slashes = JSON.stringify({ file: note }).replaceAll("/", "\\/");
    const out = remote(env, { contents: [{ text: native }, { text: slashes }] }) as {
      contents: Array<{ text: string }>;
    };
    expect(JSON.parse(out.contents[0]!.text)).toEqual({
      file: "notes/a.md",
      says: "see notes/a.md",
    });
    expect(out.contents[0]!.text).toBe(
      JSON.stringify({ file: "notes/a.md", says: "see notes/a.md" }, null, 2),
    );
    expect(JSON.parse(out.contents[1]!.text)).toEqual({ file: "notes/a.md" });
    for (const { text } of out.contents) expect(text).not.toContain(basename(env.parent));
  });

  test("the human view folder is a root too, wherever it sits", () => {
    env = makeStoreEnv("osb-paths-view-");
    // A folder under none of the other roots (it need not exist).
    const view = resolve("/o2b-view-elsewhere");
    const saved = process.env[VIEW_TARGET_ENV];
    process.env[VIEW_TARGET_ENV] = view;
    try {
      const out = remote(env, {
        view_target: { path: view, error: null },
        message: `the human view folder ${join(view, "about-me.md")} is busy`,
      });
      expect(JSON.stringify(out)).not.toContain("o2b-view-elsewhere");
    } finally {
      if (saved === undefined) delete process.env[VIEW_TARGET_ENV];
      else process.env[VIEW_TARGET_ENV] = saved;
    }
  });

  test("local reach and expose_host_paths keep every path", () => {
    env = makeStoreEnv("osb-paths-keep-");
    const value = { message: `at ${env.vault}` };
    expect(pathsForCaller(value, env.vault, TRANSPORT_REACH.local, env.configPath)).toEqual(value);
    writeFileSync(env.configPath, `vault: ${env.vault}\nexpose_host_paths: true\n`);
    expect(remote(env, value)).toEqual(value);
  });

  test("a refusal frame and a resource answer at remote reach name no host path", async () => {
    env = makeStoreEnv("osb-paths-frame-");
    const server = new MCPServer(
      { vault: env.vault, configPath: env.configPath },
      { reach: TRANSPORT_REACH.remote },
    );
    // The refusal echoes the uri it was handed, a host path among it.
    const reply = (await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: `file://${env.vault}/notes/a.md` },
    })) as { error: { message: string } };
    expect(reply.error.message).toContain("notes/a.md");
    expect(reply.error.message).not.toContain(env.parent);
  });
});
