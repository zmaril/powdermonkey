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

## Restore

Restore loads a snapshot into a **fresh** store, so **stop the supervisor first** (it
needs the exclusive writer lock, and restore refuses to load into a non-empty store):

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
