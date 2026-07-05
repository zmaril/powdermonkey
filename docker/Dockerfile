# syntax=docker/dockerfile:1

# PowderMonkey supervisor + web UI, packaged so it can run on an always-on host
# and keep working after you close your laptop. The container IS the server; your
# browser or the Tauri desktop app is the thin client that points at it
# (Settings -> Server).
#
# PowderMonkey has no auth by design, so this image is meant to sit behind
# Tailscale -- see docker-compose.yml, where the tailnet is the security boundary.

FROM oven/bun:1-debian

# tmux + git are hard runtime deps: the supervisor drives tmux on a private socket
# and cuts git worktrees to run work. curl + ca-certificates are for the health
# check and the optional claude install below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git tmux ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so this layer caches across source edits.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source, then build the web bundle into public/assets.
COPY . .
RUN bun run build:web

# --- optional: the Claude Code CLI, needed for cloud dispatch ----------------
# A dispatched task runs `claude --remote`. Without the CLI the plan tree and UI
# still work, but launching a task to the cloud won't. Build with
# `--build-arg INSTALL_CLAUDE=false` to skip it (smaller image, no dispatch).
ARG INSTALL_CLAUDE=true
RUN if [ "$INSTALL_CLAUDE" = "true" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash \
      && ln -sf /root/.local/bin/claude /usr/local/bin/claude ; \
    fi
# -----------------------------------------------------------------------------

# Persistent PGlite plan store (mounted as a volume by compose).
ENV PM_DATA_DIR=/data/pgdata
# git worktrees for running work; kept on the persistent volume so an in-flight
# task survives a container restart.
ENV PM_WORKTREE_DIR=/data/worktrees
# The repo PowderMonkey drives -- mount your project checkout here.
ENV PM_REPO_DIR=/workspace/repo
ENV PORT=4500

EXPOSE 4500

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4500/health || exit 1

# Run the server in the FOREGROUND as PID 1. Do NOT use `powdermonkey serve`:
# that backgrounds the supervisor into tmux and would let PID 1 exit, killing the
# container. Docker's restart policy replaces the tmux auto-restart loop; the
# per-task worker tmux sessions are still created by the server itself.
CMD ["bun", "run", "src/server/index.ts"]
