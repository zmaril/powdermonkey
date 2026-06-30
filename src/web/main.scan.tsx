// Dev-only entry point. The production bundle (built from main.tsx by
// `build:web`) never imports react-scan, so the library stays out of what
// ships. This entry is built only by `build:web:scan` — it installs react-scan
// first (before react-dom is pulled in via main.tsx, so the hook is in place
// when the renderer registers), then hands off to the normal app boot.
import "./react-scan.ts";
import "./main.tsx";
