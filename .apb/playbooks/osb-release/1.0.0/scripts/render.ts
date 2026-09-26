// SVG -> PNG with sharp, the rasterizer every Open Second Brain release image
// since v1.0.0 went through (the baoyu-diagram script's call, reduced to it):
// density 72 x scale, resized to the viewBox size x scale.
//
//   bun render.ts <input.svg> <output.png> <scale>
//
// render.sh copies this file next to a pinned sharp install and runs it there,
// so `import("sharp")` resolves to that install.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [input, output, scaleArg] = process.argv.slice(2);
if (!input || !output || !scaleArg) {
  console.error("usage: bun render.ts <input.svg> <output.png> <scale>");
  process.exit(2);
}
const scale = Number(scaleArg);
if (!Number.isFinite(scale) || scale <= 0) {
  console.error(`invalid scale: ${scaleArg}`);
  process.exit(2);
}

const svg = readFileSync(input);
const viewBox = svg.toString("utf8").match(/viewBox\s*=\s*"([^"]+)"/);
if (!viewBox) {
  console.error(`${input}: no viewBox attribute`);
  process.exit(2);
}
const [, , vbWidth, vbHeight] = viewBox[1].split(/[\s,]+/).map(Number);
if (!(vbWidth > 0 && vbHeight > 0)) {
  console.error(`${input}: unusable viewBox "${viewBox[1]}"`);
  process.exit(2);
}

const width = Math.round(vbWidth * scale);
const height = Math.round(vbHeight * scale);
const sharp = (await import("sharp")).default;
mkdirSync(dirname(output), { recursive: true });
await sharp(svg, { density: 72 * scale })
  .resize(width, height)
  .png()
  .toFile(output);
console.log(`${output} ${width}x${height}`);
