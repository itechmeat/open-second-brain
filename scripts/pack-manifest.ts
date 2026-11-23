import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnNpmSync } from "./npm.ts";

export interface PackSizes {
  packedSize: number;
  unpackedSize: number;
}

export interface PackManifest {
  paths: string[];
  ceilings: PackSizes;
}

export const FORBIDDEN_PACKED_PATHS = [
  ".apb/",
  ".ai-notes/",
  ".claude/",
  ".env",
  "*.local.*",
  "node_modules/",
  "tests/",
  "openspec/",
  "docs/brainstorm/",
  "docs/plans/",
  "**/__pycache__/**",
  "*.pyc",
] as const;

export function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function checkTarball(tarball: string, manifest: PackManifest): string[] {
  const absolute = resolve(tarball);
  const listing = Bun.spawnSync(["tar", "-tzf", absolute], { stdout: "pipe", stderr: "pipe" });
  if (listing.exitCode !== 0)
    throw new Error(new TextDecoder().decode(listing.stderr).trim() || "cannot list tarball");
  const entries = new TextDecoder().decode(listing.stdout).split(/\r?\n/).filter(Boolean);
  const details = Bun.spawnSync(["tar", "-tvzf", absolute], { stdout: "pipe", stderr: "pipe" });
  if (details.exitCode !== 0)
    throw new Error(
      new TextDecoder().decode(details.stderr).trim() || "cannot inspect tarball entries",
    );
  if (
    new TextDecoder()
      .decode(details.stdout)
      .split(/\r?\n/)
      .some((line) => /^[lh]/.test(line))
  )
    throw new Error("tarball links are not supported by the manifest checker");
  const paths = entries
    .filter((entry) => !entry.endsWith("/"))
    .map((entry) => {
      const normalized = normalize(entry);
      if (!normalized.startsWith("package/") || normalized.split("/").includes(".."))
        throw new Error(`unsafe tarball path: ${entry}`);
      return normalized.slice("package/".length);
    });
  const root = mkdtempSync(join(tmpdir(), "o2b-tarball-check-"));
  try {
    const extracted = Bun.spawnSync(["tar", "-xzf", absolute, "-C", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (extracted.exitCode !== 0)
      throw new Error(
        new TextDecoder().decode(extracted.stderr).trim() || "cannot extract tarball",
      );
    let unpackedSize = 0;
    const walk = (path: string): void => {
      for (const name of readdirSync(path)) {
        const child = join(path, name);
        const stat = lstatSync(child);
        if (stat.isDirectory()) walk(child);
        else if (stat.isFile()) unpackedSize += stat.size;
      }
    };
    walk(root);
    return [
      ...comparePathLists(paths, manifest.paths),
      ...checkSizes({ packedSize: statSync(absolute).size, unpackedSize }, manifest.ceilings),
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function comparePathLists(packedPaths: string[], manifestPaths: string[]): string[] {
  const packed = new Set(packedPaths.map(normalize));
  const manifest = new Set(manifestPaths.map(normalize));
  const errors: string[] = [];
  for (const candidate of [...packed].filter((path) => !manifest.has(path)).toSorted()) {
    errors.push(`unlisted packed path: ${candidate}`);
  }
  for (const candidate of [...manifest].filter((path) => !packed.has(path)).toSorted()) {
    errors.push(`manifest path not packed: ${candidate}`);
  }
  return errors;
}

function matches(path: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("*")) return path === pattern;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

export function findForbiddenPaths(
  paths: string[],
  patterns: readonly string[] = FORBIDDEN_PACKED_PATHS,
): string[] {
  return paths
    .map(normalize)
    .filter((path) => {
      for (const pattern of patterns) {
        if (pattern === "tests/" && path.startsWith("tests/fixtures/decision-model/")) continue;
        if (matches(path, pattern)) return true;
      }
      return false;
    })
    .toSorted()
    .map((path) => `forbidden packed path: ${path}`);
}

export function checkSizes(actual: PackSizes, ceilings: PackSizes): string[] {
  const errors: string[] = [];
  if (actual.packedSize > ceilings.packedSize)
    errors.push(`packed size ${actual.packedSize} exceeds ceiling ${ceilings.packedSize}`);
  if (actual.unpackedSize > ceilings.unpackedSize)
    errors.push(`unpacked size ${actual.unpackedSize} exceeds ceiling ${ceilings.unpackedSize}`);
  return errors;
}

export function findLifecycleScripts(packageJson: unknown): string[] {
  if (!packageJson || typeof packageJson !== "object") return [];
  const scripts = (packageJson as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  return Object.keys(scripts)
    .filter((name) => ["preinstall", "install", "postinstall", "prepare"].includes(name))
    .toSorted()
    .map((name) => `forbidden lifecycle script: ${name}`);
}

export function parseManifest(text: string): PackManifest {
  let packedSize: number | undefined;
  let unpackedSize: number | undefined;
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const packed = line.match(/^# Maximum packed size: (\d+) bytes$/);
    const unpacked = line.match(/^# Maximum unpacked size: (\d+) bytes$/);
    if (packed) packedSize = Number(packed[1]);
    else if (unpacked) unpackedSize = Number(unpacked[1]);
    else if (line && !line.startsWith("#")) paths.push(normalize(line));
  }
  if (packedSize === undefined || unpackedSize === undefined)
    throw new Error("package-files.txt must declare both size ceilings");
  return { paths, ceilings: { packedSize, unpackedSize } };
}

export function validatePack(input: {
  packedPaths: string[];
  manifestPaths: string[];
  forbiddenPatterns?: readonly string[];
  sizes: PackSizes;
  ceilings: PackSizes;
  packageJson: unknown;
}): string[] {
  return [
    ...comparePathLists(input.packedPaths, input.manifestPaths),
    ...findForbiddenPaths(input.packedPaths, input.forbiddenPatterns),
    ...checkSizes(input.sizes, input.ceilings),
    ...findLifecycleScripts(input.packageJson),
  ];
}

function runPack(): { paths: string[]; sizes: PackSizes } {
  const proc = spawnNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  if (proc.exitCode !== 0)
    throw new Error(new TextDecoder().decode(proc.stderr).trim() || "npm pack failed");
  const result = (
    JSON.parse(new TextDecoder().decode(proc.stdout)) as Array<{
      files: Array<{ path: string }>;
      size: number;
      unpackedSize: number;
    }>
  )[0];
  if (!result) throw new Error("npm pack returned no package details");
  return {
    paths: result.files.map((file) => normalize(file.path)).toSorted(),
    sizes: { packedSize: result.size, unpackedSize: result.unpackedSize },
  };
}

function manifestText(paths: string[], sizes: PackSizes): string {
  const packedCeiling = Math.ceil(sizes.packedSize * 1.1);
  const unpackedCeiling = Math.ceil(sizes.unpackedSize * 1.1);
  return [
    "# Open Second Brain packed file manifest",
    `# Maximum packed size: ${packedCeiling} bytes`,
    `# Maximum unpacked size: ${unpackedCeiling} bytes`,
    ...paths,
    "",
  ].join("\n");
}

function main(): void {
  const tarballFlag = process.argv.indexOf("--tarball");
  if (tarballFlag >= 0) {
    const tarball = process.argv[tarballFlag + 1];
    if (!tarball) throw new Error("--tarball requires a file path");
    const manifest = parseManifest(readFileSync("package-files.txt", "utf8"));
    const errors = checkTarball(tarball, manifest);
    if (errors.length) {
      for (const error of errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("tarball paths and sizes verified\n");
    return;
  }
  const packed = runPack();
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
  if (process.argv.includes("--write")) {
    writeFileSync("package-files.txt", manifestText(packed.paths, packed.sizes), "utf8");
    process.stdout.write(`wrote ${packed.paths.length} packed paths\n`);
    return;
  }
  const manifest = parseManifest(readFileSync("package-files.txt", "utf8"));
  const errors = validatePack({
    packedPaths: packed.paths,
    manifestPaths: manifest.paths,
    sizes: packed.sizes,
    ceilings: manifest.ceilings,
    packageJson,
  });
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `pack manifest verified: ${packed.paths.length} paths, ${packed.sizes.packedSize} packed bytes, ${packed.sizes.unpackedSize} unpacked bytes\n`,
  );
}

if (import.meta.main) main();
