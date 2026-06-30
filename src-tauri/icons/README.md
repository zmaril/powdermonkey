# App icons

Tauri's bundler needs platform icons (the set referenced in
`../tauri.conf.json` → `bundle.icon`). They're binary and not checked in; generate
them once from a single square source image:

```sh
# from the repo root, after `bun install` (adds the Tauri CLI)
bun run tauri icon docs/powder-monkey.jpg
```

That writes `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and
`icon.ico` into this directory. Re-run it whenever the source art changes. Until
you do, `bun run desktop:build` will fail at the bundling step with a missing-icon
error — `desktop:dev` runs fine without icons.
