/**
 * Shared renderer for every `--cron-template` recipe this CLI prints.
 *
 * A recipe is text on stdout and nothing else. It prints a script body,
 * a native crontab line, and an optional 'hermes cron create'
 * invocation; the operator (or an agent acting in the operator's name)
 * copies whichever path fits their host into their own scheduler. No
 * verb that renders a recipe writes a file, spawns a scheduler, or
 * installs anything - the writes all happen later, on the operator's
 * host, from the operator's own crontab.
 *
 * That shape was previously welded to one consumer: the search reindex
 * template hardcoded its script name, its command and its
 * change-detection expression inside the renderer, so a second consumer
 * could not reach the interval-to-cron kernel without copying the whole
 * file. This module is that kernel. The section headers, the heredoc
 * mechanics and the scheduler-recipe block now live in exactly one
 * place, and each consumer supplies a {@link CronRecipeSpec} for the
 * parts that genuinely differ.
 *
 * Duration parser accepts <N>s|m|h|d. Mapping to a cron expression
 * covers the common cadences:
 *   - minutes:  every N (N less than 60)   maps to N-step minutes
 *   - hours:    every N (N less than 24)   maps to N-step hours
 *   - days:     every N (N less than 28)   maps to N-step days
 *   - seconds:  rejected (cron's finest grain is one minute)
 *
 * Every cron step field restarts at the head of its enclosing period, and
 * each unit is bounded so the rendered expression means what the operator
 * asked for INSIDE that period. The day bound is the strictest of the
 * three because its enclosing period varies: a star-slash-N step in the
 * day-of-month field means "the 1st, then every Nth day within each
 * month", so at 28 - the shortest month - and above it collapses to the
 * 1st of every month.
 * `--interval 90d` used to render exactly that and call it 90 days.
 *
 * Inputs outside those bounds raise a CronTemplateError naming what the
 * field can express, rather than a schedule that quietly means something
 * else.
 *
 * A second renderer, {@link renderSystemdTimer}, reads the same spec and
 * prints the same script section followed by a systemd user service and
 * timer pair instead of the crontab and Hermes paths. It is print-only in
 * exactly the same way: the unit files, `systemctl --user` and
 * `loginctl enable-linger` are commands the operator runs, never this
 * CLI. It validates the interval through the same {@link parseInterval},
 * so a cadence cron cannot express is refused in both formats with the
 * same message - a recipe cannot say one thing in cron and another in
 * systemd. {@link parseRecipeFormat} maps a `--format` flag onto one of
 * {@link RECIPE_FORMATS}.
 */

export class CronTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronTemplateError";
  }
}

/**
 * Single-quote a value for bash, the way `discipline-install.ts` quotes
 * the vault it bakes into its job: a quote inside the value closes the
 * string, emits an escaped quote and reopens it. Inside single quotes a
 * backslash, a `$` and a backtick are literal, so nothing else needs
 * escaping. Every operator path a recipe bakes into its script goes
 * through here.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}

/** A line feed or a carriage return anywhere in a value. */
const LINE_BREAK_PATTERN = /[\n\r]/u;

/**
 * Refuse a path that would not survive being baked into a recipe. The
 * script travels inside a heredoc, so a line break in a baked value
 * could end that heredoc early; no real vault or repository path needs
 * one. Returns the value unchanged when it is a single line.
 */
export function singleLinePath(label: string, value: string): string {
  if (LINE_BREAK_PATTERN.test(value)) {
    throw new CronTemplateError(
      label + " path must not contain a line break, got: " + JSON.stringify(value),
    );
  }
  return value;
}

/** Every recipe format a `--format` flag can select; the first is the default. */
export const RECIPE_FORMATS = Object.freeze(["cron", "systemd"] as const);

export type RecipeFormat = (typeof RECIPE_FORMATS)[number];

/** The format a recipe verb renders when no `--format` is given. */
const DEFAULT_RECIPE_FORMAT: RecipeFormat = RECIPE_FORMATS[0];

