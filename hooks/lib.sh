# PowderMonkey git-hook helpers — sourced by the hooks, never run directly.
#
# The hooks live in this checked-in hooks/ dir and are wired up by
# `bun run hooks:install` (see scripts/install-hooks.ts). Keeping the shared bits
# here means pre-commit and pre-push agree on how they find bun and biome.

# A section header, to stderr so it stands out in git's own chatter.
pm_say() {
  printf '\033[1;36m▸ %s\033[0m\n' "$*" >&2
}

# A warning / failure line.
pm_warn() {
  printf '\033[1;33m%s\033[0m\n' "$*" >&2
}

# True when bun is on PATH. The hooks bail out gracefully (exit 0) when it isn't,
# so a checkout stays committable in an environment without the toolchain.
pm_has_bun() {
  command -v bun >/dev/null 2>&1
}

# Run biome via the locally installed binary when present (fast, no resolution),
# else fall back to `bun x` (which will fetch @biomejs/biome on demand).
pm_biome() {
  if [ -x node_modules/.bin/biome ]; then
    node_modules/.bin/biome "$@"
  else
    bun x @biomejs/biome "$@"
  fi
}
