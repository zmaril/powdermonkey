# Backups, restores & DB upgrades

PowderMonkey's store is embedded PGlite under `data/pgdata/`. This is how you snapshot
it, restore it, and move it across an incompatible PGlite version — all three are the
same primitive: a **logical (row-level) JSON snapshot**.

Why logical, not a file copy: PGlite's own `dumpDataDir()` is a binary tarball tied to
the embedded Postgres version, so it can't cross a PGlite major upgrade (`0.2 → 0.5`
changes the on-disk format). A logical snapshot round-trips through plain SQL, so it is
version-independent — and it's inspectable and diffable (see `src/server/backup.ts`).

## Backup

Goes through the running supervisor (it holds the single writer lock):

```bash
powdermonkey backup                 # → data/backups/pm-backup-<timestamp>.json
powdermonkey backup my-backup.json  # → a path you choose
```

Or hit the endpoint directly: `GET $PM_URL/backup` returns the snapshot as a download.

## Export to a branch or a PR

The same snapshot can go straight into git — no file to shuttle around. This commits
the snapshot from the git object store (a `hash-object → mktree → commit-tree` chain),
so it **never touches your working tree, index, or checked-out branch**:

```bash
powdermonkey backup --branch my-snapshot          # commit to a local branch
powdermonkey backup --branch my-snapshot --push    # …and push it to origin
powdermonkey backup --pr                           # fresh branch + open a PR for it
```

Each export is its own point-in-time archive. `--pr` opens a reviewable pull request
whose one file is `snapshot.json`; the PR body tells you how to restore from it. Under
the hood these go through the running supervisor at `POST $PM_URL/backup/export`.

## Restore / import

Restore loads a snapshot into a **fresh** store, so **stop the supervisor first** (it
needs the exclusive writer lock, and restore refuses to load into a non-empty store).
The source can be a file, a branch, or a PR:

```bash
powdermonkey restore my-backup.json          # from a file
powdermonkey restore --branch my-snapshot    # from a branch (fetched, no checkout)
powdermonkey restore --pr 42                  # from a PR (resolves its head branch)
```

A `--branch`/`--pr` restore reads the snapshot out of git *before* it opens the store
(fetch + `git show`), so it never needs the writer lock just to find the data.

## Full restore, from scratch

The full procedure — stop the supervisor, set the current store aside so the fresh one
can be built, restore, and boot:

```bash
tmux -L powdermonkey kill-session -t pm-server   # stop the supervisor
mv data/pgdata data/pgdata.bak                   # set the current store aside
powdermonkey restore my-backup.json              # builds a fresh store + loads the rows
powdermonkey serve                               # back up
```

Ids, foreign keys, jsonb, and bigint values are preserved; identity sequences are
advanced past the loaded ids so new rows don't collide.

## Upgrading PGlite across a breaking version

A PGlite major bump (e.g. `0.2.x → 0.5.x`) changes the embedded Postgres version, so the
new PGlite **cannot open the old data dir**. Use backup → restore to carry the data over:

```bash
# 1. snapshot the live store on the OLD version
powdermonkey backup pre-upgrade.json

# 2. stop the supervisor and set the old store aside
tmux -L powdermonkey kill-session -t pm-server
mv data/pgdata data/pgdata.pre-upgrade

# 3. bump the dependency and reinstall
#    (edit package.json "@electric-sql/pglite", then:)
bun install

# 4. restore into a fresh store on the NEW version, and boot
powdermonkey restore pre-upgrade.json
powdermonkey serve
```

Keep `data/pgdata.pre-upgrade` until you've confirmed the new store is healthy — it's the
rollback (downgrade the dep, move it back). The restore is verified cross-version by
`tests/backup.test.ts` plus a one-shot check against the target version before shipping.

## Autosync: every change lands in git

The manual backup is a point-in-time snapshot. **Autosync** makes it continuous: on
*every* store change it produces the current snapshot and commits it to **one durable
branch** (appended to, not a PR per change). It's debounced and batched, and runs off
the write path — a change never waits on a snapshot.

It has three modes, set in the Settings pane (Backup sync) or via `POST $PM_URL/settings`:

| mode    | what happens                                                        |
|---------|---------------------------------------------------------------------|
| `off`   | nothing (default — the store is never committed anywhere)           |
| `local` | commit each snapshot to the durable branch **on this machine**      |
| `push`  | …and push that one branch to `origin`                               |

The branch is `powdermonkey-backup` by default (configurable). The Settings pane shows
the live status — last-synced time, the branch, row count, and any error — and
`GET $PM_URL/backup/status` returns the same. Autosync never blocks or fails a write:
a git error is surfaced in the status, not raised at the mutation.

## The paranoid setup

Point autosync at your own repo and every change to the plan lands in git — recoverable
even if the machine and its `data/pgdata` are gone:

1. In **Settings → Backup sync**, choose **Push** (or `curl -X POST $PM_URL/settings -d
   '{"syncMode":"push"}'`). Every change now appends a snapshot commit to the
   `powdermonkey-backup` branch on `origin`. That branch is durable, off to the side, and
   never opened as a PR — it just accumulates history.
2. Watch the status line settle to *last synced … → powdermonkey-backup*. That branch on
   GitHub is now your off-machine copy of the whole plan, updated on every change.
3. To recover on a fresh machine, clone the repo and import the branch into a new store:

   ```bash
   powdermonkey restore --branch powdermonkey-backup
   powdermonkey serve
   ```

That's the whole loop: **push on every change, recover via import.** Because the branch
carries one commit per change, its history is also an audit trail — `git log
powdermonkey-backup` is every state the plan has passed through, and any commit on it
restores cleanly (`powdermonkey restore --branch powdermonkey-backup` reads the tip;
check out an older commit's `snapshot.json` to go further back).
