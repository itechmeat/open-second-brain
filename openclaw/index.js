/**
 * OpenClaw native plugin entry for Open Second Brain.
 *
 * Pure JavaScript implementation — all five tools operate directly on the
 * vault filesystem using `node:fs/promises` and `node:path`.  No
 * subprocess creation, no native process module.  Passes the OpenClaw security scanner.
 *
 * Tool parameter schemas match `src/open_second_brain/mcp.py` exactly.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  listVaultPages,
  writeFrontmatter,
  slugify,
} from "./vault.js";
import { appendEvent } from "./event-log.js";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  sep,
} from "node:path";
import { existsSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────────

const PLUGIN_VERSION = "0.5.2";

const SECRET_KEY_PARTS = ["key", "token", "secret", "password", "credential"];

// ── Config helpers ─────────────────────────────────────────────────────────

/**
 * Parse a simple YAML key: value file into an object.
 */
function parseSimpleYaml(text) {
  const data = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":")) continue;
    const idx = line.indexOf(":");
    let key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (key) data[key] = value;
  }
  return data;
}

/**
 * Redact values for keys that look like secrets.
 */
function redactMapping(data) {
  const redacted = {};
  for (const [key, value] of Object.entries(data)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => lowered.includes(part))) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Discover config from the vault or the default path.
 */
function resolveVaultPath(api) {
  const config = api.pluginConfig || {};
  return config.vault || process.env.VAULT_DIR || ".";
}

/**
 * Get current date in YYYY.MM.DD format.
 */
function currentDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * Get current time in HH:MM 24-hour format.
 */
function currentTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Get UTC timestamp for frontmatter.
 */
function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Compute relative path from vault to target.
 */
function vaultRelpath(target, vault) {
  try {
    return relative(resolve(vault), resolve(target));
  } catch {
    return String(target);
  }
}

/**
 * Ensure a target path stays inside the vault.
 */
function ensureInsideVault(target, vault) {
  const resolvedTarget = resolve(target);
  const resolvedVault = resolve(vault);
  if (!resolvedTarget.startsWith(resolvedVault + sep) && resolvedTarget !== resolvedVault) {
    throw new Error(`path escapes vault: ${target}`);
  }
  return resolvedTarget;
}

// ── Health checks (pure JS) ────────────────────────────────────────────────

async function checkVaultWritable(vaultPath) {
  if (!existsSync(vaultPath)) {
    return { name: "vault_writeable", ok: false, message: `vault directory missing: ${vaultPath}` };
  }
  const testPath = join(vaultPath, ".open-second-brain-doctor-test");
  try {
    await writeFile(testPath, "", "utf8");
    await unlink(testPath);
  } catch (exc) {
    return { name: "vault_writeable", ok: false, message: `cannot write to vault: ${exc}` };
  }
  return { name: "vault_writeable", ok: true, message: `vault exists and is writable: ${vaultPath}` };
}

async function checkDailyNotesDir(vaultPath) {
  const dailyDir = join(vaultPath, "Daily");
  if (existsSync(dailyDir)) {
    return { name: "daily_notes_dir", ok: true, message: `Daily notes directory exists: ${dailyDir}` };
  }
  return { name: "daily_notes_dir", ok: false, message: `Daily notes directory missing: ${dailyDir}` };
}

async function checkAIWikiDir(vaultPath) {
  const wikiDir = join(vaultPath, "AI Wiki");
  if (existsSync(wikiDir)) {
    return { name: "ai_wiki_dir", ok: true, message: `AI Wiki directory exists: ${wikiDir}` };
  }
  return { name: "ai_wiki_dir", ok: false, message: `AI Wiki directory missing: ${wikiDir}` };
}

async function checkNotesDir(vaultPath) {
  const notesDir = join(vaultPath, "AI Wiki", "notes");
  if (existsSync(notesDir)) {
    return { name: "notes_dir", ok: true, message: `Notes directory exists: ${notesDir}` };
  }
  return { name: "notes_dir", ok: false, message: `Notes directory missing: ${notesDir}` };
}

// ── Plugin entry ───────────────────────────────────────────────────────────

