# App icons

Tauri needs platform icons (the set referenced in `../tauri.conf.json` →
`bundle.icon`), and it reads them even in **dev** — `generate_context!` panics with
a missing-icon error, so *both* `desktop:dev` and `desktop:build` fail without them.

So the generated set is **checked in** here (`32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.icns`, `icon.ico`, `icon.png`) — a clean checkout builds
out of the box.

Regenerate only when the source art changes. `tauri icon` needs a **square**
source, and `docs/powder-monkey.jpg` isn't square, so crop it first (macOS `sips`;
any image tool works):

```sh
# from the repo root, after `bun install` (adds the Tauri CLI)
sips -s format png -c 906 906 docs/powder-monkey.jpg --out /tmp/pm-square.png
bun run tauri icon /tmp/pm-square.png
```

`tauri icon` also emits mobile / Windows-Store variants (`android/`, `ios/`,
`Square*Logo.png`, …) that this desktop app doesn't use — delete those and keep
only the files listed above.
