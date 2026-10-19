/**
 * Ceiling for the regression guards that prove a pass over a large input
 * stays linear. A quadratic pass over 256 KiB takes tens of seconds (the old
 * quote normaliser: 50 s, the old fence mask: 20 s); linear code takes well
 * under 0.5 s on a quiet runner and has been observed up to about 4 s on a
 * loaded CI runner, so the ceiling keeps an order of magnitude over the quiet
 * case while still sitting far below any quadratic time.
 */
export const LINEAR_CEILING_MS = 5000;