export default definePluginEntry({
  register(api) {
    // ── second_brain_status ────────────────────────────────────────────
    api.registerTool(
      {
        name: "second_brain_status",
        description: "Report Open Second Brain configuration and vault status.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const pluginConfig = api.pluginConfig || {};
          const vault = resolveVaultPath(api);

          // Try to discover config from default path or env
          let configPath = null;
          let configExists = false;
          let configData = {};

          const configOverride = process.env.OPEN_SECOND_BRAIN_CONFIG;
          const xdgHome = process.env.XDG_CONFIG_HOME;
          const defaultConfig = configOverride
            ? resolve(configOverride.replace(/^~/, process.env.HOME || ""))
            : xdgHome
              ? join(xdgHome, "open-second-brain", "config.yaml")
              : join(process.env.HOME || "/root", ".config", "open-second-brain", "config.yaml");

          configPath = defaultConfig;
          if (existsSync(configPath)) {
            configExists = true;
            try {
              const text = await readFile(configPath, "utf8");
              configData = parseSimpleYaml(text);
            } catch {
              configExists = false;
            }
          }

          const vaultExists = existsSync(vault);
          const configKeys = Object.keys(configData).sort();

          const result = {
            config_path: String(configPath),
            config_exists: configExists,
            config_keys: configKeys,
            config: redactMapping(configData),
            vault_path: vault,
            vault_exists: vaultExists,
          };

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
      { name: "second_brain_status" },
    );

    // ── second_brain_query ─────────────────────────────────────────────
    api.registerTool(
      {
        name: "second_brain_query",
        description: "List vault pages with optional title substring filter.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Optional case-insensitive substring matched against page titles.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description: "Maximum number of matched pages to return (default 50).",
            },
          },
          additionalProperties: false,
        },
        async execute(_id, params) {
          const vault = resolveVaultPath(api);
          if (!existsSync(vault)) {
            throw new Error(`vault directory missing: ${vault}`);
          }

          const pattern = params.pattern || null;
          const limit = typeof params.limit === "number" ? params.limit : 50;

          if (limit < 1 || limit > 500) {
            throw new Error("argument 'limit' must be between 1 and 500");
          }

          const { allPages, matched } = await listVaultPages(vault, pattern, limit);

          const pages = matched.map((p) => ({
            title: p.title,
            path: p.relativePath,
            metadata: p.metadata,
          }));

          const result = {
            vault_path: vault,
            total_pages: allPages.length,
            returned: pages.length,
            limit,
            pattern,
            pages,
          };

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
      { name: "second_brain_query" },
    );

    // ── second_brain_capture ───────────────────────────────────────────
    api.registerTool(
      {
        name: "second_brain_capture",
        description: "Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
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
              description: "Allow overwriting an existing note with the same slug.",
            },
          },
          required: ["title", "content"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const vault = resolveVaultPath(api);
          if (!existsSync(vault)) {
            throw new Error(`vault directory missing: ${vault}`);
          }

          const title = params.title;
          const content = params.content;
          const tags = params.tags || [];
          const overwrite = !!params.overwrite;

          if (!title || !title.trim()) {
            throw new Error("title must not be empty");
          }
          if (!content || !content.trim()) {
            throw new Error("content must not be empty");
          }

          const notesDir = join(vault, "AI Wiki", "notes");
          const slug = slugify(title);
          const target = join(notesDir, `${slug}.md`);
          ensureInsideVault(target, vault);

          await mkdir(notesDir, { recursive: true });

          const noteExisted = existsSync(target);
          if (noteExisted && !overwrite) {
            throw new Error(`note already exists: ${vaultRelpath(target, vault)}`);
          }

          const metadata = {
            title,
            type: "note",
            created: utcTimestamp(),
          };
          if (tags.length > 0) {
            metadata.tags = tags;
          }

          await writeFrontmatter(target, metadata, content.trim());

          const result = {
            path: vaultRelpath(target, vault),
            absolute_path: resolve(target),
            slug,
            overwritten: noteExisted && overwrite,
          };

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
      { name: "second_brain_capture" },
    );

    // ── event_log_append ───────────────────────────────────────────────
    api.registerTool(
      {
        name: "event_log_append",
        description: "Append a single-line event to the daily Markdown event log.",
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
          const vault = resolveVaultPath(api);
          const message = params.message;
          if (!message) {
            throw new Error("missing required argument: message");
          }

          const agent = params.agent || process.env.VAULT_AGENT_NAME || "agent";
          const date = params.date || null;
          const time = params.time || null;

          const result = await appendEvent(vault, agent, message, date, time);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    path: vaultRelpath(result.path, vault),
                    absolute_path: resolve(result.path),
                    agent: result.agent,
                    date: result.date,
                    time: result.time,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      },
      { name: "event_log_append" },
    );

    // ── vault_health ───────────────────────────────────────────────────
    api.registerTool(
      {
        name: "vault_health",
        description: "Run vault, config, and plugin manifest health checks.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Optional repository root to validate plugin manifests.",
            },
          },
          additionalProperties: false,
        },
        async execute(_id, params) {
          const vault = resolveVaultPath(api);
          const checks = [];

          // Vault writable check
          checks.push(await checkVaultWritable(vault));

          // Daily notes dir
          checks.push(await checkDailyNotesDir(vault));

          // AI Wiki dir
          checks.push(await checkAIWikiDir(vault));

          // Notes dir
          checks.push(await checkNotesDir(vault));

          // Plugin manifest checks (only if repo provided)
          if (params.repo) {
            const repoRoot = params.repo;

            // Check openclaw.plugin.json
            const openclawManifestPath = join(repoRoot, "openclaw.plugin.json");
            if (existsSync(openclawManifestPath)) {
              try {
                const text = await readFile(openclawManifestPath, "utf8");
                const data = JSON.parse(text);
                if (data.id && data.configSchema) {
                  checks.push({
                    name: "openclaw_manifest",
                    ok: true,
                    message: `valid OpenClaw manifest: ${openclawManifestPath}`,
                  });
                } else {
                  checks.push({
                    name: "openclaw_manifest",
                    ok: false,
                    message: `schema invalid: ${openclawManifestPath} (missing id or configSchema)`,
                  });
                }
              } catch (exc) {
                checks.push({
                  name: "openclaw_manifest",
                  ok: false,
                  message: `invalid JSON: ${openclawManifestPath} (${exc})`,
                });
              }
            } else {
              checks.push({
                name: "openclaw_manifest",
                ok: false,
                message: `missing: ${openclawManifestPath}`,
              });
            }

            // Check package.json
            const pkgPath = join(repoRoot, "package.json");
            if (existsSync(pkgPath)) {
              try {
                const data = JSON.parse(await readFile(pkgPath, "utf8"));
                const extensions = data?.openclaw?.extensions;
                if (Array.isArray(extensions) && extensions.length > 0) {
                  checks.push({
                    name: "openclaw_package_json_extensions",
                    ok: true,
                    message: `package.json declares ${extensions.length} extension(s)`,
                  });
                  // Check each extension file
                  for (const entry of extensions) {
                    const entryPath = join(repoRoot, entry);
                    if (existsSync(entryPath)) {
                      checks.push({
                        name: `openclaw_entry_${entry}`,
                        ok: true,
                        message: `extension entry exists: ${entry}`,
                      });
                    } else {
                      checks.push({
                        name: `openclaw_entry_${entry}`,
                        ok: false,
                        message: `missing extension entry: ${entry}`,
                      });
                    }
                  }
                } else {
                  checks.push({
                    name: "openclaw_package_json_extensions",
                    ok: false,
                    message: "package.json missing or empty openclaw.extensions array",
                  });
                }
              } catch (exc) {
                checks.push({
                  name: "openclaw_package_json",
                  ok: false,
                  message: `invalid JSON: ${pkgPath} (${exc})`,
                });
              }
            } else {
              checks.push({
                name: "openclaw_package_json",
                ok: false,
                message: `missing: ${pkgPath}`,
              });
            }
          }

          const result = {
            vault_path: vault,
            ok: checks.every((c) => c.ok),
            checks,
          };

          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        },
      },
      { name: "vault_health" },
    );
  },
});
