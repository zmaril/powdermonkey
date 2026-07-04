# Spike: signal phases/tasks via git notes (Phase 1062)

> Phase 1062 of "Signal phases/tasks via git notes, not commit trailers + PR
> comments". Goal: **prove a git note survives the worker path** — attached in a
> worktree branch, pushed to `refs/notes/pm`, fetched by the supervisor, and
> reachable on `main` after the PR merges — before building the payload/worker/
> supervisor phases on top of it. A spike exists to de-risk; this one found a
> blocker, so it's doing its job.

## TL;DR

**Git notes cannot carry the cloud→supervisor signal. Recommend NOT adopting them.**

Two things had to be true for the plan to work. The spike proved one holds only
under a strict condition, and the other **does not hold at all** for the worker
type that actually needs an out-of-band channel:

1. **Do notes survive the merge onto `main`?** Only under a **merge-commit** merge.
   A **squash** (and a **rebase**) merge rewrites the commit SHA, orphaning the
   note. So notes would *require* the operator to always "Create a merge commit"
   and never squash/rebase.
2. **Can a cloud (`claude --remote`) worker push the notes ref?** **No — HTTP 403.**
   The Claude Code cloud git proxy permits pushing **only `refs/heads/*`
   (branches)**. Pushes to `refs/notes/*` *and* `refs/tags/*` are refused with 403.
   Verified live from inside a cloud session (this one): the branch push succeeds,
   the notes-ref push is blocked.

The irony: notes work exactly where they're **not** needed (a **local** worktree
worker, which pushes with the operator's own credentials — but that worker can
already reach `$PM_URL` directly) and fail exactly where an out-of-band,
GitHub-only channel **is** needed (a **cloud** worker, which can only push a
branch and open a PR). Since cloud/remote is PowderMonkey's primary worker type,
this sinks notes as the carrier.

Reproduce both findings with `scripts/git-notes-spike.sh` (finding 1) and the
transcript below (finding 2).

## Finding 1 — merge strategy: merge-commit required, squash/rebase orphan the note

`scripts/git-notes-spike.sh` builds a bare "remote", a worker clone that commits
on `pm/task-42`, attaches a structured note (`git notes --ref=pm add …`), pushes
the branch **and** `refs/notes/pm`, then merges into `main` two ways and has a
fresh supervisor clone fetch `refs/notes/pm` and walk `git log main` reading the
note off each commit.

```
== CASE A: merge-commit (--no-ff) ==
   NOTE on 96be85f54720: {"v":1,"phases":[137],"followups":[{"title":"dedup date helpers"}]}
   => note IS reachable walking main  ✅

== CASE B: squash merge (--squash) ==
   => note NOT reachable walking main ❌
      (noted SHA reachable from main: NO — orphaned; note still lives in
       refs/notes/pm but off-history)
      (the orphaned note still exists in the notes ref, just not on a
       main-reachable commit)
```

Why: a note is keyed by the **commit SHA** it annotates.

- A **merge-commit** (`git merge --no-ff`, GitHub "Create a merge commit") keeps
  the worker's original commits reachable from `main`, so their notes are reachable
  once the supervisor fetches `refs/notes/pm`.
- A **squash** ("Squash and merge") replays the change as a **brand-new commit with
  a new SHA**; the original noted commit is no longer an ancestor of `main`, so a
  `git log main` walk never visits it. The note isn't deleted — it's orphaned in
  `refs/notes/pm` on an off-history SHA, invisible to reconciliation.
- A **rebase merge** ("Rebase and merge") likewise rewrites every commit SHA, so it
  orphans notes for the same reason (same mechanism as squash; not scripted, but it
  follows directly).

**Contrast with today's commit trailers:** a `PM-Phase:` trailer lives in the
commit *message*, and GitHub's squash concatenates the squashed commits' messages
into the squash commit body — so **trailers survive a squash**, while notes do not.
Trailers are strictly more robust to merge strategy than notes.

## Finding 2 (the blocker) — a cloud worker cannot push a notes ref

Attaching and pushing a note is step 2 of the worker path. Run live from inside
this cloud session against the real origin (through the Claude Code git proxy):

```
$ git notes --ref=pm-spike add -f -m '{"v":1,"phases":[1062]}' HEAD   # local: fine
$ git push origin refs/notes/pm-spike
error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403
fatal: the remote end hung up unexpectedly
notes-push EXIT: 1

$ git push -u origin claude/git-notes-phase-tracking-lyzel0            # control: a branch
 * [new branch]  claude/git-notes-phase-tracking-lyzel0 -> …           # succeeds, EXIT 0

$ git push origin refs/tags/pm-spike-tag                               # a tag, for contrast
error: RPC failed; HTTP 403 …                                          # also 403
```

The proxy allows **`refs/heads/*` only**. `refs/notes/*` and `refs/tags/*` both
403. Per the environment's own proxy docs a 403 is an org egress-policy denial to
"report, not route around" — so there is no supported way for a cloud worker to get
a notes ref to the remote. The supervisor could fetch `refs/notes/pm` if it were
there, but the cloud worker can never put it there.

A **local** worktree worker *can* push notes (it uses the operator's own git auth,
not the cloud proxy) — but a local worker already talks to `$PM_URL` directly
(that's the local `/followups` channel and, for progress, its branch merges to
`main` the same as any other). It has no need for a git-carried side channel. So
notes buy nothing for local and are impossible for cloud.

## Recommendation

**Do not adopt git notes.** They fail the spike's central requirement for the
primary worker type. Two paths preserve the *actual* goal — one structured JSON
payload (phases done / task done / follow-ups) replacing the scattered
`PM-Phase:` / `PM-Task:` trailers **and** the `<!-- pm:followup -->` PR comments:

- **Option A — keep the current mechanism** (`PM-Phase:` / `PM-Task:` trailers +
  `pm:followup` PR comments). It works today, survives squash, and needs no cloud
  push privileges we don't have. Cost: the payload stays split across two channels;
  the unification the task wanted doesn't happen. Close 1063–1066 as won't-do.

- **Option B — one structured block in the *commit message*** (a `PM:` JSON trailer,
  or a fenced <code>```pm</code> block, carrying `{ phases, task, followups }` on the
  commit that completes the work). This gets the whole win the notes idea was
  after — a single structured payload replacing both trailers and follow-up
  comments — while **surviving squash** (it's in the message) *and* the **cloud
  proxy** (it rides the branch push, no extra ref). Bonus: `github-watch` already
  pulls each PR's commit `messageBody` via GraphQL, so the supervisor can read a
  follow-up out of an **open** PR's commits with no new fetch — same early-triage
  timing as the PR-comment channel today. Reconcile keeps reading the same block off
  `main`. Phases 1063–1066 re-target from "git note" to "commit-message block", but
  the shape of the work (payload schema, worker emits it, supervisor reads it,
  trailers stay as legacy fallback) is otherwise intact.

This is an architecture call for the operator, so it's posted as a question on the
PR thread rather than decided here. The remaining phases are on hold pending that
call.
