# Superseded: lock-era evidence

Two evidence directories in this folder describe a lockfile subsystem that no longer
exists in the shipped design. They are retained because this repo keeps corrected
artifacts so the change stays auditable. Read them as history, not as a description
of current behavior.

## What was removed

`withLessonStoreLock` and everything that served it (mtime staleness threshold,
rename-to-quarantine reclamation, pid-liveness probing, token read-back, the
`Atomics.wait` backoff, and the `findLessonByHash` directory scan) were deleted in
`c9eab0182`, with the tool-side call site removed in `e843c3831`.

The lock was added during review to close a dedup race, then produced critical
defects in three consecutive review rounds: no stale recovery meant a crashed holder
bricked the tool permanently; stale reclamation stole live locks so two processes
entered the critical section; and the pid-liveness guard added to stop that created a
lock that could never be reclaimed. A design review concluded that an advisory
userland lockfile cannot distinguish an abandoned holder from a slow one without
kernel help, and that the synchronous `Atomics.wait` backoff blocked the shared
OpenCode server event loop. The plan's original fork F6 ("no lockfile") was correct.

## What replaced it

Dedup is now race-free by construction. The filename is derived from the semantic
content hash, so two concurrent identical callers target the same path, one wins the
exclusive create, and the loser returns a duplicate no-op. Publication is atomic: the
content is written to a temp file and hard-linked onto the target, so the target is
never observable in a partially written state.

## Affected directories

- `20260813-record-lesson-lock/` describes the lock's stale-recovery behavior in
  full. The subsystem it tests is gone.
- `20260813-record-lesson-residual-risk/` is still valid for its concurrency, cap,
  input-robustness, and hostile-input lanes. Its L1 through L5 lock lane, its
  starvation analysis, and any transcript showing `lesson store lock is busy after 6
  attempts` describe removed behavior.
- `20260810-record-lesson-tool/` remains valid for the read-path and isolation
  proofs. Its recorded artifact filenames use the old date-prefixed scheme
  (`<YYYYMMDD>-<slug>-<6hex>.md`), which the current build cannot generate; the
  shipped scheme is `<slug>-<16hexhash>.md`.

Current-design evidence lives in the dated directory written after `c9eab0182`.
