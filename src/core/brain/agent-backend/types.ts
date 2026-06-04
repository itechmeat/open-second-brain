/**
 * Memory-source backend protocol (Agent Write Contract Suite,
 * t_53f9f67f).
 *
 * The seam that decouples "import an agent runtime's memory into Brain
 * preferences" from the Claude Code memory format. A backend is a
 * self-contained format adapter: it knows where the runtime keeps its
 * memory files, how to parse one, and how to render a parsed entry as
 * a Brain preference. Adding a runtime means adding ONE module that
 * satisfies this interface and registering it - no changes to the
 * import core, CLI, or MCP surfaces (the memclaw v1.2.0 pattern).
 *
 * Deliberately narrow: backends are FORMAT adapters, not generation
 * engines - the deterministic-core rule means there is nothing
 * provider-specific to dispatch beyond parsing and rendering. The
 * write-session kernel does NOT consult backends (design decision:
 * no speculative coupling).
 */

/** Parsed memory entry - structurally the claude-memory parse result. */
export type MemorySourceParse =
  | {
      readonly kind: "feedback";
      readonly name: string;
      readonly description: string;
      readonly body: string;
      readonly bodySha256: string;
    }
  | {
      readonly kind: "skip";
      readonly skipReason: string;
    };

/** Render input - structurally the claude-memory render input. */
export interface MemoryRenderInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly memoryPath: string;
  readonly importedAt: string;
  readonly bodySha256: string;
}

/** One runtime's memory-format adapter. */
export interface MemorySourceBackend {
  /** Stable selector used by the `memory_backend` config key. */
  readonly id: string;
  /** Human-readable runtime name for messages. */
  readonly label: string;
  /** Default memory directory for a vault under this runtime. */
  discoverMemoryDir(vault: string): string;
  /** Parse one memory file's text. */
  parseMemoryFile(text: string): MemorySourceParse;
  /** Render a parsed entry as a Brain preference markdown body. */
  renderPreference(input: MemoryRenderInput): string;
  /** Deterministic name -> preference-slug transform. */
  slugifyName(name: string): string;
}