function isRecipeFormat(value: string): value is RecipeFormat {
  return (RECIPE_FORMATS as ReadonlyArray<string>).includes(value);
}

/**
 * Map a `--format` flag value onto a recipe format. No flag means cron, the
 * format every recipe printed before systemd existed. Anything else that is
 * not a known format is a {@link CronTemplateError}, which every recipe verb
 * already reports through its own refusal exit.
 */
export function parseRecipeFormat(raw: string | undefined): RecipeFormat {
  if (raw === undefined) return DEFAULT_RECIPE_FORMAT;
  if (isRecipeFormat(raw)) return raw;
  throw new CronTemplateError(
    "unknown recipe format " +
      JSON.stringify(raw) +
      ": expected " +
      RECIPE_FORMATS.slice(0, -1).join(", ") +
      " or " +
      RECIPE_FORMATS[RECIPE_FORMATS.length - 1],
  );
}

/** Cron's minute field restarts every hour, so a step must stay under it. */
const MINUTES_PER_HOUR = 60;

/** Cron's hour field restarts every day. */
const HOURS_PER_DAY = 24;

/**
 * The shortest month, and therefore the ceiling on a day-of-month step.
 *
 * A star-slash-N day step fires on the 1st and every Nth day after it
 * WITHIN the month; at 28 no month is long enough for a second firing, so the
 * expression is a monthly schedule whatever N says. Refusing at that
 * boundary is what keeps the rendered cadence and the requested cadence
 * the same claim.
 */
const SHORTEST_MONTH_DAYS = 28;

/** The expression an operator wanting a monthly cadence installs by hand. */
const MONTHLY_CRON_EXPRESSION = "0 0 1 * *";

export interface ParsedInterval {
  /** Cron expression for the chosen interval. */
  readonly cron: string;
  /** Human-readable label (e.g. "30 minutes"). */
  readonly human: string;
  /** Schedule string for 'hermes cron create --schedule ...'. */
  readonly hermesSchedule: string;
  /**
   * The same cadence as a systemd time span (`30m`, `6h`, `1d`): the
   * normalised `<N><unit>`, which systemd reads natively for m, h and d.
   */
  readonly systemdSpan: string;
}

export function parseInterval(raw: string): ParsedInterval {
  const trimmed = raw.trim();
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(trimmed);
  if (!m) {
    throw new CronTemplateError(
      "cannot parse interval " + JSON.stringify(raw) + ": expected <N>s|m|h|d (e.g. 30m, 6h, 1d)",
    );
  }
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const systemdSpan = n + unit;
  if (n <= 0) {
    throw new CronTemplateError("interval must be positive; got " + JSON.stringify(raw));
  }
  if (unit === "s") {
    throw new CronTemplateError(
      "cron grain is one minute -- second-level intervals are not supported",
    );
  }
  if (unit === "m") {
    if (n >= MINUTES_PER_HOUR) {
      const hours = Math.round(n / MINUTES_PER_HOUR);
      throw new CronTemplateError(
        "intervals of " +
          MINUTES_PER_HOUR +
          " minutes or more must use the h unit (e.g. " +
          hours +
          "h)",
      );
    }
    const cron = "*/" + n + " * * * *";
    return { cron, human: n + " minutes", hermesSchedule: cron, systemdSpan };
  }
  if (unit === "h") {
    if (n >= HOURS_PER_DAY) {
      const days = Math.round(n / HOURS_PER_DAY);
      throw new CronTemplateError(
        "intervals of " + HOURS_PER_DAY + " hours or more must use the d unit (e.g. " + days + "d)",
      );
    }
    const cron = "0 */" + n + " * * *";
    return { cron, human: n + " hours", hermesSchedule: cron, systemdSpan };
  }
  // unit === "d". The day-of-month field is the one that cannot be widened
  // by moving to a larger unit, because there is none - so the refusal
  // states what the field means and hands over the monthly expression
  // instead of rendering a step that silently becomes it.
  if (n >= SHORTEST_MONTH_DAYS) {
    throw new CronTemplateError(
      "cron's day-of-month field restarts every month, so an interval of " +
        n +
        " days cannot be expressed: '0 0 */" +
        n +
        " * *' fires on the 1st of every month, not every " +
        n +
        " days. Use an interval below " +
        SHORTEST_MONTH_DAYS +
        "d, or install a monthly job with '" +
        MONTHLY_CRON_EXPRESSION +
        "' yourself.",
    );
  }
  const cron = "0 0 */" + n + " * *";
  return { cron, human: n + " days", hermesSchedule: cron, systemdSpan };
}

