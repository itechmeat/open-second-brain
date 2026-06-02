#!/usr/bin/env -S bun
/**
 * Token-surface report (token-diet, epic t_5e6826f3).
 *
 * Prints the serialized size of the advertised MCP tool surface (what
 * every client of a non-deferred host pays per request), the hidden
 * deprecated-alias overhead, the server instructions, and - when a
 * vault is resolvable - the size of the budgeted active.md injection.
 *
 * Usage: bun run scripts/measure-token-surface.ts [--json]
 */

import { existsSync, readFileSync } from "node:fs";

import { resolveVault } from "../src/core/config.ts";
import { brainActivePath } from "../src/core/brain/paths.ts";
import { INJECT_BUDGET_CHARS_DEFAULT } from "../src/core/brain/policy.ts";
import { budgetActiveBody } from "../src/core/brain/active-budget.ts";
import { parseFrontmatterText } from "../src/core/vault.ts";
import { estimateTokens } from "../src/core/brain/text/tokenizer.ts";
import { buildInstructions } from "../src/mcp/instructions.ts";
import { buildToolTable, type ToolDefinition } from "../src/mcp/tools.ts";

interface ToolRow {
  readonly name: string;
  readonly chars: number;
  readonly tokens: number;
  readonly hidden: boolean;
}

function wireSize(tool: ToolDefinition): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }).length;
}

function sum(rows: ReadonlyArray<ToolRow>): { chars: number; tokens: number } {
  return rows.reduce((acc, r) => ({ chars: acc.chars + r.chars, tokens: acc.tokens + r.tokens }), {
    chars: 0,
    tokens: 0,
  });
}

const json = process.argv.includes("--json");

const rows: ToolRow[] = buildToolTable("full").map((t) => {
  const chars = wireSize(t);
  return {
    name: t.name,
    chars,
    tokens: estimateTokens(JSON.stringify(t.inputSchema) + t.description),
    hidden: t.hidden === true,
  };
});
const listed = rows.filter((r) => !r.hidden);
const hidden = rows.filter((r) => r.hidden);

const fullInstructions = buildInstructions({ agent: "agent", scope: "full" });
const writerInstructions = buildInstructions({ agent: "agent", scope: "writer" });

const vault = resolveVault();
let active: { raw: number; budgeted: number } | null = null;
if (vault !== null && existsSync(brainActivePath(vault))) {
  const raw = readFileSync(brainActivePath(vault), "utf8");
  const [, body] = parseFrontmatterText(raw);
  active = {
    raw: raw.length,
    budgeted: budgetActiveBody(body.trim(), INJECT_BUDGET_CHARS_DEFAULT).length,
  };
}

const report = {
  advertised_tools: listed.length,
  hidden_aliases: hidden.length,
  advertised_chars: sum(listed).chars,
  advertised_tokens_estimate: sum(listed).tokens,
  hidden_alias_chars: sum(hidden).chars,
  instructions_full_chars: fullInstructions.length,
  instructions_writer_chars: writerInstructions.length,
  active_md: active,
  top_tools: listed
    .toSorted((a, b) => b.chars - a.chars)
    .slice(0, 10)
    .map((r) => ({ name: r.name, chars: r.chars })),
};

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  process.stdout.write(
    [
      `advertised tools      ${report.advertised_tools} (${report.advertised_chars} chars, ~${report.advertised_tokens_estimate} tokens)`,
      `hidden aliases        ${report.hidden_aliases} (${report.hidden_alias_chars} chars, callable but unlisted)`,
      `instructions (full)   ${report.instructions_full_chars} chars`,
      `instructions (writer) ${report.instructions_writer_chars} chars`,
      active
        ? `active.md             ${active.raw} chars raw -> ${active.budgeted} chars injected (budget ${INJECT_BUDGET_CHARS_DEFAULT})`
        : "active.md             (no vault resolved)",
      "",
      "top tools by wire size:",
      ...report.top_tools.map((t) => `  ${String(t.chars).padStart(6)}  ${t.name}`),
    ].join("\n") + "\n",
  );
}
