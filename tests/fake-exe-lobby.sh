#!/bin/sh
# Fake exe.dev lobby (`ssh exe.dev <cmd>`) for tests: VMs are plain directories
# under $PM_EXE_FAKE_ROOT, so `new`/`ls`/`rm` are mkdir/ls/rm — no network, no
# account. Paired with fake-exe-ssh.sh, which "connects" to those directories.
set -e
root="${PM_EXE_FAKE_ROOT:?PM_EXE_FAKE_ROOT not set}"
mkdir -p "$root"
cmd="$1"
shift 2>/dev/null || true

case "$cmd" in
  new)
    n=$(ls "$root" | wc -l)
    name="fakevm$((n + 1))"
    mkdir "$root/$name"
    # Banner noise on purpose: the parser must cope with non-JSON lines.
    echo "Welcome to fake exe.dev"
    echo "{\"name\": \"$name\", \"status\": \"running\"}"
    ;;
  ls)
    printf '['
    first=1
    for d in "$root"/*/; do
      [ -d "$d" ] || continue
      [ "$first" = 1 ] || printf ','
      printf '{"name":"%s"}' "$(basename "$d")"
      first=0
    done
    printf ']\n'
    ;;
  rm)
    name="$1"
    if [ ! -d "$root/$name" ]; then
      echo "vm not found: $name" >&2
      exit 1
    fi
    rm -rf "${root:?}/${name:?}"
    ;;
  *)
    echo "fake lobby: unknown command: $cmd" >&2
    exit 2
    ;;
esac
