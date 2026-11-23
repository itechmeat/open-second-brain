/**
 * A fake dream agent (change `dream-launched-agent`, tasks rule 2): a
 * script the worker starts in place of a real agent. It reads the MCP
 * config the worker wrote, starts the one server in it, speaks MCP over
 * that server's standard input and output, and behaves as its mode says:
 *
 *  - `answer-all`: take, answer, repeat until no item, finish;
 *  - `no-finish`: as `check`, but never calls finish;
 *  - `check`: answers the canaries of `o2b dream agent check` correctly;
 *  - `wrong`: answers every item with a value of the wrong shape, then finishes;
 *  - `exit-early`: takes one item and exits 1 without answering;
 *  - `hang`: takes one item and never ends;
 *  - `hang-before`: starts the server and never calls a tool;
 *  - `no-tools`: starts nothing and exits 0;
 *  - `fail`: exits 3 at once.
 *
 * Usage: `bun fake-dream-agent.ts <mcp-config> <mode> [<prompt>]`.
 * A text item is answered with `FAKE_DREAM_TEXT` when set (else a fixed
 * note), a choice with its first option, a probability with 0.9.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [configPath, mode] = process.argv.slice(2);

if (mode === "no-tools") process.exit(0);
if (mode === "fail") process.exit(3);

const config = JSON.parse(readFileSync(configPath!, "utf8")) as {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
};
const server = Object.values(config.mcpServers)[0]!;
const child = spawn(server.command, server.args, {
  env: { ...process.env, ...server.env },
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout! });
const waiting = new Map<number, (value: any) => void>();
lines.on("line", (line) => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});
let next = 1;
function request(method: string, params?: unknown): Promise<any> {
  const id = next++;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiting.set(id, resolve));
}
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await request("tools/call", { name, arguments: args });
  return JSON.parse(response.result.content[0].text);
}

function answerFor(item: any): Record<string, unknown> {
  const shape = item.answer_shape ?? {};
  if (mode === "wrong") return { value: { nonsense: true } };
  if (mode === "check" || mode === "no-finish" || mode === "fail-after-finish") {
    return shape.answer_with === "text" ? { text: "canary" } : { value: "blue" };
  }
  if (shape.answer_with === "text" || shape.type === "text") {
    return { text: process.env["FAKE_DREAM_TEXT"] ?? "---\nkind: rollup\n---\nA fake summary.\n" };
  }
  if (Array.isArray(shape.options)) return { value: shape.options[0], confidence: 0.9 };
  if (Array.isArray(shape.enum)) return { value: shape.enum[0] };
  if (shape.type === "object" && process.env["FAKE_DREAM_VALUE"] !== undefined) {
    return { value: JSON.parse(process.env["FAKE_DREAM_VALUE"]!) };
  }
  return { value: 0.9 };
}

await request("initialize", { protocolVersion: "2025-06-18" });
if (mode === "hang-before") await new Promise(() => {});
await request("tools/list");
for (;;) {
  const taken = await tool("dream_work_take");
  if (taken.item === null || taken.item === undefined) break;
  if (mode === "exit-early") process.exit(1);
  if (mode === "hang") await new Promise(() => {});
  await tool("dream_work_answer", {
    id: taken.item.id,
    generation: taken.item.generation,
    model: "fake-model-1",
    ...answerFor(taken.item),
  });
}
if (mode !== "no-finish") await tool("dream_work_finish");
child.stdin!.end();
child.kill();
process.exit(mode === "fail-after-finish" ? 1 : 0);
