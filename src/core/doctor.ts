/**
 * Health checks for vault, config, and plugin manifests.
 *
 * Mirrors `src/open_second_brain/doctor.py`. Each `check*` returns a
 * `CheckResult` so callers can aggregate them or surface them through MCP /
 * Hermes / OpenClaw without taking on doctor's logic themselves.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CheckResult } from "./types.ts";

export function checkVaultWriteable(vault: string): CheckResult {
  if (!existsSync(vault)) {
    return { name: "vault_writeable", ok: false, message: `vault directory missing: ${vault}` };
  }
  const probe = join(vault, ".open-second-brain-doctor-test");
  try {
    const fd = openSync(probe, "w");
    closeSync(fd);
    rmSync(probe);
  } catch (exc) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `cannot write to vault: ${(exc as Error).message ?? exc}`,
    };
  }
  return { name: "vault_writeable", ok: true, message: `vault exists and is writable: ${vault}` };
}

export function checkConfigWriteable(config: string): CheckResult {
  let createdForCheck = false;
  try {
    mkdirSync(dirname(config), { recursive: true });
    if (!existsSync(config)) createdForCheck = true;
    const fd = openSync(config, "a");
    writeSync(fd, "");
    closeSync(fd);
    if (createdForCheck) rmSync(config);
  } catch (exc) {
    return {
      name: "config_writeable",
      ok: false,
      message: `cannot write config ${config}: ${(exc as Error).message ?? exc}`,
    };
  }
  return { name: "config_writeable", ok: true, message: `config writable: ${config}` };
}

interface JsonLoadResult {
  readonly result: CheckResult;
  readonly data: Record<string, unknown> | null;
}

function loadJsonManifest(path: string, name: string): JsonLoadResult {
  if (!isFile(path)) {
    return {
      result: { name, ok: false, message: `missing: ${path}` },
      data: null,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    return {
      result: { name, ok: false, message: `invalid JSON: ${path} (${(exc as Error).message})` },
      data: null,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      result: { name, ok: false, message: `invalid manifest object: ${path}` },
      data: null,
    };
  }
  return {
    result: { name, ok: true, message: `valid: ${path}` },
    data: data as Record<string, unknown>,
  };
}

export function checkJsonManifest(path: string, name: string): CheckResult {
  return loadJsonManifest(path, name).result;
}

type FieldType = "string" | "list" | ["string", "list"];

function validateRequired(
  data: Record<string, unknown>,
  required: ReadonlyArray<readonly [string, FieldType]>,
): string[] {
  const problems: string[] = [];
  for (const [field, expected] of required) {
    if (!(field in data)) {
      problems.push(`missing ${field}`);
      continue;
    }
    const v = data[field];
    const ok = isOfType(v, expected);
    if (!ok) {
      problems.push(`${field} must be ${typeName(expected)}`);
      continue;
    }
    if (typeof v === "string" && v.trim() === "") {
      problems.push(`${field} must not be empty`);
    } else if (Array.isArray(v) && v.length === 0) {
      problems.push(`${field} must not be empty`);
    }
  }
  return problems;
}

function isOfType(v: unknown, expected: FieldType): boolean {
  if (expected === "string") return typeof v === "string";
  if (expected === "list") return Array.isArray(v);
  return typeof v === "string" || Array.isArray(v);
}

function typeName(expected: FieldType): string {
  if (expected === "string") return "str";
  if (expected === "list") return "list";
  return expected.map((t) => (t === "string" ? "str" : "list")).join("/");
}

export function checkCodexManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "codex_manifest");
  if (!data) return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"],
    ["skills", "string"],
    ["keywords", "list"],
  ]);
  if (problems.length > 0) {
    return { name: "codex_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
  }
  return { name: "codex_manifest", ok: true, message: `valid Codex manifest: ${path}` };
}

export function checkClaudeManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "claude_manifest");
  if (!data) return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"],
  ]);
  for (const field of ["license", "repository", "homepage"]) {
    if (field in data && typeof data[field] !== "string") {
      problems.push(`${field} must be string`);
    }
  }
  if ("keywords" in data) {
    const kw = data["keywords"];
    if (!Array.isArray(kw) || !kw.every((k) => typeof k === "string")) {
      problems.push("keywords must be list of strings");
    }
  }
  if ("author" in data) {
    const author = data["author"];
    const authorName = typeof author === "object" && author !== null ? (author as Record<string, unknown>)["name"] : null;
    if (
      typeof author !== "object" ||
      author === null ||
      typeof authorName !== "string" ||
      authorName.trim() === ""
    ) {
      problems.push(
        "author must be an object with a non-empty 'name' field " +
          "(legacy string form is rejected by Claude 2.x)",
      );
    }
  }
  if ("commands" in data) {
    problems.push(
      "embedded 'commands' array is deprecated — author slash commands " +
        "as Markdown files under commands/ at plugin root instead",
    );
  }
  if (problems.length > 0) {
    return { name: "claude_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
  }
  return { name: "claude_manifest", ok: true, message: `valid Claude manifest: ${path}` };
}

export function checkHermesManifest(path: string): CheckResult {
  if (!isFile(path)) {
    return { name: "hermes_manifest", ok: false, message: `missing: ${path}` };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `invalid text: ${path} (${(exc as Error).message ?? exc})`,
    };
  }
  const required = ["name", "version", "description"];
  const missing: string[] = [];
  for (const field of required) {
    if (!new RegExp(`^${field}\\s*:`, "m").test(text)) missing.push(field);
  }
  if (missing.length > 0) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `schema invalid: ${path} (missing ${missing.join(", ")})`,
    };
  }
  return { name: "hermes_manifest", ok: true, message: `readable Hermes manifest: ${path}` };
}

export function checkOpenclawManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "openclaw_manifest");
  if (!data) return result;
  const problems: string[] = [];
  if (typeof data["id"] !== "string" || (data["id"] as string).trim() === "") {
    problems.push("missing or empty field 'id'");
  }
  const schema = data["configSchema"];
  if (typeof schema !== "object" || schema === null || Object.keys(schema).length === 0) {
    problems.push("missing or empty field 'configSchema'");
  }
  if (problems.length > 0) {
    return { name: "openclaw_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
  }
  return { name: "openclaw_manifest", ok: true, message: `valid OpenClaw manifest: ${path}` };
}

/**
 * Validate the OpenClaw native packaging: a `package.json` with an
 * `openclaw.extensions` array of files that exist on disk.
 */
