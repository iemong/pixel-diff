#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import pkg from "./package.json" with { type: "json" };

const EXIT = {
  IDENTICAL: 0,
  DIFF_FOUND: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  SIZE_MISMATCH: 4,
  READ_ERROR: 5,
} as const;

const HELP = `${pkg.name} v${pkg.version}

Compare two PNG images pixel-by-pixel and emit a diff image.
Powered by pixelmatch (https://github.com/mapbox/pixelmatch).

USAGE
  pixel-diff <image_a> <image_b> [out_diff] [options]

ARGUMENTS
  image_a    Path to baseline PNG (required)
  image_b    Path to candidate PNG (required, must match image_a dimensions)
  out_diff   Path to write the diff PNG (optional, default: ./diff.png)

OPTIONS
  -t, --threshold <num>   Pixelmatch sensitivity 0..1 (default: 0.1, lower = stricter)
                          Also reads env PIXELMATCH_THRESHOLD.
  -j, --json              Emit a single JSON object to stdout (logs go to stderr).
                          Recommended for scripts and AI agents.
  -h, --help              Show this help and exit.
  -V, --version           Print version and exit.

EXIT CODES
  0  images are identical
  1  differences found (diff image written)
  2  usage error (bad arguments)
  3  input file not found
  4  size mismatch between image_a and image_b
  5  failed to read or decode a PNG

EXAMPLES
  # Human-readable
  pixel-diff a.png b.png

  # JSON output for scripts/agents
  pixel-diff a.png b.png --json

  # Stricter threshold, custom output path
  pixel-diff a.png b.png out.png --threshold 0.05

  # One-liner from GitHub (no install, no registry)
  bunx github:iemong/pixel-diff a.png b.png --json

JSON SCHEMA (success)
  {
    "image_a": "a.png", "image_b": "b.png", "out": "diff.png",
    "width": 1280, "height": 720,
    "total_pixels": 921600, "diff_pixels": 1234, "diff_percent": 0.134,
    "threshold": 0.1, "identical": false
  }

JSON SCHEMA (error)
  {
    "error": "size_mismatch" | "not_found" | "read_error" | "usage",
    "message": "...",
    "suggestion": "..."
  }
`;

type Args = {
  positionals: string[];
  threshold?: number;
  json: boolean;
  help: boolean;
  version: boolean;
};

function parseArgs(argv: string[]): Args | { _error: string } {
  const out: Args = { positionals: [], json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-V" || a === "--version") out.version = true;
    else if (a === "-j" || a === "--json") out.json = true;
    else if (a === "-t" || a === "--threshold") {
      const v = argv[++i];
      if (v === undefined) return { _error: "missing value for --threshold" };
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { _error: `invalid --threshold: ${v} (expected 0..1)` };
      }
      out.threshold = n;
    } else if (a.startsWith("--threshold=")) {
      const n = Number(a.slice("--threshold=".length));
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { _error: `invalid --threshold value (expected 0..1)` };
      }
      out.threshold = n;
    } else if (a.startsWith("-")) {
      return { _error: `unknown option: ${a}` };
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

function emit(json: boolean, payload: Record<string, unknown>, humanLines: string[]): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    for (const line of humanLines) console.log(line);
  }
}

function fail(json: boolean, code: number, payload: Record<string, unknown>, humanLines: string[]): never {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    for (const line of humanLines) console.error(line);
  }
  process.exit(code);
}

const parsed = parseArgs(process.argv.slice(2));
if ("_error" in parsed) {
  console.error(`error: ${parsed._error}`);
  console.error(`run \`pixel-diff --help\` for usage.`);
  process.exit(EXIT.USAGE);
}

if (parsed.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (parsed.version) {
  console.log(pkg.version);
  process.exit(0);
}

const [aPath, bPath, outPath = "diff.png"] = parsed.positionals;
const json = parsed.json;

if (!aPath || !bPath) {
  fail(
    json,
    EXIT.USAGE,
    {
      error: "usage",
      message: "image_a and image_b are required",
      suggestion: "pixel-diff <image_a> <image_b> [out_diff] — see --help",
    },
    [
      "error: image_a and image_b are required",
      "usage: pixel-diff <image_a> <image_b> [out_diff] [options]",
      "       run `pixel-diff --help` for details.",
    ],
  );
}

for (const p of [aPath, bPath]) {
  if (!existsSync(p)) {
    fail(
      json,
      EXIT.NOT_FOUND,
      {
        error: "not_found",
        message: `file not found: ${p}`,
        path: p,
        suggestion: "check the path and that the file exists",
      },
      [`error: file not found: ${p}`],
    );
  }
}

function readPng(path: string): { width: number; height: number; data: Buffer } {
  try {
    return PNG.sync.read(readFileSync(path));
  } catch (e) {
    fail(
      json,
      EXIT.READ_ERROR,
      {
        error: "read_error",
        message: `failed to read or decode PNG: ${path}`,
        path,
        cause: (e as Error).message,
        suggestion: "verify the file is a valid PNG",
      },
      [
        `error: failed to read or decode PNG: ${path}`,
        `cause: ${(e as Error).message}`,
      ],
    );
  }
}

const imgA = readPng(aPath);
const imgB = readPng(bPath);

if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
  fail(
    json,
    EXIT.SIZE_MISMATCH,
    {
      error: "size_mismatch",
      message: "image dimensions do not match",
      image_a: { path: aPath, width: imgA.width, height: imgA.height },
      image_b: { path: bPath, width: imgB.width, height: imgB.height },
      suggestion: "resize or crop both images to the same dimensions before diffing",
    },
    [
      `error: size mismatch — A=${imgA.width}x${imgA.height}, B=${imgB.width}x${imgB.height}`,
      "→ resize/crop to the same dimensions first.",
    ],
  );
}

const { width, height } = imgA;
const diff = new PNG({ width, height });

const threshold =
  parsed.threshold ??
  (process.env.PIXELMATCH_THRESHOLD !== undefined
    ? Number(process.env.PIXELMATCH_THRESHOLD)
    : 0.1);

const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
  threshold,
  includeAA: false,
});

writeFileSync(outPath, PNG.sync.write(diff));

const totalPixels = width * height;
const diffPercent = Number(((diffPixels / totalPixels) * 100).toFixed(3));
const identical = diffPixels === 0;

emit(
  json,
  {
    image_a: aPath,
    image_b: bPath,
    out: outPath,
    width,
    height,
    total_pixels: totalPixels,
    diff_pixels: diffPixels,
    diff_percent: diffPercent,
    threshold,
    identical,
  },
  [
    `size:        ${width}x${height} (${totalPixels.toLocaleString()} px)`,
    `diff pixels: ${diffPixels.toLocaleString()} (${diffPercent}%)`,
    `diff image:  ${outPath}`,
  ],
);

process.exit(identical ? EXIT.IDENTICAL : EXIT.DIFF_FOUND);
