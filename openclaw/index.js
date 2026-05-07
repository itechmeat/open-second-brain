/**
 * OpenClaw native plugin entry for Open Second Brain.
 *
 * Imports `definePluginEntry` from the OpenClaw host runtime and registers
 * five tools that delegate to the Python CLI via `runPython()`.  The JS
 * entry runs inside OpenClaw's Node.js process; it never imports Python
 * directly — it spawns `python3 -m open_second_brain.cli` with PYTHONPATH
 * pointed at the plugin's `src/` directory.
 *
 * Tool parameter schemas are taken from `src/open_second_brain/mcp.py`.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runPython } from "./o2b-runner.js";

/**
 * Escape a single shell argument so it can be safely joined into a
 * command string.  Wraps the value in single-quotes and escapes any
 * embedded single-quotes.
 */
function shArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export default definePluginEntry({
  async register(api) {
    // ── second_brain_status ────────────────────────────────────────────
    api.registerTool({
      name: "second_brain_status",
      description: "Report Open Second Brain configuration and vault status.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_id, _params) {
        const config = api.getConfig();
        const vault = config?.vault || process.env.VAULT_DIR || ".";
        const result = await runPython(["status", "--vault", vault]);
        return { content: [{ type: "text", text: result }] };
      },
    });

    // ── second_brain_query ─────────────────────────────────────────────
    api.registerTool({
      name: "second_brain_query",
      description:
        "List vault pages with optional title substring filter.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Optional case-insensitive substring matched against page titles.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description:
              "Maximum number of matched pages to return (default 50).",
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const config = api.getConfig();
        const vault = params.vault || config?.vault || process.env.VAULT_DIR || ".";
        const args = ["tool-call", "--vault", vault, "second_brain_query"];
        if (params.pattern) args.push("--tool-arg", `pattern=${params.pattern}`);
        if (params.limit != null) args.push("--tool-arg", `limit=${params.limit}`);
        const result = await runPython(args);
        return { content: [{ type: "text", text: result }] };
      },
    });

    // ── second_brain_capture ───────────────────────────────────────────
    api.registerTool({
      name: "second_brain_capture",
      description:
        "Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Human-readable note title.",
          },
          content: {
            type: "string",
            description: "Markdown body of the note.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tag strings.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Allow overwriting an existing note with the same slug.",
          },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const config = api.getConfig();
        const vault = config?.vault || process.env.VAULT_DIR || ".";
        const args = [
          "tool-call", "--vault", vault, "second_brain_capture",
          "--tool-arg", `title=${params.title}`,
          "--tool-arg", `content=${params.content}`,
        ];
        if (params.tags && params.tags.length > 0) {
          args.push("--tool-arg", `tags=${JSON.stringify(params.tags)}`);
        }
        if (params.overwrite) {
          args.push("--tool-arg", "overwrite=true");
        }
        const result = await runPython(args);
        return { content: [{ type: "text", text: result }] };
      },
    });

    // ── event_log_append ───────────────────────────────────────────────
    api.registerTool({
      name: "event_log_append",
      description:
        "Append a single-line event to the daily Markdown event log.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Single-line event message.",
          },
          agent: {
            type: "string",
            description: "Agent name (default 'agent').",
          },
          date: {
            type: "string",
            description: "Optional event date in YYYY.MM.DD format.",
          },
          time: {
            type: "string",
            description: "Optional event time in 24-hour HH:MM format.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const config = api.getConfig();
        const vault = config?.vault || process.env.VAULT_DIR || ".";
        const args = ["append-event", "--vault", vault];
        if (params.agent) args.push("--as", params.agent);
        if (params.date) args.push("--date", params.date);
        if (params.time) args.push("--time", params.time);
        args.push("--");
        args.push(params.message);
        const result = await runPython(args);
        return { content: [{ type: "text", text: result }] };
      },
    });

    // ── vault_health ───────────────────────────────────────────────────
    api.registerTool({
      name: "vault_health",
      description:
        "Run vault, config, and plugin manifest health checks.",
      parameters: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description:
              "Optional repository root to validate plugin manifests.",
          },
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const config = api.getConfig();
        const vault = config?.vault || process.env.VAULT_DIR || ".";
        const args = ["doctor", "--vault", vault];
        if (params.repo) args.push("--repo", params.repo);
        const result = await runPython(args);
        return { content: [{ type: "text", text: result }] };
      },
    });
  },
});
