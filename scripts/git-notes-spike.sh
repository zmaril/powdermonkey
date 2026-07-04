#!/usr/bin/env bash
# Spike: does a git note survive the worker path onto main?
# Two ways to merge a task branch into main: a merge-commit vs a squash.
set -euo pipefail

NOTES_REF="refs/notes/pm"
ROOT="$(mktemp -d)"
echo "sandbox: $ROOT"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

run_case () {          # $1 = label, $2 = merge style (noff|squash)
  local label="$1" style="$2" dir="$ROOT/$2"
  git init -q --bare "$dir/remote.git"
  git clone -q "$dir/remote.git" "$dir/worker"
  cd "$dir/worker"
  echo root > f.txt; git add f.txt; git commit -q -m root
  git push -q origin HEAD:main
  git checkout -q -b pm/task-42
  echo "phase a work" >> f.txt; git add f.txt; git commit -q -m "do phase a"
  git notes --ref=pm add -m '{"v":1,"phases":[137],"followups":[{"title":"dedup date helpers"}]}' HEAD
  local worker_sha; worker_sha=$(git rev-parse HEAD)
  git push -q origin pm/task-42
  git push -q origin "$NOTES_REF"                 # the extra push a worker must do

  # merge into main
  git checkout -q main
  if [ "$style" = noff ]; then
    git merge -q --no-ff pm/task-42 -m "Merge PR (merge-commit)"
  else
    git merge -q --squash pm/task-42; git commit -q -m "Squashed PR (squash)"
  fi
  local main_sha; main_sha=$(git rev-parse HEAD)
  git push -q origin main

  # supervisor: clone fresh, fetch main + notes, walk main reading notes
  git clone -q "$dir/remote.git" "$dir/super"
  cd "$dir/super"
  git fetch -q origin "$NOTES_REF:$NOTES_REF"
  echo "== $label =="
  echo "   worker noted commit: $worker_sha"
  echo "   main head:           $main_sha"
  local found=""
  for sha in $(git rev-list origin/main); do
    if note=$(git notes --ref=pm show "$sha" 2>/dev/null); then
      echo "   NOTE on ${sha:0:12}: $note"; found=1
    fi
  done
  if [ -n "$found" ]; then
    echo "   => note IS reachable walking main  ✅"
  else
    echo "   => note NOT reachable walking main ❌"
    git merge-base --is-ancestor "$worker_sha" origin/main 2>/dev/null \
      && echo "      (noted SHA reachable from main: yes)" \
      || echo "      (noted SHA reachable from main: NO — orphaned; note still lives in $NOTES_REF but off-history)"
    git notes --ref=pm show "$worker_sha" >/dev/null 2>&1 \
      && echo "      (the orphaned note still exists in the notes ref, just not on a main-reachable commit)"
  fi
  echo
}

run_case "CASE A: merge-commit (--no-ff)" noff
run_case "CASE B: squash merge (--squash)" squash
echo "sandbox left at $ROOT"
