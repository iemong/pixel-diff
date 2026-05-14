#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const [, , aPath, bPath, outPath = "diff.png"] = process.argv;

if (!aPath || !bPath) {
  console.error("Usage: bun run diff <imageA.png> <imageB.png> [outDiff.png]");
  console.error("       defaults: outDiff.png = ./diff.png");
  process.exit(2);
}

const imgA = PNG.sync.read(readFileSync(aPath));
const imgB = PNG.sync.read(readFileSync(bPath));

if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
  console.error(
    `size mismatch: A=${imgA.width}x${imgA.height}, B=${imgB.width}x${imgB.height}`,
  );
  console.error("→ resize/crop to the same dimensions first.");
  process.exit(2);
}

const { width, height } = imgA;
const diff = new PNG({ width, height });

const threshold = Number(process.env.PIXELMATCH_THRESHOLD ?? 0.1);
const mismatched = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
  threshold,
  includeAA: false,
});

writeFileSync(outPath, PNG.sync.write(diff));

const total = width * height;
const pct = ((mismatched / total) * 100).toFixed(3);
console.log(`size:        ${width}x${height} (${total.toLocaleString()} px)`);
console.log(`diff pixels: ${mismatched.toLocaleString()} (${pct}%)`);
console.log(`diff image:  ${outPath}`);

process.exit(mismatched > 0 ? 1 : 0);
