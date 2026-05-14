#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
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
  CAPTURE_FAILED: 6,
  AGENT_BROWSER_MISSING: 7,
} as const;

type Viewport = { width: number; height: number };
type IgnoreRect = { x: number; y: number; w: number; h: number };

const HELP = `${pkg.name} v${pkg.version}

Compare two PNG images — or two live URLs — pixel-by-pixel and emit a diff image.
Powered by pixelmatch. URL mode shells out to agent-browser for captures.

USAGE
  pixel-diff <a> <b> [out_diff] [options]

ARGUMENTS
  a, b         Each is either:
                 • a path to a PNG file (image mode), or
                 • an http(s):// or file:// URL (URL mode — both must be URLs).
  out_diff     Diff PNG path (default: ./diff.png).
               In multi-viewport mode, this is treated as a stem and the file
               name becomes \`<stem>-<W>x<H>.png\` for each viewport.

OPTIONS
  -t, --threshold <num>          Pixelmatch sensitivity 0..1 (default 0.1, lower = stricter).
                                 Env fallback: PIXELMATCH_THRESHOLD.
  -j, --json                     Emit a single JSON object to stdout. Logs go to stderr.
      --ignore <x,y,w,h>         Mask a rectangle in BOTH images before diffing.
                                 Repeat for multiple regions.
      --viewport <WxH[,WxH...]>  Browser viewport(s). URL mode only. Default 1280x800.
                                 Comma-separate to diff multiple viewports in one run.
      --full-page                Capture the full scrollable page. URL mode only.
      --wait <ms>                Extra wait after networkidle (default 800). URL mode only.
      --workdir <dir>            Where intermediate captures live. URL mode only.
                                 Default: \$TMPDIR/pixel-diff/<ts>.
      --keep                     Don't delete the workdir on success. URL mode only.
  -h, --help                     Show this help and exit.
  -V, --version                  Print version and exit.

EXIT CODES
  0  identical (all viewports, when multi)
  1  differences found (diff image written)
  2  usage error
  3  input file not found (image mode)
  4  size mismatch between the two inputs
  5  failed to read or decode a PNG
  6  capture failed (URL mode)
  7  agent-browser not on PATH (URL mode only)

EXAMPLES
  # Image diff
  pixel-diff a.png b.png

  # URL diff (single viewport, JSON for agents)
  pixel-diff https://old.example.com https://new.example.com --json

  # URL diff across mobile / tablet / desktop in one run
  pixel-diff URL_A URL_B --viewport 375x812,768x1024,1280x800 --json

  # Mask the header (top 80px) and a sidebar rect before diffing
  pixel-diff a.png b.png --ignore 0,0,1280,80 --ignore 1100,80,180,500

  # One-liner from GitHub
  bunx iemong/pixel-diff URL_A URL_B --json

JSON SCHEMA — image mode
  {
    "mode": "image",
    "image_a": "a.png", "image_b": "b.png", "out": "diff.png",
    "width": 1280, "height": 720,
    "total_pixels": 921600, "diff_pixels": 1234, "diff_percent": 0.134,
    "threshold": 0.1, "identical": false,
    "ignore_regions": []
  }

JSON SCHEMA — URL mode
  {
    "mode": "url",
    "url_a": "...", "url_b": "...",
    "threshold": 0.1,
    "ignore_regions": [],
    "all_identical": false,
    "results": [
      { "viewport": { "width": 1280, "height": 800 },
        "image_a": "/tmp/.../a-1280x800.png",
        "image_b": "/tmp/.../b-1280x800.png",
        "out": "./diff-1280x800.png",
        "width": 1280, "height": 800,
        "total_pixels": 1024000, "diff_pixels": 832, "diff_percent": 0.081,
        "identical": false }
    ]
  }

JSON SCHEMA — error
  {
    "error": "size_mismatch" | "not_found" | "read_error" | "usage" |
             "capture_failed" | "agent_browser_missing",
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
  viewports: Viewport[] | null;
  ignore: IgnoreRect[];
  fullPage: boolean;
  waitMs: number;
  workdir: string | null;
  keep: boolean;
};

function parseViewportSpec(s: string): Viewport | null {
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  const width = Number.parseInt(m[1]!, 10);
  const height = Number.parseInt(m[2]!, 10);
  if (!width || !height) return null;
  return { width, height };
}

function parseViewportList(s: string): Viewport[] | null {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const out: Viewport[] = [];
  for (const p of parts) {
    const v = parseViewportSpec(p);
    if (!v) return null;
    out.push(v);
  }
  return out.length > 0 ? out : null;
}

function parseIgnoreRect(s: string): IgnoreRect | null {
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function parseArgs(argv: string[]): Args | { _error: string } {
  const out: Args = {
    positionals: [],
    json: false,
    help: false,
    version: false,
    viewports: null,
    ignore: [],
    fullPage: false,
    waitMs: 800,
    workdir: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-V" || a === "--version") out.version = true;
    else if (a === "-j" || a === "--json") out.json = true;
    else if (a === "-t" || a === "--threshold" || a.startsWith("--threshold=")) {
      const raw = a.startsWith("--threshold=") ? a.slice("--threshold=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --threshold" };
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { _error: `invalid --threshold: ${raw} (expected 0..1)` };
      }
      out.threshold = n;
    } else if (a === "--viewport" || a.startsWith("--viewport=")) {
      const raw = a.startsWith("--viewport=") ? a.slice("--viewport=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --viewport" };
      const vs = parseViewportList(raw);
      if (!vs) return { _error: `invalid --viewport: ${raw} (expected WxH or WxH,WxH,...)` };
      out.viewports = vs;
    } else if (a === "--full-page") {
      out.fullPage = true;
    } else if (a === "--wait" || a.startsWith("--wait=")) {
      const raw = a.startsWith("--wait=") ? a.slice("--wait=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --wait" };
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { _error: `invalid --wait: ${raw} (expected ms ≥ 0)` };
      out.waitMs = n;
    } else if (a === "--workdir" || a.startsWith("--workdir=")) {
      const raw = a.startsWith("--workdir=") ? a.slice("--workdir=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --workdir" };
      out.workdir = raw;
    } else if (a === "--keep") {
      out.keep = true;
    } else if (a === "--ignore" || a.startsWith("--ignore=")) {
      const raw = a.startsWith("--ignore=") ? a.slice("--ignore=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --ignore" };
      const r = parseIgnoreRect(raw);
      if (!r) return { _error: `invalid --ignore: ${raw} (expected x,y,w,h with w,h > 0)` };
      out.ignore.push(r);
    } else if (a.startsWith("-")) {
      return { _error: `unknown option: ${a}` };
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

function emit(json: boolean, payload: Record<string, unknown>, humanLines: string[]): void {
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else for (const line of humanLines) console.log(line);
}

function log(json: boolean, line: string): void {
  if (json) process.stderr.write(`${line}\n`);
  else console.log(line);
}

function fail(
  json: boolean,
  code: number,
  payload: Record<string, unknown>,
  humanLines: string[],
): never {
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else for (const line of humanLines) console.error(line);
  process.exit(code);
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^file:\/\//i.test(s);
}

function suffixedOut(out: string, viewport: Viewport | null): string {
  if (!viewport) return out;
  const dot = out.lastIndexOf(".");
  const stem = dot > 0 ? out.slice(0, dot) : out;
  const ext = dot > 0 ? out.slice(dot) : ".png";
  return `${stem}-${viewport.width}x${viewport.height}${ext}`;
}

function readPng(
  path: string,
  json: boolean,
): { width: number; height: number; data: Buffer } {
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
      [`error: failed to read or decode PNG: ${path}`, `cause: ${(e as Error).message}`],
    );
  }
}

function maskRegions(
  png: { width: number; height: number; data: Buffer },
  regions: IgnoreRect[],
): void {
  for (const { x, y, w, h } of regions) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(png.width, Math.floor(x + w));
    const y1 = Math.min(png.height, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) {
      const rowStart = yy * png.width * 4;
      for (let xx = x0; xx < x1; xx++) {
        const idx = rowStart + xx * 4;
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 255;
      }
    }
  }
}

type DiffResult = {
  width: number;
  height: number;
  total_pixels: number;
  diff_pixels: number;
  diff_percent: number;
  identical: boolean;
  out: string;
};

function diffPair(
  aPath: string,
  bPath: string,
  outPath: string,
  threshold: number,
  ignore: IgnoreRect[],
  json: boolean,
): DiffResult {
  const imgA = readPng(aPath, json);
  const imgB = readPng(bPath, json);

  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    fail(
      json,
      EXIT.SIZE_MISMATCH,
      {
        error: "size_mismatch",
        message: "image dimensions do not match",
        image_a: { path: aPath, width: imgA.width, height: imgA.height },
        image_b: { path: bPath, width: imgB.width, height: imgB.height },
        suggestion:
          "use --viewport to capture both URLs at the same size, or resize/crop the PNGs",
      },
      [
        `error: size mismatch — A=${imgA.width}x${imgA.height}, B=${imgB.width}x${imgB.height}`,
        "→ resize/crop to the same dimensions first.",
      ],
    );
  }

  if (ignore.length > 0) {
    maskRegions(imgA, ignore);
    maskRegions(imgB, ignore);
  }

  const { width, height } = imgA;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold,
    includeAA: false,
  });
  writeFileSync(outPath, PNG.sync.write(diff));

  const total = width * height;
  const pct = Number(((diffPixels / total) * 100).toFixed(3));
  return {
    width,
    height,
    total_pixels: total,
    diff_pixels: diffPixels,
    diff_percent: pct,
    identical: diffPixels === 0,
    out: outPath,
  };
}

async function captureUrl(
  url: string,
  viewport: Viewport,
  pngOut: string,
  opts: { fullPage: boolean; waitMs: number; sessionSuffix: string },
  json: boolean,
): Promise<void> {
  const session = `pixel-diff-${process.pid}-${Date.now()}-${opts.sessionSuffix}`;
  const W = String(viewport.width);
  const H = String(viewport.height);
  const WAIT = String(opts.waitMs);
  try {
    await $`agent-browser --session ${session} open about:blank`.quiet();
    await $`agent-browser --session ${session} set viewport ${W} ${H}`.quiet();
    await $`agent-browser --session ${session} open ${url}`.quiet();
    await $`agent-browser --session ${session} wait --load networkidle`.nothrow().quiet();
    if (opts.waitMs > 0) {
      await $`agent-browser --session ${session} wait ${WAIT}`.nothrow().quiet();
    }
    if (opts.fullPage) {
      await $`agent-browser --session ${session} screenshot --full ${pngOut}`.quiet();
    } else {
      await $`agent-browser --session ${session} screenshot ${pngOut}`.quiet();
    }
  } catch (e) {
    await $`agent-browser --session ${session} close`.nothrow().quiet();
    fail(
      json,
      EXIT.CAPTURE_FAILED,
      {
        error: "capture_failed",
        message: `agent-browser capture failed for ${url}`,
        url,
        viewport,
        cause: (e as Error).message,
        suggestion:
          "verify the URL loads in agent-browser; for auth, run `agent-browser state load` first",
      },
      [
        `error: agent-browser capture failed for ${url}`,
        `viewport: ${viewport.width}x${viewport.height}`,
        `cause: ${(e as Error).message}`,
      ],
    );
  }
  await $`agent-browser --session ${session} close`.nothrow().quiet();
}

function ensureAgentBrowser(json: boolean): void {
  if (!Bun.which("agent-browser")) {
    fail(
      json,
      EXIT.AGENT_BROWSER_MISSING,
      {
        error: "agent-browser_missing",
        message: "agent-browser is not on PATH",
        suggestion: "install agent-browser, or pass PNG paths instead of URLs",
      },
      [
        "error: agent-browser is not on PATH",
        "→ install agent-browser, or pass PNG paths instead of URLs.",
      ],
    );
  }
}

async function runImageMode(args: Args, aPath: string, bPath: string, outPath: string) {
  const json = args.json;

  if (args.viewports) {
    fail(json, EXIT.USAGE, {
      error: "usage",
      message: "--viewport is only valid in URL mode (both inputs must be URLs)",
      suggestion: "drop --viewport, or pass URLs instead of file paths",
    }, ["error: --viewport requires URL inputs"]);
  }
  for (const flag of ["--full-page", "--wait", "--workdir", "--keep"] as const) {
    if (
      (flag === "--full-page" && args.fullPage) ||
      (flag === "--wait" && args.waitMs !== 800) ||
      (flag === "--workdir" && args.workdir !== null) ||
      (flag === "--keep" && args.keep)
    ) {
      fail(json, EXIT.USAGE, {
        error: "usage",
        message: `${flag} is only valid in URL mode`,
        suggestion: "pass URLs instead of file paths, or drop the flag",
      }, [`error: ${flag} requires URL inputs`]);
    }
  }

  for (const p of [aPath, bPath]) {
    if (!existsSync(p)) {
      fail(json, EXIT.NOT_FOUND, {
        error: "not_found",
        message: `file not found: ${p}`,
        path: p,
        suggestion: "check the path and that the file exists",
      }, [`error: file not found: ${p}`]);
    }
  }

  const threshold = resolveThreshold(args);
  const result = diffPair(aPath, bPath, outPath, threshold, args.ignore, json);

  emit(json, {
    mode: "image",
    image_a: aPath,
    image_b: bPath,
    out: result.out,
    width: result.width,
    height: result.height,
    total_pixels: result.total_pixels,
    diff_pixels: result.diff_pixels,
    diff_percent: result.diff_percent,
    threshold,
    identical: result.identical,
    ignore_regions: args.ignore,
  }, [
    `size:        ${result.width}x${result.height} (${result.total_pixels.toLocaleString()} px)`,
    `diff pixels: ${result.diff_pixels.toLocaleString()} (${result.diff_percent}%)`,
    `diff image:  ${result.out}`,
  ]);

  process.exit(result.identical ? EXIT.IDENTICAL : EXIT.DIFF_FOUND);
}

async function runUrlMode(args: Args, urlA: string, urlB: string, outPath: string) {
  const json = args.json;
  ensureAgentBrowser(json);

  const viewports = args.viewports ?? [{ width: 1280, height: 800 }];
  const multi = viewports.length > 1;

  const workdir =
    args.workdir ?? join(tmpdir(), "pixel-diff", `${process.pid}-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });

  const threshold = resolveThreshold(args);
  const results: (DiffResult & { viewport: Viewport; image_a: string; image_b: string })[] = [];

  log(json, `[pixel-diff]`);
  log(json, `  url_a:      ${urlA}`);
  log(json, `  url_b:      ${urlB}`);
  log(json, `  viewports:  ${viewports.map((v) => `${v.width}x${v.height}`).join(", ")}`);
  log(json, `  workdir:    ${workdir}`);
  if (args.ignore.length > 0) {
    log(json, `  ignore:     ${args.ignore.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(" / ")}`);
  }

  for (const v of viewports) {
    const tag = `${v.width}x${v.height}`;
    log(json, `→ capture ${tag}`);
    const aPng = join(workdir, `a-${tag}.png`);
    const bPng = join(workdir, `b-${tag}.png`);
    await captureUrl(urlA, v, aPng, { fullPage: args.fullPage, waitMs: args.waitMs, sessionSuffix: `a-${tag}` }, json);
    await captureUrl(urlB, v, bPng, { fullPage: args.fullPage, waitMs: args.waitMs, sessionSuffix: `b-${tag}` }, json);

    const diffOut = multi ? suffixedOut(outPath, v) : outPath;
    log(json, `→ diff ${tag}`);
    const d = diffPair(aPng, bPng, diffOut, threshold, args.ignore, json);
    results.push({ ...d, viewport: v, image_a: aPng, image_b: bPng });
  }

  const allIdentical = results.every((r) => r.identical);

  emit(json, {
    mode: "url",
    url_a: urlA,
    url_b: urlB,
    threshold,
    ignore_regions: args.ignore,
    all_identical: allIdentical,
    results: results.map((r) => ({
      viewport: r.viewport,
      image_a: r.image_a,
      image_b: r.image_b,
      out: r.out,
      width: r.width,
      height: r.height,
      total_pixels: r.total_pixels,
      diff_pixels: r.diff_pixels,
      diff_percent: r.diff_percent,
      identical: r.identical,
    })),
  }, results.flatMap((r) => [
    `[${r.viewport.width}x${r.viewport.height}]`,
    `  size:        ${r.width}x${r.height} (${r.total_pixels.toLocaleString()} px)`,
    `  diff pixels: ${r.diff_pixels.toLocaleString()} (${r.diff_percent}%)`,
    `  diff image:  ${r.out}`,
  ]).concat(multi ? [`all identical: ${allIdentical}`] : []));

  if (!args.keep && !args.workdir) {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(allIdentical ? EXIT.IDENTICAL : EXIT.DIFF_FOUND);
}

