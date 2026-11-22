# Brainstorm

The brainstorm of the registry package (`openspec/changes/registry-package/brainstorm.md`, with an independent partner of another model family) covered three changes and cut them: the package and its launchers, this change, and publishing. Its sections on the setup contract and on coexistence are the source here. `inventory.md` in this folder is a read-only code inventory by a third agent, made before `registry-package` landed; three of its risks (the hooks folder not shipped, `o2b-hook` not a package command, the bash launcher as the only entry) are already closed by that change.

## The problem

After `bun add -g open-second-brain` the commands exist, and nothing is connected: no brain, no agent host that knows about the product. Today that takes `init`, then `install --target <host> --apply --yes`, then a check, each with its own flags, and the install registers the bare name `o2b`, which an agent host with a minimal PATH does not find and which another copy earlier on PATH can shadow.

## Decisions

1. **One verb that composes what exists.** `o2b setup` runs the existing steps in order (configure, create or connect the brain, connect the host, verify) through their functions, not a new implementation. Alternative: document the three commands. Rejected: the README promises one command and one prompt for an agent.
2. **Headless by flags, interactive only on a terminal.** With every choice given, `setup` asks nothing. With a choice missing and no terminal it fails before any write and names the missing flag. With a terminal and no flags it runs the existing interactive wizard. It passes consent itself when `--yes` is given; without `--apply` it prints the plan and writes nothing, as `install` does.
3. **The registered command depends on where the product runs from.** A new function names the origin of the running code: `registry` (the package root sits in a package manager's `node_modules`), `plugin-cache` (the existing check), or `checkout`. For `registry`, the command written into a host is the absolute Bun that runs now plus the launcher file inside the installed package. For the other two origins nothing changes, so existing installs and their tests keep their bytes. The partner's point that a first matching command on PATH wins, and that paths from a throwaway cache (`bunx`, `npx`) must never be saved, is met by refusing to register from an origin whose root is under a package runner's cache.
4. **The origin is recorded.** The install manifest entry gains the origin, the package root and the version that wrote it. Verification rebuilds the expected command from the same function, so a fresh install does not report drift against itself.
5. **Doctor says what a one-shot setup must not hide.** Registered command missing on disk; registered version older than the running one; more than one `o2b` on PATH resolving to different files. Each with the command that repairs it. Compatible coexistence (a checkout and a registry install side by side) is information, not an error.
6. **Hosts with their own plugin mechanism are told, not written.** For Claude Code, Hermes, OpenClaw and ZCode `setup` prints the host's own install step and ends with a distinct exit code, "a step is left for the host". One table says which host is which, used by `setup` and by `bootstrap`.
7. **Verification is what exists.** The install check of the target, the in-process MCP probe, and the store self-test. A real hook dry run does not exist and is not built here.
8. **Exit codes are the install's, plus one.** 0 done, 1 runtime, 2 usage, 3 drift, 4 a block the user changed, 5 host unreachable, 6 consent refused, 7 a step is left for the host.

## Rejected

1. A self-update inside `setup` or `update`. `update` keeps its meaning (refresh integrations); the software itself is upgraded by the package manager, and `setup` prints that command.
2. Changing what a checkout or a marketplace install registers.
3. A new hook dry run, `npm create`, discovery of hosts beyond the existing probes.
