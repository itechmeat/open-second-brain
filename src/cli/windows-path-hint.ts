/** A PATH entry as Windows compares it: no trailing separator, any case. */
function normalizeDir(d: string): string {
  return d
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/**
 * The note `o2b install-cli` prints on native Windows when the launcher
 * directory is not on PATH.
 *
 * `~/.local/bin` is on a Windows PATH only when some other installer
 * (Claude Code, uv) already put it there. Without the note, `o2b` is "not
 * recognized" in the next shell and nothing says why.
 *
 * The note names the route rather than a command that edits the value. The
 * one-liner it replaced, `[Environment]::SetEnvironmentVariable('Path', ...,
 * 'User')`, broke on a `'` in the user name, and in Windows PowerShell 5.1
 * it writes the user Path back as `REG_SZ` with every `%VAR%` in it already
 * expanded - silently turning a `REG_EXPAND_SZ` value into a frozen copy.
 * The environment-variables dialog edits the value in place and keeps its
 * type; `rundll32.exe sysdm.cpl,EditEnvironmentVariables` opens it
 * directly, and nothing of the path is spliced into a command line.
 */
export function windowsPathHint(
  bindir: string,
  platform: NodeJS.Platform = process.platform,
  pathValue: string = process.env["PATH"] ?? "",
): string | null {
  if (platform !== "win32") return null;
  const target = normalizeDir(bindir);
  if (pathValue.split(";").some((d) => normalizeDir(d) === target)) return null;
  return (
    `\n${bindir} is not on PATH. Add it to Path under "User variables", then open a new terminal:\n` +
    `  Settings > System > About > Advanced system settings > Environment Variables\n` +
    `  (or run: rundll32.exe sysdm.cpl,EditEnvironmentVariables)\n`
  );
}