function resolveThreshold(args: Args): number {
  return (
    args.threshold ??
    (process.env.PIXELMATCH_THRESHOLD !== undefined
      ? Number(process.env.PIXELMATCH_THRESHOLD)
      : 0.1)
  );
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

const [aArg, bArg, outArg = "diff.png"] = parsed.positionals;
const jsonFlag = parsed.json;

if (!aArg || !bArg) {
  fail(jsonFlag, EXIT.USAGE, {
    error: "usage",
    message: "two inputs are required (image paths or URLs)",
    suggestion: "pixel-diff <a> <b> [out_diff] — see --help",
  }, [
    "error: two inputs are required (image paths or URLs)",
    "usage: pixel-diff <a> <b> [out_diff] [options]",
    "       run `pixel-diff --help` for details.",
  ]);
}

const aIsUrl = isUrl(aArg);
const bIsUrl = isUrl(bArg);

if (aIsUrl !== bIsUrl) {
  fail(jsonFlag, EXIT.USAGE, {
    error: "usage",
    message: "inputs must both be URLs or both be file paths (mixed not supported yet)",
    suggestion: "capture the URL with agent-browser first, then diff against the PNG",
  }, [
    "error: inputs must both be URLs or both be file paths",
    "→ capture the URL separately and pass two PNGs, or pass two URLs.",
  ]);
}

if (aIsUrl) {
  await runUrlMode(parsed, aArg, bArg, outArg);
} else {
  await runImageMode(parsed, aArg, bArg, outArg);
}
