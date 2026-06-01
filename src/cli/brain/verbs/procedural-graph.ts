import { defaultConfigPath } from "../../../core/config.ts";
import {
  readProceduralGraph,
  rebuildProceduralGraph,
} from "../../../core/brain/procedural-graph.ts";
import {
  readProceduralHints,
  rebuildProceduralHints,
} from "../../../core/brain/procedural-hints.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainProceduralGraph(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "rebuild") return rebuild(rest);
  if (sub === "show") return show(rest);
  if (sub === "hints") return hints(rest);
  throw new CliError(
    "brain procedural-graph: expected rebuild, show, or hints",
  );
}

function rebuild(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const graph = rebuildProceduralGraph(vault);
  const hintProjection = rebuildProceduralHints(vault, { graph });

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          operation: "rebuild",
          graph: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            generated_at: graph.generated_at,
          },
          hints: {
            entries: hintProjection.entries.length,
            generated_at: hintProjection.generated_at,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `procedural-graph rebuilt: nodes=${graph.nodes.length} edges=${graph.edges.length} hints=${hintProjection.entries.length}\n`,
  );
  return 0;
}

function show(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const graph = readProceduralGraph(vault);
  if (!graph)
    throw new CliError(
      "brain procedural-graph show: graph projection not found",
    );

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `procedural-graph: nodes=${graph.nodes.length} edges=${graph.edges.length} generated_at=${graph.generated_at}\n`,
  );
  return 0;
}

function hints(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const projection = readProceduralHints(vault);
  if (!projection)
    throw new CliError(
      "brain procedural-graph hints: hints projection not found",
    );

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(projection, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `procedural-hints: entries=${projection.entries.length} generated_at=${projection.generated_at}\n`,
  );
  return 0;
}
