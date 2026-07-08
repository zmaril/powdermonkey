# .githooks

Committed git hooks that run this repo's full CI gate locally, before a commit
lands — so failures surface here instead of after a push.

## Activate

Hooks are not enabled automatically on clone. Run once per checkout:

```sh
git config core.hooksPath .githooks
```

## What runs

Together the hooks mirror CI. The gate is split across two hooks: the test
suite shells out to `git worktree add`, which fails while a commit holds
`.git/index.lock`, so the heavy legs run at push time instead.

`pre-commit` (fast, git-safe):

- `bun run check`
- `bun run typecheck`
- `run-straitjacket` — see below

`pre-push` (heavy):

- `bun run test` (each test file in its own process)
- `bun run build:compile`

`commit-msg` enforces Conventional Commits on the subject line.

## run-straitjacket

Runs straitjacket at the exact version this repo pins in CI, read from
`.github/workflows/straitjacket.yml`. The released binary is cached per version
under `$XDG_CACHE_HOME/straitjacket/<version>/`, so the download happens once.
It passes no path argument, so the scan honors `.straitjacket.yaml` (scoped to
`src/`) exactly as CI does. This keeps local results identical to CI regardless
of any globally installed straitjacket. Bump the workflow pin and the hook
follows.

## Bypass

`git commit --no-verify` skips the hooks for a single commit.
