import { readFileSync, appendFileSync } from "node:fs";
import { spawnNpmSync } from "./npm.ts";

export type RegistryAnswer =
  | { versions: string[]; latest: string | null }
  | { error: "missing" | "unreadable" };
export type PublishAction =
  | "publish"
  | "skip-already-published"
  | "skip-disabled"
  | "skip-not-a-tag";
export interface PlanInput {
  version: string;
  eventName: string;
  refType: string;
  refName: string;
  enabled?: string;
  registry?: RegistryAnswer;
}
export interface PublishPlan {
  action: PublishAction;
  tag: string;
  version: string;
  reason: string;
}

function versionParts(value: string): { numbers: number[]; pre: string | null } {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return { numbers: match.slice(1, 4).map(Number), pre: match[4] ?? null };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++)
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i]! < right.numbers[i]! ? -1 : 1;
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

export function compareTagVersion(version: string, refName: string): void {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(refName) || refName.slice(1) !== version)
    throw new Error(
      `tag ${refName} does not match package version ${version}; correct the tag or package.json`,
    );
}

export function decidePublish(input: PlanInput): PublishPlan {
  const { version, eventName, refType, refName } = input;
  if (eventName !== "push" || refType !== "tag")
    return { action: "skip-not-a-tag", tag: "", version, reason: "not a pushed version tag" };
  compareTagVersion(version, refName);
  const parts = versionParts(version);
  if (input.enabled !== "enabled")
    return {
      action: "skip-disabled",
      tag: "latest",
      version,
      reason: "publishing is off; set repository variable NPM_PUBLISH to enabled",
    };
  if (!input.registry) throw new Error("registry answer is required after enabling publishing");
  if ("error" in input.registry && input.registry.error === "unreadable")
    throw new Error("could not read registry; repair registry access before retrying");
  if ("error" in input.registry && input.registry.error === "missing")
    throw new Error(
      "package is missing; publish the first version by hand as described in docs/releasing.md",
    );
  if ("error" in input.registry) throw new Error("unrecognized registry answer");
  if (input.registry.versions.includes(version))
    return {
      action: "skip-already-published",
      tag: "latest",
      version,
      reason: `${version} already exists on the registry`,
    };
  if (parts.pre) return { action: "publish", tag: "next", version, reason: "prerelease tag" };
  if (input.registry.latest === null || compareVersions(version, input.registry.latest) > 0)
    return { action: "publish", tag: "latest", version, reason: "version advances latest" };
  return {
    action: "publish",
    tag: `release-${parts.numbers[0]}.x`,
    version,
    reason: "version is below latest",
  };
}

export function parseRegistryOutput(stdout: string, stderr = ""): RegistryAnswer {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    try {
      data = JSON.parse(stderr);
    } catch {
      return { error: "unreadable" };
    }
  }
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    (data as { error?: { code?: string } }).error?.code === "E404"
  )
    return { error: "missing" };
  if (!data || typeof data !== "object") return { error: "unreadable" };
  const result = data as { versions?: unknown; "dist-tags"?: { latest?: unknown } };
  if (!Array.isArray(result.versions) || result.versions.some((v) => typeof v !== "string"))
    return { error: "unreadable" };
  const latest = result["dist-tags"]?.latest;
  return { versions: result.versions, latest: typeof latest === "string" ? latest : null };
}

export function parseDistTagOutput(
  stdout: string,
  stderr = "",
): { version: string } | { error: "missing" | "no-tags" | "unreadable" } {
  const tags = stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([^:\s]+):\s*(\S+)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  const selected = tags.find(([, tag]) => tag === "latest") ?? tags[0];
  if (selected?.[2]) return { version: selected[2] };
  if (/E404|404 Not Found/i.test(`${stdout}\n${stderr}`)) return { error: "missing" };
  if (!stdout.trim()) return { error: "no-tags" };
  return { error: "unreadable" };
}

function main(): void {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; name: string };
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const refType = process.env.GITHUB_REF_TYPE ?? "";
  const refName = process.env.GITHUB_REF_NAME ?? "";
  if (process.argv.includes("--compare-only")) {
    if (eventName === "push" && refType === "tag") compareTagVersion(pkg.version, refName);
    return;
  }
  const enabled = process.env.NPM_PUBLISH;
  let registry: RegistryAnswer | undefined;
  if (eventName === "push" && refType === "tag" && enabled === "enabled") {
    const tags = spawnNpmSync(["dist-tag", "ls", pkg.name]);
    const selected = parseDistTagOutput(
      new TextDecoder().decode(tags.stdout),
      new TextDecoder().decode(tags.stderr),
    );
    const noTags = "error" in selected && selected.error === "no-tags" && tags.exitCode === 0;
    if (tags.exitCode !== 0) {
      registry = {
        error: "error" in selected && selected.error === "missing" ? "missing" : "unreadable",
      };
    } else if ("error" in selected && !noTags) {
      registry = { error: selected.error === "missing" ? "missing" : "unreadable" };
    } else {
      const proc = spawnNpmSync([
        "view",
        `${pkg.name}@${"version" in selected ? selected.version : pkg.version}`,
        "versions",
        "dist-tags",
        "--json",
      ]);
      registry = parseRegistryOutput(
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      );
      if (proc.exitCode !== 0) {
        if (noTags && "error" in registry && registry.error === "missing")
          registry = { versions: [], latest: null };
        else if (!("error" in registry && registry.error === "missing"))
          registry = { error: "unreadable" };
      }
    }
  }
  const plan = decidePublish({
    version: pkg.version,
    eventName,
    refType,
    refName,
    enabled,
    registry,
  });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile)
    appendFileSync(
      outputFile,
      `action=${plan.action}\ntag=${plan.tag}\nversion=${plan.version}\nreason=${plan.reason.replaceAll("\n", " ")}\n`,
    );
}

if (import.meta.main) main();
