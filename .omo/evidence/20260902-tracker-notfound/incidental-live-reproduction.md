# Incidental live reproduction of the defect, on the running harness

Not a constructed probe. This occurred unprompted during the session that wrote the fix,
on the operator's live opencode 1.18.20.

## Which plugin build was actually running (corrected)

An earlier revision of this file claimed the harness was running "the unfixed plugin from
`dev`". That was wrong, and the correction matters for what the reproduction proves.

`~/.config/opencode/opencode.json:149` loads the plugin from
`file:///Users/tim/git/oh-my-openagent` - the MAIN checkout, not this worktree. The session
process started at 11:23:34, while that checkout's `dist/index.js` was rebuilt at 13:51:37,
which is AFTER the exit-clause fix `7918492a8` landed at 13:37:58. A running process holds
the bundle it loaded at startup, so this session is executing a PRE-13:37 build: both the
exit-clause fix and the not-found fix are absent from it, and its bundled tracker still has
the bare-comma terminator plus `notfound` in `TERMINAL_STATUSES`.

That is directly visible in the observations below: job `shell_e3981877d7d77669` replied
`completed, exit 0` and STILL failed to deregister, which the current `dev` code would have
handled. Only a pre-`7918492a8` build behaves that way.

So this reproduces the defect against a build older than `dev`, not against `dev` itself.
The trigger wordings it captures are real harness output and remain valid as trigger
evidence; the run does not speak to `dev`'s current behavior on the exit-clause half.

## What was tested

Three detached `ctx_shell` jobs were started as ordinary work (`bun install`, `bun run
build`, `bun test`) in the worktree. Each was awaited with
`ctx_shell(background_action="wait", ...)` until it returned a terminal line. The turn was
then ended.

## What was observed

1. All three jobs returned terminal from `wait`:
   - `shell_a331139e52724446` -> `completed, exit 0`
   - `shell_e930073f28e4f542` -> `completed, exit 0`
   - `shell_e3981877d7d77669` -> `completed, exit 0`

2. The `<unpolled-background-shell-jobs>` warning fired anyway, naming all three. This is
   the already-characterized gap: `wait` is not a tracked `ctx_shell` observation, so the
   tracker never learned the jobs had finished. (Pinned by `tracker.test.ts`, "keeps a job
   tracked when its result was consumed without a terminal poll".)

3. Clearing them with `background_action="status"` produced these VERBATIM replies:

   ```
   [background:shell_a331139e52724446 not found or expired]
   [background:shell_e930073f28e4f542 not found or expired]
   [background:shell_e3981877d7d77669 completed, exit 0]
   ```

   The first two are the defect's exact trigger wording, drawn from the real harness with
   real job ids, with no test fixture involved.

5. On a later turn the warning fired AGAIN on the same three ids, and clearing them a
   second time with `background_action="cancel"` produced the OTHER trigger wording, the
   em-dash variant:

   ```
   [background:shell_a331139e52724446 not found — already finished or cancelled]
   [background:shell_e930073f28e4f542 not found — already finished or cancelled]
   [background:shell_e3981877d7d77669 completed, exit 0]
   ```

   Both wordings named in the findings entry are therefore observed live in one session.
   The em-dash variant is the one whose status field parses to `null` outright, because
   `—` falls outside the `[a-z _-]` character class.

   The re-fire also confirms the failure is persistent rather than a one-off: the two
   not-found jobs were still tracked after an explicit `status` cleanup had already been
   issued for them.

4. Replaying the observed strings through both the old and the new matcher:

   | job id | parsed status field | OLD clears | NEW clears |
   |---|---|---|---|
   | `shell_a331139e52724446` | `not found or expired` | **false** | true |
   | `shell_e930073f28e4f542` | `not found or expired` | **false** | true |
   | `shell_e3981877d7d77669` | `completed` | true | true |

   Under the shipped code the two not-found jobs do NOT deregister, so the warning re-fires
   on every subsequent idle for jobs that are already gone. Under the fix they clear.

## Why this is enough

It closes the gap the earlier findings entry named as unproven: the trigger wording is
observed on a live harness rather than assumed, and the ids in the reply are the ids that
were polled, which is the precondition the new matcher's anchor depends on. Combined with
the 50-test scoped suite and its mutation runs (remove matcher: 3 red; drop id anchor: 1
red; drop bracket anchor: 3 red), both the trigger and the fix are covered.

It does NOT prove the post-fix behavior end to end inside a live session. The running
harness loads the main checkout's bundle, which as established above is older than both
fixes and is not this branch's `dist/`. Nothing here observes the FIXED code executing in a
live session; rows 3 and 4 of the table are a replay of the observed strings through both
matchers, not a live post-fix run. That end-to-end proof is the separate live probe; see
this directory's other artifacts.

## What was omitted

Nothing redacted. No credentials, tokens, or environment dumps are involved: the captured
output is three bracketed status lines and a test summary. Full logs remain at
`/tmp/wt-install.log`, `/tmp/build-branch.log`, `/tmp/suite-branch.log` (machine-local,
not committed).
