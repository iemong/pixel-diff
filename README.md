# @iemong/pixel-diff

Pixel-level PNG diff CLI powered by [pixelmatch](https://github.com/mapbox/pixelmatch).
Run it as a one-liner — no install, no repo needed.

## Usage

```bash
bunx @iemong/pixel-diff a.png b.png            # writes ./diff.png
bunx @iemong/pixel-diff a.png b.png out.png    # custom output path
npx  @iemong/pixel-diff a.png b.png            # works on npx too
```

Output:

```
size:        1280x720 (921,600 px)
diff pixels: 1,234 (0.134%)
diff image:  ./diff.png
```

Exit code: `0` if identical, `1` if any pixel differs, `2` on usage / size-mismatch errors.

## Options

- `PIXELMATCH_THRESHOLD` (env): pixelmatch threshold, default `0.1`. Higher = more tolerant.

```bash
PIXELMATCH_THRESHOLD=0.05 bunx @iemong/pixel-diff a.png b.png
```

Both images must be the same dimensions — resize/crop first if they're not.

## Local dev

```bash
bun install
bun run diff sample-a.png sample-b.png
bun run build      # produces dist/cli.js
```

## License

MIT
