/**
 * Ceiling for the regression guards that prove a pass over a large input
 * stays linear. A quadratic pass over 256 KiB takes tens of seconds (the old
 * quote normaliser: 50 s, the old fence mask: 20 s); linear code takes well
 * under 0.5 s even on a loaded runner, so the ceiling is generous on purpose
 * and still discriminates by an order of magnitude.
 */
export const LINEAR_CEILING_MS = 2000;