/** Options every recipe accepts. Consumers widen this with their own inputs. */
export interface CronRecipeOptions {
  /** Override the resolved o2b binary path (test seam). */
  readonly o2bBin?: string;
}

/**
 * A recipe's options with every default filled in - what the spec's
 * builders receive, so a builder never repeats a default resolution and
 * never has to answer "which binary" for itself.
 */
export type ResolvedCronRecipeOptions<TOptions extends CronRecipeOptions> = TOptions & {
  readonly o2bBin: string;
};

/**
 * Everything one recipe contributes to the shared layout. Anything not
 * named here is common to every recipe and is rendered by
 * {@link renderCronRecipe} from a single source.
 */
export interface CronRecipeSpec<TOptions extends CronRecipeOptions = CronRecipeOptions> {
  /** Header line naming the recipe, e.g. "... - periodic reindex template". */
  readonly title: string;
  /** Job name for the scheduler recipe (`hermes cron create --name`). */
  readonly cronName: string;
  /** Where the operator saves the script, in tilde form. */
  readonly scriptPath: string;
  /** Extra `##` lines under the script section, without their prefix. */
  readonly scriptNotes: ReadonlyArray<string>;
  /** Parenthetical appended to the scheduler section header. */
  readonly schedulerNote: string;
  /** The bash body placed inside the heredoc, newline-terminated. */
  readonly buildScriptBody: (opts: ResolvedCronRecipeOptions<TOptions>) => string;
  /** The command the footer tells the operator to verify the install with. */
  readonly buildVerifyCommand: (opts: ResolvedCronRecipeOptions<TOptions>) => string;
}

/** The binary name assumed when the caller does not override it. */
export const DEFAULT_O2B_BIN = "o2b";

/** Directory the recipes tell operators to keep their scripts in. */
const OPERATOR_SCRIPT_DIR = "~/.local/bin/";

/** Extension of the emitted script. */
const SCRIPT_EXTENSION = ".sh";

/** Heredoc delimiter wrapping the script body. */
const HEREDOC_MARKER = "OSBEOF";

/** Prefix of a tilde-relative home path, and its shell-variable form. */
const TILDE_HOME_PREFIX = "~/";
const SHELL_HOME_PREFIX = "$HOME/";

/** The horizontal rule that opens and closes the recipe. */
const RULE = "# ----------------------------------------------------------------------\n";

/** Prefix of the commentary lines under the script section. */
const NOTE_PREFIX = "##    ";

/** Where a systemd user manager reads unit files from, in tilde form. */
const SYSTEMD_USER_UNIT_DIR = "~/.config/systemd/user/";

/**
 * systemd's own home-directory specifier. `ExecStart=` expands no tilde
 * and no shell variable, so a tilde-relative script path reaches the unit
 * in this form.
 */
const SYSTEMD_HOME_PREFIX = "%h/";

/**
 * Delay after boot before the first run. The timer is monotonic
 * (`OnBootSec=` plus `OnUnitActiveSec=`), not calendar based: without an
 * `OnBootSec=` it has no first activation after a reboot and never fires
 * again. `Persistent=` applies to `OnCalendar=` timers only, so the unit
 * carries none; the boot delay is what catches up after downtime.
 */
const SYSTEMD_BOOT_DELAY = "5m";

/**
 * Conventional install path for a recipe's script, derived from the cron
 * job name so the two can never drift: `osb-reindex` becomes
 * `~/.local/bin/osb-reindex.sh`.
 */
