# pixel-diff

Compare two PNG images — or two live URLs — pixel-by-pixel and emit a diff image.
Powered by [pixelmatch](https://github.com/mapbox/pixelmatch), runs on [Bun](https://bun.com).
URL mode shells out to [agent-browser](https://www.npmjs.com/package/agent-browser) for captures.
One-liner straight from GitHub — no install, no registry.

| `sample-a.png` | `sample-b.png` | diff |
| :---: | :---: | :---: |
| ![A](./sample-a.png) | ![B](./sample-b.png) | ![diff](./sample-diff.png) |

## Quick start

Requires [Bun](https://bun.com) (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Diff two PNG files
bunx iemong/pixel-diff a.png b.png

# Diff two URLs (needs agent-browser on PATH)
bunx iemong/pixel-diff https://old.example.com https://new.example.com --json
```

That's it. `bunx` clones the repo, installs deps, runs `index.ts`, and writes `diff.png` next to where you ran it.

> The bare `iemong/pixel-diff` shorthand is equivalent to `github:iemong/pixel-diff#main`. The `bunx github:iemong/pixel-diff` form (no ref) currently errors on bun 1.3.x — use the shorthand or pin a ref.

### Image mode

```bash
bunx iemong/pixel-diff a.png b.png out.png             # custom output path
bunx iemong/pixel-diff a.png b.png --threshold 0.05    # stricter match
bunx iemong/pixel-diff a.png b.png --json              # JSON for scripts / agents
bunx iemong/pixel-diff a.png b.png --ignore 0,0,1280,80  # mask the header rect
bunx iemong/pixel-diff a.png b.png \
  --ignore 0,0,1280,80 --ignore 1100,80,180,500          # repeatable
```

### URL mode

Requires `agent-browser` on PATH.

```bash
# Single viewport (default 1280x800)
bunx iemong/pixel-diff URL_A URL_B --json

# Multi-viewport batch — captures and diffs each in one run
bunx iemong/pixel-diff URL_A URL_B \
  --viewport 375x812,768x1024,1280x800 --json

# Full page + custom wait
bunx iemong/pixel-diff URL_A URL_B --full-page --wait 1500

# Keep intermediate captures for debugging
bunx iemong/pixel-diff URL_A URL_B --keep --workdir ./shots
```

Outputs in multi-viewport mode are written as `<stem>-<W>x<H>.png` — e.g. `diff-375x812.png`, `diff-1280x800.png`.

### Install globally

```bash
bun add -g github:iemong/pixel-diff
pixel-diff a.png b.png
```

## Output

Human-readable image mode:

```
size:        1280x720 (921,600 px)
diff pixels: 1,234 (0.134%)
diff image:  ./diff.png
```

JSON image mode (`--json` → single object on **stdout**, logs on **stderr**):

```json
{
  "mode": "image",
  "image_a": "a.png", "image_b": "b.png", "out": "diff.png",
  "width": 1280, "height": 720,
  "total_pixels": 921600, "diff_pixels": 1234, "diff_percent": 0.134,
  "threshold": 0.1, "identical": false,
  "ignore_regions": []
}
```

JSON URL mode (one entry per viewport):

```json
{
  "mode": "url",
  "url_a": "https://old.example.com",
  "url_b": "https://new.example.com",
  "threshold": 0.1,
  "ignore_regions": [],
  "all_identical": false,
  "results": [
    {
      "viewport": { "width": 1280, "height": 800 },
      "image_a": "/tmp/.../a-1280x800.png",
      "image_b": "/tmp/.../b-1280x800.png",
      "out": "./diff-1280x800.png",
      "width": 1280, "height": 800,
      "total_pixels": 1024000, "diff_pixels": 832, "diff_percent": 0.081,
      "identical": false
    }
  ]
}
```

On error, `--json` emits a structured object instead:

```json
{
  "error": "size_mismatch",
  "message": "image dimensions do not match",
  "image_a": { "path": "a.png", "width": 100, "height": 100 },
  "image_b": { "path": "b.png", "width": 200, "height": 100 },
  "suggestion": "use --viewport to capture both URLs at the same size, or resize/crop the PNGs"
}
```

## Options

| Flag | Mode | Description |
| --- | --- | --- |
| `-t`, `--threshold <num>` | both | Pixelmatch sensitivity `0..1` (default `0.1`, lower = stricter). Env fallback `PIXELMATCH_THRESHOLD`. |
| `-j`, `--json` | both | Emit a single JSON object to stdout. |
| `--ignore <x,y,w,h>` | both | Mask a rectangle in **both** images before diffing. Repeatable. |
| `--viewport <WxH[,WxH...]>` | URL | Browser viewport(s). Default `1280x800`. Comma-separate for multi-viewport batch. |
| `--full-page` | URL | Capture the full scrollable page. |
| `--wait <ms>` | URL | Extra wait after `networkidle` (default `800`). |
| `--workdir <dir>` | URL | Where intermediate captures live. Default `$TMPDIR/pixel-diff/<ts>`. |
| `--keep` | URL | Keep workdir on success. |
| `-h`, `--help` | — | Show full help. |
| `-V`, `--version` | — | Print version. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | identical (all viewports, when multi) |
| `1` | differences found (diff image was written) |
| `2` | usage error |
| `3` | input file not found (image mode) |
| `4` | size mismatch between the two inputs |
| `5` | failed to read or decode a PNG |
| `6` | capture failed (URL mode) |
| `7` | agent-browser not on PATH (URL mode) |

Both inputs must produce identical dimensions — pass the same `--viewport`, or resize/crop the PNGs first.

## CI example

```yaml
- uses: oven-sh/setup-bun@v2
- run: |
    bunx iemong/pixel-diff baseline.png current.png \
      --ignore 0,0,1280,80 --json > diff.json
```

The non-zero exit on differences makes it a pass/fail gate.

## Local dev

```bash
git clone https://github.com/iemong/pixel-diff
cd pixel-diff
bun install
bun run diff sample-a.png sample-b.png
```

## License

MIT
