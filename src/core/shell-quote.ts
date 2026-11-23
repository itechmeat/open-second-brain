/**
 * One shell-quoting helper for every command this product prints.
 *
 * A command an operator copies is read by a shell, so a path with a space
 * in it has to be quoted or the shell splits it in two. The quoting is
 * the shell's, not the product's: a POSIX shell and `cmd.exe` disagree
 * about it, so the two forms are here, chosen by the platform the
 * command is printed for.
 *
 * The POSIX form is single quotes. A quote inside the value closes the
 * string, emits an escaped quote and reopens it; inside single quotes a
 * backslash, a `$` and a backtick are literal, so nothing else needs
 * escaping. Single quotes rather than double because an interactive bash
 * history-expands `!` inside double quotes even when the escaper never
 * mentions it; inside single quotes nothing expands, so the quote itself
 * is the only character needing a spell.
 *
 * On Windows the shell is not known, and the two there disagree:
 * `cmd.exe` passes a single-quoted word through with its quotes,
 * expands `%NAME%` inside double quotes, and expands `!NAME!` when
 * delayed expansion is enabled; PowerShell expands `$name` and the
 * backtick inside double quotes. A double-quoted path holding none of
 * `$`, `` ` ``, `%` and `!` reads as itself in both (a Windows path
 * cannot hold a double quote), so that one form is printed. A path
 * holding one of them has no form both read alike: {@link
 * windowsShellWords} gives each shell its own, and the caller prints
 * both, naming the shell of each - or only PowerShell's, for a `%` or
 * `!` that `cmd.exe` would expand.
 */

/**
 * A word a POSIX shell needs no quoting for: ids like `ent-people-ada`,
 * bare dates and vault-relative paths echo as themselves, everything
 * else gets {@link shellQuote}'d.
 *
 * The plain set is deliberately narrower than bash's own safe-word list
 * (`[A-Za-z0-9_@%+=:,./-]`): the extra characters are safe in a shell
 * but quoting them costs one spelling and saves one audit, and one
 * shared set means every echoed command line quotes by the same rule.
 */
const POSIX_PLAIN_WORD = /^[A-Za-z0-9_./-]+$/u;

/**
 * A word `cmd.exe` needs no quoting for. The set is the POSIX one plus
 * the two characters a Windows path is full of (`:` and `\`), so an
 * ordinary `C:\vault\brain.sqlite` echoes as itself.
 */
const WINDOWS_PLAIN_WORD = /^[A-Za-z0-9_.:\\/-]+$/u;

/**
 * Single-quote a value for bash: a quote inside the value closes the
 * string, emits an escaped quote and reopens it. Inside single quotes a
 * backslash, a `$` and a backtick are literal, so nothing else needs
 * escaping.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}

/** One shell-safe argv word for a POSIX shell: bare when plain, single-quoted otherwise. */
export function shellWord(value: string): string {
  return POSIX_PLAIN_WORD.test(value) ? value : shellQuote(value);
}

/**
 * One shell-safe argv word for `cmd.exe`: bare when plain, double-quoted
 * otherwise.
 *
 * A double quote cannot occur in a Windows path, so the quoted form is
 * exact; a `"` in a value that is not a path is escaped by doubling it,
 * which is what `cmd.exe` reads as one literal quote.
 */
export function cmdWord(value: string): string {
  if (WINDOWS_PLAIN_WORD.test(value)) return value;
  return '"' + value.replace(/"/gu, '""') + '"';
}

/**
 * One argv word for each Windows shell. Bare when plain, the same
 * double-quoted word for both when it holds nothing either shell expands
 * there, and otherwise a single-quoted PowerShell word, in which nothing
 * expands and a quote (a typographic one too) is doubled. `cmd.exe` gets
 * null for a value with `%` or `!`: it substitutes `%NAME%` even inside
 * double quotes and expands `!NAME!` when delayed expansion is enabled.
 * Neither has a quoting form that keeps it literal in all cmd.exe modes.
 */
export function windowsShellWords(value: string): {
  readonly cmd: string | null;
  readonly powershell: string;
} {
  const cmd = value.includes("%") || value.includes("!") ? null : cmdWord(value);
  // PowerShell also closes a string on the typographic quotes: `“`, `”`
  // and `„` a double-quoted one, `‘`, `’`, `‚` and `‛` a single-quoted
  // one, where doubling any of them keeps it literal.
  if (!/[$`%!\u201C-\u201E]/u.test(value)) return { cmd, powershell: cmdWord(value) };
  return { cmd, powershell: "'" + value.replace(/['\u2018-\u201B]/gu, "$&$&") + "'" };
}
