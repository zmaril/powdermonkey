# Desktop client & remote servers

PowderMonkey's UI is a thin pane of glass over a supervisor. By default the
supervisor serves that UI to your browser on `localhost:4500` — but the client and
the server don't have to live on the same machine. You can run the supervisor on a
host somewhere and point a **desktop app** (or just another browser) at it. This
doc covers both halves: choosing a server, and the Tauri desktop wrapper.

## Mental model

The supervisor does the work — it owns the plan store (PGlite), cuts git
worktrees, drives tmux, and runs `claude`. The client only renders and sends
commands. So **the repo lives next to the supervisor**, not next to the client:
"server on a cloud box" means that box holds the working copy. Run it locally and
it's the same laptop as today; run it remotely and the client is pure glass.

One supervisor, many possible clients:

```
   browser @ localhost:4500 ─┐
   desktop app (Tauri) ──────┼──▶  supervisor  ──▶  git worktrees · tmux · claude
   another browser, remote ──┘     (PGlite, API,      (all on the server's machine)
                                     /pty + /sync WS)
```

## Picking a server (Settings → Server)

The client talks to whichever supervisor you select in **Settings → Server**:

- **This device (same origin)** — the supervisor that served this bundle. This is
  the default browser path; nothing to configure.
- **A saved server** — a name + URL you add, e.g. `http://pm.my-tailnet.ts.net:4500`.
  Adding one pings its `/health` first so you catch a wrong URL or a down server
  immediately.

Switching reloads the page: the API client and the live-sync sockets are built
once at load against the chosen server, so a reload re-points them cleanly. Your
choice and your saved list persist in the client's local storage.

Under the hood the selection is a single base URL (`src/web/server.ts`); every API
call, the `/pty` shell socket, and the `/sync` data sockets resolve against it.
When unset, they fall back to `window.location`, which is exactly the original
same-origin behavior — so the plain web app is unchanged.

## Auth: there is none — gate it at the network

PowderMonkey has **no auth and no security model**, by design (see `design.md`).
The `/pty` socket is a live shell and the API can run `claude` with your
credentials. That's fine on `localhost`; it is **not** fine on a public address.

So do not expose the supervisor's port to the internet. Put it on a private
network and let the client reach it there:

- **Tailscale** (recommended) — install it on the server and your client machine;
  use the server's MagicDNS name (`http://pm.my-tailnet.ts.net:4500`). Nothing
  else to configure.
- **SSH tunnel** — `ssh -L 4500:localhost:4500 you@server`, then point the client
  at `http://localhost:4500`.
- **WireGuard / Cloudflare Access / a VPN** — anything that authenticates the
  network path works the same way.

The server sends permissive CORS (`Access-Control-Allow-Origin: *`,
`src/server/cors.ts`) so a client on a *different* origin can call the API. That
adds no exposure beyond the open port itself — anything that can reach the port
could already curl it — which is why the network layer is doing the real gating.

## The desktop app (Tauri)

The desktop client is a native window (Tauri v2) that **ships the same web bundle**
(`public/`, built by `bun run build:web`) and loads it in the OS webview. It has no
server of its own, so on first run open **Settings → Server** and add the
supervisor you want. After that it behaves exactly like the browser app — same
terminal, same plan tree, same review panes — just in its own window, so you stop
losing it among browser tabs.

### Prerequisites

- **Rust** (`rustup`, stable) — the shell is a small Rust crate (`src-tauri/`).
- **Platform webview deps** — macOS: nothing extra. Linux: `webkit2gtk-4.1` +
  `libsoup-3` dev packages. Windows: WebView2 (preinstalled on Win 11). See the
  Tauri v2 prerequisites docs for the exact package names per distro.
- The Tauri CLI is already a dev dependency (`bun install` provides `bun run tauri`).

### Build & run

```sh
bun install                          # once: deps + Tauri CLI
bun run tauri icon docs/powder-monkey.jpg   # once: generate app icons (see src-tauri/icons/)
bun run desktop:dev                  # dev: builds the web bundle + opens the window
bun run desktop:build                # release: produces an installer under src-tauri/target/
```

`desktop:dev`/`desktop:build` run `bun run build:web` first (configured as the
Tauri `beforeBuildCommand`), so the window always loads a fresh bundle. The release
build emits a platform installer (`.dmg`/`.app`, `.msi`/`.exe`, `.deb`/`.AppImage`)
under `src-tauri/target/release/bundle/`.

> The native build needs the Rust toolchain and the platform webview libraries
> above; it can't run in a headless CI container without them. The browser-facing
> half (server selection + cross-origin API) is exercised by the normal web build
> and tests.

### Auto-update (not wired up yet)

Tauri has a first-class updater (the v2 updater plugin): the app polls a small JSON
manifest you host — GitHub Releases works well — verifies a signature against a
public key baked into the app, then downloads, installs, and relaunches. It's a
natural fit for a single-operator tool (no app store, no review), and the main
setup cost is generating a signing key and adding a signed-release step. It's left
out of this first cut; open an issue if you want it turned on.
