# Working in this repo

PowderMonkey is a Bun + Elysia server (`src/server`) serving a React/Mantine UI
(`src/web`), backed by PGlite. See `README.md` and `design.md` for the model.

## Frontend changes must be verified in the browser, with screenshots

If a change touches the UI (`src/web/**`, or a server route the UI calls), don't
call it done after `bun test` / `biome` alone — those don't render anything. Boot
the app in this remote container, drive it with headless Chromium, and attach
before/after screenshots to the PR (or the chat).

The container has everything needed: `bun`, `tmux`, the `claude` CLI, and
Playwright's Chromium under `/opt/pw-browsers`. Your own browser can't reach the
container's `localhost`, so render headlessly and share the image.

Recipe (uses a scratch data dir + isolated tmux socket so it touches nothing real):

```sh
# 1. build the web bundle and boot the server on a scratch dir
bun run build:web
DEMO=$(mktemp -d)
PORT=4500 PM_DATA_DIR="$DEMO/pg" PM_TMUX_SOCKET=pm-demo \
  PM_SUPERVISOR_CMD=true PM_RECONCILE_INTERVAL_MS=0 \
  bun run src/server/index.ts >"$DEMO/server.log" 2>&1 &
sleep 3 && curl -s localhost:4500/health   # {"ok":true}

# 2. seed whatever state your change needs via the API, e.g. a plan + a session
curl -s -X POST localhost:4500/plan -H 'content-type: application/json' -d '{ ... }'

# 3. screenshot with headless Chromium
bun - <<'TS'
import { chromium } from "playwright-core";
const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:4500", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.screenshot({ path: "/tmp/ui.png", fullPage: true });
await b.close();
TS
```

Tear the demo server down when done — it's all under the scratch dir. The Chromium
build number (`chromium-1194`) may differ; if the path is wrong,
`ls /opt/pw-browsers`.