export function checkOpenclawInstallability(repoRoot: string): CheckResult[] {
  const results: CheckResult[] = [];
  const pkgPath = join(repoRoot, "package.json");
  const { result, data } = loadJsonManifest(pkgPath, "openclaw_package_json");
  results.push(result);
  if (!data) return results;

  const oc = (data["openclaw"] as Record<string, unknown> | undefined) ?? {};
  const extensions = oc["extensions"];
  if (!Array.isArray(extensions) || extensions.length === 0) {
    results.push({
      name: "openclaw_package_json_extensions",
      ok: false,
      message: "package.json missing or empty openclaw.extensions array",
    });
    return results;
  }
  results.push({
    name: "openclaw_package_json_extensions",
    ok: true,
    message: `package.json declares ${extensions.length} extension(s)`,
  });

  for (const entry of extensions) {
    if (typeof entry !== "string") {
      results.push({
        name: `openclaw_entry_invalid_${typeof entry}`,
        ok: false,
        message: `extension entry must be a string, got: ${typeof entry}`,
      });
      continue;
    }
    const entryPath = join(repoRoot, entry);
    if (isFile(entryPath)) {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: true,
        message: `extension entry exists: ${entry}`,
      });
    } else {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: false,
        message: `missing extension entry: ${entry}`,
      });
    }
  }
  return results;
}

export interface DoctorOptions {
  readonly vault: string;
  readonly config?: string | null;
  readonly repoRoot?: string | null;
}

export function doctor(opts: DoctorOptions): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(checkVaultWriteable(opts.vault));
  if (opts.config) results.push(checkConfigWriteable(opts.config));
  if (opts.repoRoot) {
    const root = opts.repoRoot;
    results.push(checkClaudeManifest(join(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join(root, "openclaw.plugin.json")));
    results.push(...checkOpenclawInstallability(root));
  }
  return results;
}

function isFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
