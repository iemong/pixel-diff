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
type DiffRegion = { x: number; y: number; w: number; h: number; diff_pixels: number };
type ElementRect = { x: number; y: number; w: number; h: number };
type ElementInfo = { rect: ElementRect; text: string };
type SelectorMatch = {
  a: ElementInfo | null;
  b: ElementInfo | null;
  delta: { dx: number; dy: number; dw: number; dh: number } | null;
};
type SelectorResult = { selector: string; matches: SelectorMatch[] };

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
      --state <path>             Load an agent-browser state file into each capture session
                                 before navigating. Use for authenticated pages.
                                 Save state first with \`agent-browser state save <path>\`.
                                 URL mode only.
      --rects <selector>         Capture getBoundingClientRect for matching elements on
                                 both URLs and emit position deltas. Repeatable.
                                 URL mode only.
      --min-cluster <N>          Filter out diff regions smaller than N pixels (default 1).
      --max-regions <N>          Cap the diff_regions array at the top N largest clusters
                                 (default 100; set 0 for unlimited).
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

  # Authenticated URL diff — save state once, reuse forever
  agent-browser open https://app.example.com/login   # log in interactively
  agent-browser state save /tmp/auth.json
  pixel-diff https://app.example.com/dashboard{,?env=stg} \\
    --state /tmp/auth.json --json

  # Inspect exact pixel deltas of named elements
  pixel-diff URL_A URL_B --rects 'h1' --rects '.cta' --json
  # → "h1" delta { dx: 0, dy: 8, dw: 0, dh: 0 } says the h1 moved 8px down in B.

  # One-liner from GitHub
  bunx iemong/pixel-diff URL_A URL_B --json

JSON SCHEMA — image mode
  {
    "mode": "image",
    "image_a": "a.png", "image_b": "b.png", "out": "diff.png",
    "width": 1280, "height": 720,
    "total_pixels": 921600, "diff_pixels": 1234, "diff_percent": 0.134,
    "threshold": 0.1, "identical": false,
    "ignore_regions": [],
    "diff_regions": [
      { "x": 100, "y": 80, "w": 200, "h": 8, "diff_pixels": 1600 }
    ]
  }

JSON SCHEMA — URL mode
  {
    "mode": "url",
    "url_a": "...", "url_b": "...",
    "threshold": 0.1, "ignore_regions": [], "all_identical": false,
    "results": [
      { "viewport": { "width": 1280, "height": 800 },
        "image_a": "...", "image_b": "...", "out": "./diff-1280x800.png",
        "width": 1280, "height": 800,
        "total_pixels": 1024000, "diff_pixels": 832, "diff_percent": 0.081,
        "identical": false,
        "diff_regions": [{ "x":..., "y":..., "w":..., "h":..., "diff_pixels":... }],
        "rects": [        // present only when --rects was passed
          { "selector": "h1",
            "matches": [
              { "a": { "rect": {"x":24,"y":80,"w":400,"h":48}, "text": "Welcome" },
                "b": { "rect": {"x":24,"y":88,"w":400,"h":48}, "text": "Welcome" },
                "delta": { "dx": 0, "dy": 8, "dw": 0, "dh": 0 } } ] } ] }
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
  statePath: string | null;
  minCluster: number;
  maxRegions: number;
  rectsSelectors: string[];
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
    statePath: null,
    minCluster: 1,
    maxRegions: 100,
    rectsSelectors: [],
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
    } else if (a === "--state" || a.startsWith("--state=")) {
      const raw = a.startsWith("--state=") ? a.slice("--state=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --state" };
      out.statePath = raw;
    } else if (a === "--ignore" || a.startsWith("--ignore=")) {
      const raw = a.startsWith("--ignore=") ? a.slice("--ignore=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --ignore" };
      const r = parseIgnoreRect(raw);
      if (!r) return { _error: `invalid --ignore: ${raw} (expected x,y,w,h with w,h > 0)` };
      out.ignore.push(r);
    } else if (a === "--min-cluster" || a.startsWith("--min-cluster=")) {
      const raw = a.startsWith("--min-cluster=") ? a.slice("--min-cluster=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --min-cluster" };
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) return { _error: `invalid --min-cluster: ${raw} (expected ≥ 1)` };
      out.minCluster = Math.floor(n);
    } else if (a === "--max-regions" || a.startsWith("--max-regions=")) {
      const raw = a.startsWith("--max-regions=") ? a.slice("--max-regions=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --max-regions" };
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { _error: `invalid --max-regions: ${raw} (expected ≥ 0)` };
      out.maxRegions = Math.floor(n);
    } else if (a === "--rects" || a.startsWith("--rects=")) {
      const raw = a.startsWith("--rects=") ? a.slice("--rects=".length) : argv[++i];
      if (raw === undefined) return { _error: "missing value for --rects" };
      if (!raw.trim()) return { _error: "--rects selector cannot be empty" };
      out.rectsSelectors.push(raw);
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

/**
 * Find connected clusters of diff pixels in pixelmatch's output buffer.
 * pixelmatch paints diff pixels as exact #ff0000 by default — we detect them
 * via exact RGB equality and flood-fill 8-connected neighbors.
 */
function findClusters(
  buffer: Buffer,
  width: number,
  height: number,
  minCluster: number,
  maxRegions: number,
): DiffRegion[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const out: DiffRegion[] = [];

  const isDiff = (idx: number): boolean =>
    buffer[idx] === 255 && buffer[idx + 1] === 0 && buffer[idx + 2] === 0;

  // Reusable stack for BFS iteration to avoid GC churn
  const stack: number[] = [];

  for (let y0 = 0; y0 < height; y0++) {
    for (let x0 = 0; x0 < width; x0++) {
      const i0 = y0 * width + x0;
      if (visited[i0]) continue;
      visited[i0] = 1;
      if (!isDiff(i0 * 4)) continue;

      let minX = x0, maxX = x0, minY = y0, maxY = y0, count = 1;
      stack.length = 0;
      stack.push(i0);

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % width;
        const cy = (cur - cx) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (visited[ni]) continue;
            visited[ni] = 1;
            if (!isDiff(ni * 4)) continue;
            count++;
            if (nx < minX) minX = nx;
            else if (nx > maxX) maxX = nx;
            if (ny < minY) minY = ny;
            else if (ny > maxY) maxY = ny;
            stack.push(ni);
          }
        }
      }

      if (count >= minCluster) {
        out.push({
          x: minX,
          y: minY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
          diff_pixels: count,
        });
      }
    }
  }

  out.sort((a, b) => b.diff_pixels - a.diff_pixels);
  return maxRegions > 0 && out.length > maxRegions ? out.slice(0, maxRegions) : out;
}

type DiffResult = {
  width: number;
  height: number;
  total_pixels: number;
  diff_pixels: number;
  diff_percent: number;
  identical: boolean;
  out: string;
  diff_regions: DiffRegion[];
};

function diffPair(
  aPath: string,
  bPath: string,
  outPath: string,
  threshold: number,
  ignore: IgnoreRect[],
  minCluster: number,
  maxRegions: number,
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
  const regions = diffPixels > 0 ? findClusters(diff.data, width, height, minCluster, maxRegions) : [];
  return {
    width,
    height,
    total_pixels: total,
    diff_pixels: diffPixels,
    diff_percent: pct,
    identical: diffPixels === 0,
    out: outPath,
    diff_regions: regions,
  };
}

function buildRectsEvalScript(selectors: string[]): string {
  // Returns an array (one entry per selector) of arrays of element infos
  // (rect + truncated text). Wrapped in JSON.stringify so eval output is a
  // single line of JSON regardless of agent-browser's formatting.
  const selJson = JSON.stringify(selectors);
  return (
    `JSON.stringify((${selJson}).map(function(sel){` +
    `try{` +
    `return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function(el){` +
    `var r=el.getBoundingClientRect();` +
    `return{rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},` +
    `text:(el.textContent||'').trim().slice(0,100)};` +
    `});` +
    `}catch(e){return[];}` +
    `}))`
  );
}

function parseRectsEvalOutput(stdout: string): ElementInfo[][] {
  // agent-browser may wrap eval results with prefix/suffix lines; find the
  // first valid JSON array in the output.
  const text = stdout.trim();
  // Try direct parse first (clean output)
  const direct = tryParseRects(text);
  if (direct) return direct;
  // Else search line by line
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith('"[')) continue;
    const r = tryParseRects(trimmed);
    if (r) return r;
  }
  return [];
}

function tryParseRects(s: string): ElementInfo[][] | null {
  try {
    let v: unknown = JSON.parse(s);
    // eval result was already a JSON-string of an array → first parse gives the array
    // But agent-browser may double-encode: parsed once is a string starting with [.
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { /* keep as-is */ }
    }
    if (!Array.isArray(v)) return null;
    const out: ElementInfo[][] = [];
    for (const group of v) {
      if (!Array.isArray(group)) { out.push([]); continue; }
      const matches: ElementInfo[] = [];
      for (const el of group) {
        if (!el || typeof el !== "object") continue;
        const rect = (el as Record<string, unknown>).rect as Record<string, unknown> | undefined;
        const text = (el as Record<string, unknown>).text;
        if (!rect) continue;
        const x = Number(rect.x), y = Number(rect.y), w = Number(rect.w), h = Number(rect.h);
        if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
        matches.push({ rect: { x, y, w, h }, text: typeof text === "string" ? text : "" });
      }
      out.push(matches);
    }
    return out;
  } catch {
    return null;
  }
}

async function captureUrl(
  url: string,
  viewport: Viewport,
  pngOut: string,
  opts: {
    fullPage: boolean;
    waitMs: number;
    sessionSuffix: string;
    statePath: string | null;
    selectors: string[];
  },
  json: boolean,
): Promise<{ rectsBySelector: ElementInfo[][] }> {
  const session = `pixel-diff-${process.pid}-${Date.now()}-${opts.sessionSuffix}`;
  const W = String(viewport.width);
  const H = String(viewport.height);
  const WAIT = String(opts.waitMs);
  let rectsBySelector: ElementInfo[][] = [];
  try {
    await $`agent-browser --session ${session} open about:blank`.quiet();
    await $`agent-browser --session ${session} set viewport ${W} ${H}`.quiet();
    if (opts.statePath) {
      await $`agent-browser --session ${session} state load ${opts.statePath}`.quiet();
    }
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
    if (opts.selectors.length > 0) {
      const js = buildRectsEvalScript(opts.selectors);
      const evalOut = await $`agent-browser --session ${session} eval ${js}`.quiet().text();
      rectsBySelector = parseRectsEvalOutput(evalOut);
      if (rectsBySelector.length === 0) {
        // Fill with empties so downstream zip keeps selector alignment
        rectsBySelector = opts.selectors.map(() => []);
      }
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
        suggestion: opts.statePath
          ? "verify the state file is valid and the URL loads after state load"
          : "verify the URL loads in agent-browser; for auth pages pass --state <auth.json>",
      },
      [
        `error: agent-browser capture failed for ${url}`,
        `viewport: ${viewport.width}x${viewport.height}`,
        `cause: ${(e as Error).message}`,
      ],
    );
  }
  await $`agent-browser --session ${session} close`.nothrow().quiet();
  return { rectsBySelector };
}

function buildSelectorResults(
  selectors: string[],
  aResults: ElementInfo[][],
  bResults: ElementInfo[][],
): SelectorResult[] {
  return selectors.map((selector, i) => {
    const aMatches = aResults[i] ?? [];
    const bMatches = bResults[i] ?? [];
    const len = Math.max(aMatches.length, bMatches.length);
    const matches: SelectorMatch[] = [];
    for (let j = 0; j < len; j++) {
      const a = aMatches[j] ?? null;
      const b = bMatches[j] ?? null;
      matches.push({
        a,
        b,
        delta:
          a && b
            ? {
                dx: b.rect.x - a.rect.x,
                dy: b.rect.y - a.rect.y,
                dw: b.rect.w - a.rect.w,
                dh: b.rect.h - a.rect.h,
              }
            : null,
      });
    }
    return { selector, matches };
  });
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
  for (const flag of ["--full-page", "--wait", "--workdir", "--keep", "--state"] as const) {
    if (
      (flag === "--full-page" && args.fullPage) ||
      (flag === "--wait" && args.waitMs !== 800) ||
      (flag === "--workdir" && args.workdir !== null) ||
      (flag === "--keep" && args.keep) ||
      (flag === "--state" && args.statePath !== null)
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

  if (args.rectsSelectors.length > 0) {
    fail(json, EXIT.USAGE, {
      error: "usage",
      message: "--rects is only valid in URL mode",
      suggestion: "pass URLs instead of file paths, or drop --rects",
    }, ["error: --rects requires URL inputs"]);
  }

  const threshold = resolveThreshold(args);
  const result = diffPair(aPath, bPath, outPath, threshold, args.ignore, args.minCluster, args.maxRegions, json);

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
    diff_regions: result.diff_regions,
  }, [
    `size:        ${result.width}x${result.height} (${result.total_pixels.toLocaleString()} px)`,
    `diff pixels: ${result.diff_pixels.toLocaleString()} (${result.diff_percent}%)`,
    `diff image:  ${result.out}`,
    ...formatRegionsHuman(result.diff_regions, "  "),
  ]);

  process.exit(result.identical ? EXIT.IDENTICAL : EXIT.DIFF_FOUND);
}

function formatRegionsHuman(regions: DiffRegion[], indent = ""): string[] {
  if (regions.length === 0) return [];
  const top = regions.slice(0, 3);
  const lines = [`${indent}top regions:`];
  for (const r of top) {
    lines.push(`${indent}  [${r.diff_pixels.toLocaleString()} px]  ${r.w}x${r.h}  at  (${r.x}, ${r.y})`);
  }
  if (regions.length > 3) {
    const rest = regions.slice(3).reduce((sum, r) => sum + r.diff_pixels, 0);
    lines.push(`${indent}  [${rest.toLocaleString()} px]  in ${regions.length - 3} more region(s)`);
  }
  return lines;
}

function formatRectsHuman(rects: SelectorResult[], indent = ""): string[] {
  if (rects.length === 0) return [];
  const lines: string[] = [`${indent}rects:`];
  for (const r of rects) {
    if (r.matches.length === 0) {
      lines.push(`${indent}  ${r.selector}: (no matches)`);
      continue;
    }
    for (let i = 0; i < r.matches.length; i++) {
      const m = r.matches[i]!;
      const label = r.matches.length > 1 ? `${r.selector}[${i}]` : r.selector;
      if (!m.a && !m.b) continue;
      if (!m.a) {
        lines.push(`${indent}  ${label}: A=(missing)  B=${formatElement(m.b!)}`);
      } else if (!m.b) {
        lines.push(`${indent}  ${label}: A=${formatElement(m.a)}  B=(missing)`);
      } else {
        const d = m.delta!;
        const tag =
          d.dx === 0 && d.dy === 0 && d.dw === 0 && d.dh === 0
            ? "match"
            : `Δ ${signed(d.dx)},${signed(d.dy)} (size ${signed(d.dw)},${signed(d.dh)})`;
        lines.push(`${indent}  ${label}: ${formatElement(m.a)} → ${formatElement(m.b)}  [${tag}]`);
      }
    }
  }
  return lines;
}

function formatElement(e: ElementInfo): string {
  return `(${e.rect.x},${e.rect.y} ${e.rect.w}x${e.rect.h})`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

async function runUrlMode(args: Args, urlA: string, urlB: string, outPath: string) {
  const json = args.json;
  ensureAgentBrowser(json);

  if (args.statePath && !existsSync(args.statePath)) {
    fail(json, EXIT.NOT_FOUND, {
      error: "not_found",
      message: `state file not found: ${args.statePath}`,
      path: args.statePath,
      suggestion: "save it first with `agent-browser state save <path>`",
    }, [`error: state file not found: ${args.statePath}`]);
  }

  const viewports = args.viewports ?? [{ width: 1280, height: 800 }];
  const multi = viewports.length > 1;

  const workdir =
    args.workdir ?? join(tmpdir(), "pixel-diff", `${process.pid}-${Date.now()}`);
  mkdirSync(workdir, { recursive: true });

  const threshold = resolveThreshold(args);
  const results: (DiffResult & {
    viewport: Viewport;
    image_a: string;
    image_b: string;
    rects: SelectorResult[];
  })[] = [];

  log(json, `[pixel-diff]`);
  log(json, `  url_a:      ${urlA}`);
  log(json, `  url_b:      ${urlB}`);
  log(json, `  viewports:  ${viewports.map((v) => `${v.width}x${v.height}`).join(", ")}`);
  log(json, `  workdir:    ${workdir}`);
  if (args.statePath) {
    log(json, `  state:      ${args.statePath}`);
  }
  if (args.ignore.length > 0) {
    log(json, `  ignore:     ${args.ignore.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(" / ")}`);
  }
  if (args.rectsSelectors.length > 0) {
    log(json, `  rects:      ${args.rectsSelectors.join(" / ")}`);
  }

  for (const v of viewports) {
    const tag = `${v.width}x${v.height}`;
    log(json, `→ capture ${tag}`);
    const aPng = join(workdir, `a-${tag}.png`);
    const bPng = join(workdir, `b-${tag}.png`);
    const captureOpts = {
      fullPage: args.fullPage,
      waitMs: args.waitMs,
      statePath: args.statePath,
      selectors: args.rectsSelectors,
    };
    const aCap = await captureUrl(urlA, v, aPng, { ...captureOpts, sessionSuffix: `a-${tag}` }, json);
    const bCap = await captureUrl(urlB, v, bPng, { ...captureOpts, sessionSuffix: `b-${tag}` }, json);

    const diffOut = multi ? suffixedOut(outPath, v) : outPath;
    log(json, `→ diff ${tag}`);
    const d = diffPair(aPng, bPng, diffOut, threshold, args.ignore, args.minCluster, args.maxRegions, json);
    const rects = args.rectsSelectors.length > 0
      ? buildSelectorResults(args.rectsSelectors, aCap.rectsBySelector, bCap.rectsBySelector)
      : [];
    results.push({ ...d, viewport: v, image_a: aPng, image_b: bPng, rects });
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
      diff_regions: r.diff_regions,
      ...(r.rects.length > 0 ? { rects: r.rects } : {}),
    })),
  }, results.flatMap((r) => [
    `[${r.viewport.width}x${r.viewport.height}]`,
    `  size:        ${r.width}x${r.height} (${r.total_pixels.toLocaleString()} px)`,
    `  diff pixels: ${r.diff_pixels.toLocaleString()} (${r.diff_percent}%)`,
    `  diff image:  ${r.out}`,
    ...formatRegionsHuman(r.diff_regions, "  "),
    ...formatRectsHuman(r.rects, "  "),
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
