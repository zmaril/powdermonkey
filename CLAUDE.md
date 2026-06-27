# Working in this repo

PowderMonkey is a Bun + Elysia server (`src/server`) serving a React/Mantine UI
(`src/web`), backed by PGlite. See `README.md` and `design.md` for the model.

## Verify frontend changes by actually rendering them

If a change touches the UI (`src/web/**`, or a server route the UI calls), don't
call it done after `bun test` / `biome` alone — those don't render anything. See
the change in a real browser before calling it done.

How you do that depends on where you're running:

- **Local development** — just open the app yourself (`bun run dev`) and look. No
  screenshots needed; you have a browser.
- **Remote container** (Claude Code on the web) — your own browser can't reach the
  container's `localhost`, so drive the app with headless Chromium and share
  before/after screenshots (on the PR or in the chat). That's the only way to show
  the change actually rendered.

The container has everything the headless path needs: `bun`, `tmux`, the `claude`
CLI, and Playwright's Chromium under `/opt/pw-browsers`. Recipe (uses a scratch
data dir + isolated tmux socket so it touches nothing real):

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
