/**
 * `openclaw/plugin-sdk/plugin-entry` is provided by the OpenClaw runtime
 * at load time. Keep the narrow local type shape here instead of taking a
 * build-time dependency on the SDK package; the bundle marks this import as
 * external so OpenClaw resolves it at runtime.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  /**
   * Optional second-arg shape for `api.registerTool`. Per the OpenClaw plugin
   * docs (Building Plugins → Registering agent tools): tools are required by
   * default; pass `{ optional: true }` to make a tool user-opt-in (visible in
   * the allowlist, but not auto-loaded).
   *
   * Earlier drafts of this declaration shipped `{ name }` here (a `ToolMeta`
   * shape). That was wrong — passing `{ name: "..." }` made OpenClaw treat the
   * tool as a non-agent-facing registration, which is why none of the five
   * second_brain_* tools showed up in `openclaw agent --message` tool lists
   * even though `openclaw plugins inspect --runtime` listed them. Removed.
   */
  export interface RegisterToolOptions {
    readonly optional?: boolean;
  }

  export interface ToolHandler<Name extends string = string> {
    readonly name: Name;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(id: unknown, params: Record<string, unknown>): Promise<unknown>;
  }

  /**
   * Subset of the `before_prompt_build` hook return shape we use. Source:
   * github.com/openclaw/openclaw/blob/main/src/plugins/hook-before-agent-start.types.ts
   * (PluginHookBeforePromptBuildResult). We use `prependContext` — per-turn,
   * NOT cached into the system prompt — because the whole point is to
   * re-remind the LLM each turn; a cached system-prompt injection would
   * have the same drift problem MCP `instructions` already has, which is
   * what this hook works around.
   */
  export interface BeforePromptBuildResult {
    readonly prependContext?: string;
  }

  export interface PluginApi {
    readonly pluginConfig?: Record<string, unknown>;
    registerTool<const Handler extends ToolHandler<string>>(
      handler: Handler,
      options?: RegisterToolOptions,
    ): void;
    on(
      event: "before_prompt_build",
      handler: () =>
        | Promise<BeforePromptBuildResult | undefined>
        | BeforePromptBuildResult
        | undefined,
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
  }

  export interface PluginEntry {
    register(api: PluginApi): void;
  }

  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
