import {
  allFlagNames,
  commandNames,
  nestedCommandGroups,
  type CliRootManifest,
} from "./command-manifest.ts";

export const COMPLETION_SHELLS = [
  "bash",
  "zsh",
  "fish",
  "elvish",
  "nushell",
  "powershell",
] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as ReadonlyArray<string>).includes(value);
}

export function renderCompletions(shell: CompletionShell, manifest: CliRootManifest): string {
  const roots = commandNames(manifest);
  const groups = nestedCommandGroups(manifest);
  const nested = groups.flatMap((group) => group.children);
  const flags = allFlagNames(manifest).map((flag) => `--${flag}`);
  const words = [...roots, ...flags];
  const header = `# o2b completions for ${shell}\n# commands: ${roots.join(" ")}\n# flags: ${flags.join(" ")}\n`;
  switch (shell) {
    case "bash":
      return `${header}
_o2b_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
${groups
  .map(
    (group) => `  if [[ "$prev" == "${group.parent}" ]]; then
    COMPREPLY=( $(compgen -W "${group.children.join(" ")}" -- "$cur") )
    return 0
  fi`,
  )
  .join("\n")}
  COMPREPLY=( $(compgen -W "${words.join(" ")}" -- "$cur") )
}
complete -F _o2b_completions o2b
`;
    case "zsh":
      return `${header}
#compdef o2b
_arguments \\
  '1:command:(${roots.join(" ")})' \\
  '2:subcommand:(${nested.join(" ")})' \\
  '*:flags:(${flags.join(" ")})'
`;
    case "fish":
      return `${header}${roots.map((root) => `complete -c o2b -f -a ${quoteFish(root)}`).join("\n")}
${groups
  .flatMap((group) =>
    group.children.map(
      (verb) =>
        `complete -c o2b -n '__fish_seen_subcommand_from ${group.parent}' -f -a ${quoteFish(verb)}`,
    ),
  )
  .join("\n")}
${flags.map((flag) => `complete -c o2b -l ${flag.slice(2)}`).join("\n")}
`;
    case "elvish":
      return `${header}
set edit:completion:arg-completer[o2b] = {|@words|
  put ${words.map((word) => quoteElvish(word)).join(" ")}
}
`;
    case "nushell":
      return `${header}
def "nu-complete o2b" [] { [${words.map((word) => quoteNu(word)).join(" ")}] }
export extern "o2b" [command?: string@"nu-complete o2b", ...rest]
`;
    case "powershell":
      return `${header}
Register-ArgumentCompleter -Native -CommandName o2b -ScriptBlock {
  param($wordToComplete)
  ${JSON.stringify(words)} | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
  }
}

function quoteFish(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

function quoteElvish(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteNu(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
