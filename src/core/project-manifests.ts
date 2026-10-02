/**
 * The project manifests Open Second Brain recognises, in one place.
 *
 * Two consumers read this list and must never disagree about it: the
 * codegraph partner's project detection (is this directory a code
 * project at all?) and the architect's manifest readers (which file
 * declares which ecosystem's dependencies?). The detection set is the
 * dependency-bearing subset plus `tsconfig.json`, which marks a code
 * project but declares no dependency.
 *
 * This module is imported by `src/core/partner/codegraph.ts`, which is
 * bundled into the OpenClaw build that runs on Node. It therefore uses
 * no `Bun` API; the readers that need one live in the architect module.
 */

/** The package ecosystems a dependency manifest belongs to. */
export const MANIFEST_ECOSYSTEM = Object.freeze({
  npm: "npm",
  pypi: "pypi",
  cargo: "cargo",
  go: "go",
  maven: "maven",
  gradle: "gradle",
  rubygems: "rubygems",
  composer: "composer",
} as const);

export type ManifestEcosystem = (typeof MANIFEST_ECOSYSTEM)[keyof typeof MANIFEST_ECOSYSTEM];

/** One dependency-bearing manifest file and what can be read from it. */
export interface ManifestSpec {
  /** The exact basename of the manifest file. */
  readonly file: string;
  readonly ecosystem: ManifestEcosystem;
  /**
   * Whether the architect reads dependencies out of this file. The
   * others are detected and reported as unsupported by name.
   */
  readonly dependencyReadable: boolean;
}

function spec(
  file: string,
  ecosystem: ManifestEcosystem,
  dependencyReadable: boolean,
): ManifestSpec {
  return Object.freeze({ file, ecosystem, dependencyReadable });
}

/**
 * Every dependency-bearing manifest, in precedence order: when several
 * sit at a project root, the first one read names the project.
 */
export const DEPENDENCY_MANIFESTS: ReadonlyArray<ManifestSpec> = Object.freeze([
  spec("package.json", MANIFEST_ECOSYSTEM.npm, true),
  spec("pyproject.toml", MANIFEST_ECOSYSTEM.pypi, true),
  spec("Cargo.toml", MANIFEST_ECOSYSTEM.cargo, true),
  spec("go.mod", MANIFEST_ECOSYSTEM.go, true),
  spec("pom.xml", MANIFEST_ECOSYSTEM.maven, false),
  spec("build.gradle", MANIFEST_ECOSYSTEM.gradle, false),
  spec("Gemfile", MANIFEST_ECOSYSTEM.rubygems, false),
  spec("composer.json", MANIFEST_ECOSYSTEM.composer, false),
]);

/** A manifest that marks a code project without declaring dependencies. */
const TYPESCRIPT_CONFIG_FILE = "tsconfig.json";

/** The files whose presence marks a directory as a code project. */
export const CODE_MANIFEST_FILES: ReadonlyArray<string> = Object.freeze([
  ...DEPENDENCY_MANIFESTS.map((manifest) => manifest.file),
  TYPESCRIPT_CONFIG_FILE,
]);

const SPEC_BY_FILE: ReadonlyMap<string, ManifestSpec> = new Map(
  DEPENDENCY_MANIFESTS.map((manifest) => [manifest.file, manifest] as const),
);

/**
 * The dependency manifest spec for an exact file basename, or
 * `undefined` when the basename is not a dependency manifest. Matching
 * is case-sensitive, as the ecosystems' own tools are.
 */
export function manifestSpecFor(basename: string): ManifestSpec | undefined {
  return SPEC_BY_FILE.get(basename);
}
