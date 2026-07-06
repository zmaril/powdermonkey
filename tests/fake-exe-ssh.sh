#!/bin/sh
# Fake `ssh <vm>.exe.xyz -- <command>` for tests: runs the command locally with
# the fake VM's directory (see fake-exe-lobby.sh) as $HOME and cwd — the same
# contract as real ssh, which joins its arguments and hands them to the remote
# login shell from the home directory. Exit 255 on a missing VM, like ssh's
# connection-failure exit code.
set -e
root="${PM_EXE_FAKE_ROOT:?PM_EXE_FAKE_ROOT not set}"
host="$1"
shift
[ "$1" = "--" ] && shift
name="${host%%.*}"
home="$root/$name"
if [ ! -d "$home" ]; then
  echo "fake ssh: no such vm: $name" >&2
  exit 255
fi
cd "$home"
HOME="$home" exec sh -c "$*"