export function operatorScriptPath(cronName: string): string {
  return OPERATOR_SCRIPT_DIR + cronName + SCRIPT_EXTENSION;
}

/**
 * Rewrite a tilde-relative path into its `$HOME` form. The scheduler
 * recipe passes the script path as a quoted argument, where a leading
 * `~` is not expanded by the shell, so the variable form is the only
 * one that resolves. Paths that are not tilde-relative pass through.
 */
function homeExpanded(path: string): string {
  return path.startsWith(TILDE_HOME_PREFIX)
    ? SHELL_HOME_PREFIX + path.slice(TILDE_HOME_PREFIX.length)
    : path;
}

/** The `%h` form of a tilde-relative path, for `ExecStart=`. */
function systemdHomeExpanded(path: string): string {
  return path.startsWith(TILDE_HOME_PREFIX)
    ? SYSTEMD_HOME_PREFIX + path.slice(TILDE_HOME_PREFIX.length)
    : path;
}

/** What both renderers derive from one call before printing anything. */
interface RecipeInputs<TOptions extends CronRecipeOptions> {
  readonly parsed: ParsedInterval;
  readonly resolved: ResolvedCronRecipeOptions<TOptions>;
}

/**
 * Validate the interval and fill the option defaults. Shared so the two
 * renderers refuse the same intervals with the same message.
 */
function recipeInputs<TOptions extends CronRecipeOptions>(
  interval: string,
  opts: TOptions,
): RecipeInputs<TOptions> {
  const parsed = parseInterval(interval);
  const resolved: ResolvedCronRecipeOptions<TOptions> = {
    ...opts,
    o2bBin: opts.o2bBin ?? DEFAULT_O2B_BIN,
  };
  return { parsed, resolved };
}

/** The opening block: title, interval and the format's own lead lines. */
function renderHeader(title: string, parsed: ParsedInterval, lead: ReadonlyArray<string>): string {
  return (
    RULE +
    "# " +
    title +
    "\n" +
    "# interval: " +
    parsed.human +
    "\n" +
    "#\n" +
    lead.map((line) => "# " + line + "\n").join("") +
    RULE
  );
}

/** Section 1, identical in every format: save the script, make it executable. */
function renderScriptSection<TOptions extends CronRecipeOptions>(
  spec: CronRecipeSpec<TOptions>,
  resolved: ResolvedCronRecipeOptions<TOptions>,
): string {
  return (
    "## 1. Watchdog script - save to " +
    spec.scriptPath +
    "\n" +
    spec.scriptNotes.map((line) => NOTE_PREFIX + line + "\n").join("") +
    "\n" +
    "cat >" +
    spec.scriptPath +
    " <<'" +
    HEREDOC_MARKER +
    "'\n" +
    spec.buildScriptBody(resolved) +
    HEREDOC_MARKER +
    "\n" +
    "chmod +x " +
    spec.scriptPath +
    "\n"
  );
}

/** The closing block: how the operator checks the install worked. */
function renderFooter<TOptions extends CronRecipeOptions>(
  spec: CronRecipeSpec<TOptions>,
  resolved: ResolvedCronRecipeOptions<TOptions>,
): string {
  return RULE + "# After install, verify with: " + spec.buildVerifyCommand(resolved) + "\n" + RULE;
}

/**
 * Render one recipe: header, script section, native crontab section,
 * scheduler section, footer. Throws {@link CronTemplateError} for an
 * interval cron cannot express - the caller reports it rather than
 * emitting a recipe on a cadence the scheduler would silently round.
 */
