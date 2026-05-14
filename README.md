# pixel-diff

Pixel-level PNG diff CLI powered by [pixelmatch](https://github.com/mapbox/pixelmatch).
Runs on [Bun](https://bun.com). One-liner straight from GitHub — no install, no registry.

## Usage

Requires Bun (`curl -fsSL https://bun.sh/install | bash`).

```bash
bunx iemong/pixel-diff a.png b.png                       # writes ./diff.png
bunx iemong/pixel-diff a.png b.png out.png               # custom output path
bunx iemong/pixel-diff a.png b.png --threshold 0.05      # stricter match
bunx iemong/pixel-diff a.png b.png --json                # machine-readable
bunx iemong/pixel-diff --help                            # full help
```

`bunx` clones the repo, installs deps, and runs `index.ts` directly.
The bare `iemong/pixel-diff` shorthand is the same as `github:iemong/pixel-diff#main`.

### Install globally

```bash
bun add -g github:iemong/pixel-diff
pixel-diff a.png b.png
```

Human-readable output:

```
size:        1280x720 (921,600 px)
diff pixels: 1,234 (0.134%)
diff image:  ./diff.png
```

JSON output (`--json` writes a single JSON object to stdout; logs go to stderr):

```json
{
  "image_a": "a.png", "image_b": "b.png", "out": "diff.png",
  "width": 1280, "height": 720,
  "total_pixels": 921600, "diff_pixels": 1234, "diff_percent": 0.134,
  "threshold": 0.1, "identical": false
}
```

On error, `--json` emits a structured object instead:

```json
{
  "error": "size_mismatch",
  "message": "image dimensions do not match",
  "image_a": { "path": "a.png", "width": 100, "height": 100 },
  "image_b": { "path": "b.png", "width": 200, "height": 100 },
  "suggestion": "resize or crop both images to the same dimensions before diffing"
}
```

## Options

| Flag | Description |
| --- | --- |
| `-t`, `--threshold <num>` | Pixelmatch sensitivity 0..1 (default `0.1`, lower = stricter). Also reads `PIXELMATCH_THRESHOLD`. |
| `-j`, `--json` | Emit a single JSON object to stdout. |
| `-h`, `--help` | Show full help and exit. |
| `-V`, `--version` | Print version and exit. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | images are identical |
| `1` | differences found (diff image was written) |
| `2` | usage error (bad arguments) |
| `3` | input file not found |
| `4` | size mismatch between the two images |
| `5` | failed to read or decode a PNG |

Both images must be the same dimensions — resize/crop first if they're not.

## Local dev

```bash
bun install
bun run diff sample-a.png sample-b.png
```

## License

MIT
