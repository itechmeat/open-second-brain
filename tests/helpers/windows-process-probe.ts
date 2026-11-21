/**
 * What the operating system says about a CLI child that outlived its
 * per-call limit (`spawnWithLimit` in `run-cli.ts`), on Windows only.
 *
 * The hangs seen on the Windows runner left no output at all, so the
 * output cannot tell a child that never got going from one that started
 * and then blocked. The process itself can: a child that never started
 * has a fraction of a second of CPU time and a handful of threads, while
 * a bun that loaded the CLI has seconds of CPU and a dozen threads or
 * more. The thread states and wait reasons say what it is blocked on.
 *
 * Each probe is bounded and never throws: a probe that fails or times
 * out says so in its line, and that is evidence too (a machine that
 * cannot start PowerShell in time is stalled as a whole).
 */

/**
 * The longest one PowerShell probe may take before it is abandoned. The
 * per-call limit leaves room for it below the test's own timeout
 * (`cliChildLimitFor` in `cli-timeout.ts`).
 */
export const OS_PROBE_LIMIT_MS = 2_000;

function probeScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = Get-Process -Id ${pid} } catch { 'no such process'; exit 0 }`,
    "$states = ($p.Threads | Group-Object ThreadState | ForEach-Object { \"$($_.Name) $($_.Count)\" }) -join ', '",
    "$waits = ($p.Threads | Where-Object { $_.ThreadState -eq 'Wait' } | Group-Object WaitReason | ForEach-Object { \"$($_.Name) $($_.Count)\" }) -join ', '",
    "\"name $($p.ProcessName), cpu $([math]::Round($p.TotalProcessorTime.TotalSeconds, 2)) s, threads $($p.Threads.Count) ($states; waiting: $waits), handles $($p.HandleCount), working set $([int]($p.WorkingSet64 / 1MB)) MB, started $($p.StartTime.ToUniversalTime().ToString('o'))\"",
  ].join("; ");
}

/**
 * One line naming the child's state as `Get-Process` sees it now:
 * `os at the limit (Get-Process, <ms> ms; spawned <iso>): <state>`.
 */
export async function windowsProcessState(pid: number, spawnedAt: number): Promise<string> {
  const startedAt = Date.now();
  const head = (detail: string): string =>
    `os at the limit (Get-Process, ${detail}; spawned ${new Date(spawnedAt).toISOString()}): `;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = Bun.spawn(
      // Encoded, so the script's quotes survive the Windows command line.
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(probeScript(pid), "utf16le").toString("base64"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const text = Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    const cap = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), OS_PROBE_LIMIT_MS);
    });
    const out = await Promise.race([text, cap]);
    if (out === null) {
      probe.kill();
      return `${head(`timed out after ${OS_PROBE_LIMIT_MS} ms`)}no answer`;
    }
    const answer = (out[0].trim() || out[1].trim() || "no output").replace(/\s+/g, " ");
    return `${head(`${Date.now() - startedAt} ms`)}${answer}`;
  } catch (err) {
    return `${head("failed")}${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the operating system still has `pid`, for the line after the
 * kill: a child bun has not reaped may still be gone. `exit` is its exit
 * code or signal once reaped, else null.
 */
export function windowsProcessAfterKill(pid: number, exit: number | string | null): string {
  if (exit !== null) return `os after the kill: exited (${exit})`;
  try {
    process.kill(pid, 0);
    return "os after the kill: still present";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === "ESRCH"
      ? "os after the kill: gone, not yet reaped"
      : `os after the kill: unknown (${String(code ?? err)})`;
  }
}

/** One row of the operating system's process table. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly commandLine: string;
}

/**
 * Every process below `root` in `rows`, depth first. A parent id can name a
 * process that has gone and whose id was reused, so a loop is walked once.
 */
export function descendantsOf(root: number, rows: ReadonlyArray<ProcessRow>): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const seen = new Set<number>([root]);
  const out: ProcessRow[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      walk(child.pid);
    }
  };
  walk(root);
  return out;
}

/**
 * The descendant lines of the limit failure. A handle's owner cannot be
 * named without a handle tool, but a pipe outlives the child only through
 * a process it started, so a live descendant is one that can hold it. An
 * empty list clears no one: Windows keeps a parent id that names a process
 * that has exited, so a grandchild whose parent is gone is not linked back
 * to the child and can still hold an inherited pipe.
 */
export function formatDescendants(
  root: number,
  rows: ReadonlyArray<ProcessRow>,
  ms: number,
): string {
  const found = descendantsOf(root, rows);
  const head = `descendants at the limit (Win32_Process, ${ms} ms): `;
  if (found.length === 0) return `${head}none found in this snapshot`;
  return [
    `${head}${found.length}, any of them may hold the child's stdout and stderr`,
    ...found.map((row) => `  pid ${row.pid} (parent ${row.ppid}) ${row.name}: ${row.commandLine}`),
  ].join("\n");
}

const DESCENDANT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } } | ConvertTo-Json -Compress",
].join("; ");

/**
 * The child's live descendants with their command lines, from one
 * bounded `Get-CimInstance Win32_Process` query. Never throws.
 */
export async function windowsDescendants(pid: number): Promise<string> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(DESCENDANT_SCRIPT, "utf16le").toString("base64"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const text = Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    const cap = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), OS_PROBE_LIMIT_MS);
    });
    const out = await Promise.race([text, cap]);
    if (out === null) {
      probe.kill();
      return `descendants at the limit (Win32_Process, timed out after ${OS_PROBE_LIMIT_MS} ms): no answer`;
    }
    const parsed = JSON.parse(out[0]) as ProcessRow | ProcessRow[];
    return formatDescendants(
      pid,
      Array.isArray(parsed) ? parsed : [parsed],
      Date.now() - startedAt,
    );
  } catch (err) {
    return `descendants at the limit (Win32_Process, failed): ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
}