export function renderCronRecipe<TOptions extends CronRecipeOptions>(
  spec: CronRecipeSpec<TOptions>,
  interval: string,
  opts: TOptions,
): string {
  const { parsed, resolved } = recipeInputs(interval, opts);
  const header = renderHeader(spec.title, parsed, [
    "Pick ONE of the three paths below. The watchdog script is the",
    "common piece; both crontab and Hermes-cron rely on it.",
  ]);
  const watchdog = renderScriptSection(spec, resolved);
  const nativeCron =
    "## 2. Native crontab - open 'crontab -e' and append:\n" +
    "\n" +
    parsed.cron +
    "    " +
    spec.scriptPath +
    "\n";
  const hermesCron =
    "## 3. Hermes cron " +
    spec.schedulerNote +
    ":\n" +
    "\n" +
    "hermes cron create \\\n" +
    "  --name " +
    spec.cronName +
    " \\\n" +
    "  --schedule '" +
    parsed.hermesSchedule +
    "' \\\n" +
    '  --command "' +
    homeExpanded(spec.scriptPath) +
    '" \\\n' +
    "  --no-agent\n";
  const footer = renderFooter(spec, resolved);
  return [header, "", watchdog, "", nativeCron, "", hermesCron, "", footer].join("\n");
}

/**
 * Render one recipe as a systemd user timer: header, the same script
 * section {@link renderCronRecipe} prints, a `.service`/`.timer` pair to
 * save under `~/.config/systemd/user/`, the commands that load and enable
 * the timer, the lingering note, and the same verify footer.
 *
 * Print-only, like the cron form: every file and every `systemctl` call
 * in the output is the operator's to run. Throws
 * {@link CronTemplateError} for exactly the intervals the cron form
 * refuses, so switching `--format` never changes which cadences exist.
 */
export function renderSystemdTimer<TOptions extends CronRecipeOptions>(
  spec: CronRecipeSpec<TOptions>,
  interval: string,
  opts: TOptions,
): string {
  const { parsed, resolved } = recipeInputs(interval, opts);
  const servicePath = SYSTEMD_USER_UNIT_DIR + spec.cronName + ".service";
  const timerPath = SYSTEMD_USER_UNIT_DIR + spec.cronName + ".timer";
  const timerUnit = spec.cronName + ".timer";
  const header = renderHeader(spec.title, parsed, [
    "systemd user timer. Save the script and both units below, then",
    "enable the timer. Nothing here is installed for you.",
  ]);
  const watchdog = renderScriptSection(spec, resolved);
  const service =
    "## 2. systemd service - save to " +
    servicePath +
    "\n" +
    "\n" +
    "mkdir -p " +
    SYSTEMD_USER_UNIT_DIR +
    "\n" +
    "cat >" +
    servicePath +
    " <<'" +
    HEREDOC_MARKER +
    "'\n" +
    "[Unit]\n" +
    "Description=" +
    spec.title +
    "\n" +
    "\n" +
    "[Service]\n" +
    "Type=oneshot\n" +
    "ExecStart=" +
    systemdHomeExpanded(spec.scriptPath) +
    "\n" +
    HEREDOC_MARKER +
    "\n";
  const timer =
    "## 3. systemd timer - save to " +
    timerPath +
    "\n" +
    "\n" +
    "cat >" +
    timerPath +
    " <<'" +
    HEREDOC_MARKER +
    "'\n" +
    "[Unit]\n" +
    "Description=" +
    spec.title +
    " (every " +
    parsed.human +
    ")\n" +
    "\n" +
    "[Timer]\n" +
    "OnBootSec=" +
    SYSTEMD_BOOT_DELAY +
    "\n" +
    "OnUnitActiveSec=" +
    parsed.systemdSpan +
    "\n" +
    "\n" +
    "[Install]\n" +
    "WantedBy=timers.target\n" +
    HEREDOC_MARKER +
    "\n";
  const enable =
    "## 4. Load and enable the timer:\n" +
    "\n" +
    "systemctl --user daemon-reload\n" +
    "systemctl --user enable --now " +
    timerUnit +
    "\n" +
    "\n" +
    NOTE_PREFIX +
    "A user timer stops with your last session unless lingering is on;\n" +
    NOTE_PREFIX +
    "run 'loginctl enable-linger \"$USER\"' once so it keeps firing.\n";
  const footer = renderFooter(spec, resolved);
  return [header, "", watchdog, "", service, "", timer, "", enable, "", footer].join("\n");
}
