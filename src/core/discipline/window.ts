export interface YesterdayWindow {
  readonly localDate: string; // YYYY-MM-DD in tz
  readonly startUtc: Date;
  readonly endUtc: Date;
}

/**
 * Compute the [start, end) UTC interval that covers "yesterday" in the
 * given IANA timezone, relative to `now`. JS has no built-in tz-aware
 * Date arithmetic, but Intl formatting is enough for the +/- second
 * granularity we need here.
 */
export function yesterdayWindow(now: Date, tz: string): YesterdayWindow {
  // Project now → local civil date.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayLocal = fmt.format(now); // e.g. "2026-05-18"
  const parts = todayLocal.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const todayLocalMidnightUtc = localMidnightUtc(y, m, d, tz);
  const yesterdayLocalMidnightUtc = new Date(
    todayLocalMidnightUtc.getTime() - 24 * 60 * 60 * 1000,
  );
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(yesterdayLocalMidnightUtc);
  return {
    localDate,
    startUtc: yesterdayLocalMidnightUtc,
    endUtc: todayLocalMidnightUtc,
  };
}

/**
 * Find the UTC instant that corresponds to local midnight on the given
 * civil date in tz. Iteratively correct the naive UTC midnight using
 * Intl's offset for the guessed instant. 4 iterations is enough for any
 * IANA timezone (verified against tzdata 2024a).
 */
function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  for (let i = 0; i < 4; i++) {
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(guess);
    const [date, time] = local.split(", ");
    const timeParts = (time ?? "").split(":").map(Number);
    const hh = timeParts[0]!;
    const mm = timeParts[1]!;
    const ss = timeParts[2]!;
    const drift = hh * 3600 + mm * 60 + ss;
    const expected = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
    if (date === expected && drift === 0) return guess;
    guess = new Date(guess.getTime() - drift * 1000);
  }
  return guess;
}
