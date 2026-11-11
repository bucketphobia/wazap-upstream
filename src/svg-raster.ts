/**
 * An SVG drawn to a PNG in a process of its own. src/images.ts runs this file
 * with node, under a time and a memory limit, and kills it past either: the
 * only way to stop librsvg mid-draw, since it draws a filter over the whole
 * canvas in one go and libvips' timeout is only checked between tiles.
 *
 * Usage: node svg-raster.js <in.svg> <out.png>. Prints the size the SVG
 * declares as JSON on stdout (the parent's pipe, not the MCP channel), and
 * nothing else.
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";

/** Pixels drawn at most: an SVG declaring more is drawn smaller, down to this. Enough for a long image's strips. */
const DRAWN_PIXELS_MAX = 16_000_000;
/** The header cap every untrusted image meets in src/images.ts (INPUT_PIXELS_MAX). */
const options = { limitInputPixels: 100_000_000, failOn: "none" } as const;

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) process.exit(2);
sharp.cache(false);
sharp.concurrency(1);
const svg = await readFile(input);
const meta = await sharp(svg, options).metadata();
if (meta.format !== "svg" || !meta.width || !meta.height) process.exit(2);
const scale = Math.min(1, Math.sqrt(DRAWN_PIXELS_MAX / (meta.width * meta.height)));
await sharp(svg, options)
  .resize(Math.max(1, Math.round(meta.width * scale)), Math.max(1, Math.round(meta.height * scale)), { fit: "fill" })
  .png({ compressionLevel: 1 })
  .toFile(output);
process.stdout.write(JSON.stringify({ width: meta.width, height: meta.height }));
