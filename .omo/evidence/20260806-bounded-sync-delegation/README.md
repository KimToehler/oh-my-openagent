# bounded-sync-delegation - QA evidence

Plan: `.omo/plans/bounded-sync-delegation.md`
Date: 2026-08-06
Repo: `/Users/tim/git/oh-my-openagent`, branch `dev`, **main checkout, no worktree** (deliberate user override for this local-only change)
Final HEAD under test: `c92d136e2 feat(delegate-task): yield sync tasks to background at wall-clock bound`

This directory is the QA record for the whole change, both halves of it. It is gitignored; the artifacts live on disk only.

---

## What was tested

The plan makes two independent changes to how the `task` delegation tool behaves.

**Option A - text only.** The `run_in_background` guidance previously told the model background delegation was `ONLY for parallel exploration with 5+ independent queries`, and the Atlas agent prompts carried an explicit `NEVER: use run_in_background=true for task execution`. That steering, not the code, was why nearly every delegation ran synchronously. Todos 1 and 2 reworded the tool description, the zod `.describe()`, and all 8 `packages/prompts-core/prompts/atlas/*.md` variants; todo 12 regenerated the JSON schema asset that bakes those strings in.

**Option C - behavior.** A synchronous delegation blocks the parent's turn until the child goes idle, and OpenCode accepts no user input while a tool call is outstanding. The only pre-existing bound was an *inactivity* window that any child activity resets, so a child that is stuck but still chattering blocks forever. Todos 3, 4, 7, 8, 9 and 10 added an absolute wall-clock ceiling (`background_task.syncWallClockTimeoutMs`), and made the bound *hand the still-running child to the BackgroundManager* rather than abort it - so no work is discarded and the parent gets a `bg_...` handle back.

Testing was layered:

| Layer | Todos | Artifact |
|---|---|---|
| Red-to-green unit tests (TDD, mandated for every option C todo) | 3, 7, 8, 9, 10 | `task-3-timing-red-green.txt`, `task-7-plumbing-red-green.txt`, `task-8-adopt-red-green.txt`, `task-9-poller-red-green.txt`, `task-10-yield-red-green.txt` |
| String/asset pinning for the text change | 1, 2, 12 | `task-1-tool-text.txt`, `task-2-atlas-prompts.txt`, `task-12-schema-regen.txt` |
| Read-only concurrency investigation gating the adoption work | 5 | `task-5-atomicity-finding.md` |
| **Real-opencode QA, option A** | 6 | `task-6-option-a-qa.txt`, `task-6-run.jsonl`, `task-6-tool-description.txt` |
| **Real-opencode QA, option C** | 11 | `task-11-option-c-qa.txt`, `task-11-run.jsonl`, `task-11-without-bound.out` (+ `.jsonl`), plus the driver, the fake provider, and per-run provider/session dumps |
| Isolation proof for both real-opencode runs | 6, 11 | `metadata.txt` |

`AGENTS.md` states plainly that "it typechecks" and "`bun test` is green" are **not** QA for anything wired into OpenCode. So both real-surface runs drove a real `opencode run` against a real plugin load, with a hermetic fake model provider and no network call.

Two traps, both found and handled:

1. **`dist/index.js` is stale** (built 2026-08-05, a day before the feature commits; it contains zero occurrences of `wall_clock_yield`, `adoptRunningSession`, or `Sync task moved to background`). Both QA runs therefore load the plugin from source - `file:///.../packages/omo-opencode/src/index.ts` - and each run proves *which* code path executed rather than assuming it.
2. **`script/agent/qa-sandbox.sh` does not sandbox `HOME`.** `omo-config-core/src/loader/paths.ts` resolves the user config layer from `HOME`, not from `XDG_CONFIG_HOME`, so the real `~/.omo/omo.jsonc` would otherwise leak into a "sandboxed" run and route every agent at real models. Both drivers sandbox `HOME` on top of `qa-sandbox.sh` and symlink `$HOME/.opencode/bin` in so the launcher still resolves.

---

## What was observed

### Option A (todo 6)

The `task` tool still executes end to end after the reword, and the **new** wording is what actually reaches the model. That second claim was proven with a recording proxy in front of the fake provider, capturing the tool description exactly as it went over the wire (`task-6-tool-description.txt`), not by reading the source. Real-DB session count before and after: 1204 / 1204, identical.

### Option C (todo 11) - the central claim

A synchronous delegation (`run_in_background: false`) whose child stays continuously busy past a 60 s bound **returns control with a `bg_...` handle, and the child keeps running.**

Making the child genuinely busy was the hard part and is what makes this test honest. The bundled fake provider answers a child in one turn in under a second, so the bound would never trip and the negative control would be byte-identical to the bounded run - which the plan's gate F3 calls an automatic FAIL. A purpose-built provider (`task-11-fake-llm-busy.mjs`) instead answers every child request with another `bash sleep 6` call, 20 times, holding the child busy for ~127 s. Continuous activity is precisely the case the pre-existing inactivity window can never catch, which is the entire reason the wall-clock ceiling exists.

All five required assertions passed:

| # | Assertion | Observed |
|---|---|---|
| 1 | The `task` call returns while the child runs | `.part.state.status == "completed"`, `.part.state.input.run_in_background == false`, output = `Sync task moved to background. / Background Task ID: bg_75870ee5 / ... / Status: still running` |
| 2 | Elapsed tool time is bounded | **60155 ms** against a 60000 ms bound - one poll tick of overshoot. The unbounded control measured **121259 ms** on the identical workload |
| 3 | **The child is still alive - adopted, not aborted** | The child executed **11 more tool calls after** the parent's tool returned (first 262 ms later, continuing 60.6 s), reached natural completion (`CHILD_FINISHED_ALL_TURNS`, turn 21 of 21), and **no abort was issued** on the yield path |
| 4 | Negative control | With the key unset, the `bg_` jq filter returns **nothing**; the parent blocked the child's full `2m 1s` and received the child's **result**, not a handle |
| 5 | Adopted agent not in `DEFAULT_SKIP_AGENTS` | `explore` - not in `["prometheus","compaction","plan"]`, so the continuation enforcer will drive it normally |

The provider's branch timeline shows the divergence at a glance: in the **bounded** run the parent resumed at t+66.8 s with ten child turns still ahead of it; in the **control** run the parent resumed only at t+128.2 s, after the child had finished.

Provenance was determined, not assumed. The string `Sync task moved to background` exists in `sync-task.ts` and **not** in `dist/index.js`; it appears in the run's output tape. Independently, the plugin log emitted `[task] Poll wall-clock timeout reached {"sessionID":"ses_028d9127bffeajZCUMH7XxpQdP","pollCount":60}` - a statement that lives inside the new poller branch and is likewise absent from dist. The run exercised **source**.

Isolation held. Every QA session landed in a sandbox DB (2 sessions per run: one parent, one child). The bounded run's host count moved 1215 → 1217, but both new rows are unrelated concurrent `librarian` sessions in a different repository (`/Users/tim/git/onara`), and all three leak-detection queries - by sandbox directory, by title, by session id - return 0. The control run, which ran alone, shows 1217 → 1217 exactly.

Cleanup was clean in both runs: fake provider dead, port free (`listeners=0`), `opencode run` process gone, `leftover_child_sleep_procs=0`. Neither watchdog fired (420 s bound; actual wall times 166.7 s and 228.1 s).

---

## Why it is enough

**The load-bearing claim of the whole feature is "the parent gets its turn back AND the child survives", and both halves are demonstrated on real OpenCode rather than argued from unit tests.** Elapsed time alone would only show the parent stopped waiting - which an abort also produces - so child survival is proven three independent ways: post-return tool execution recorded in the session DB, natural completion of all 20 scripted turns, and the absence of any abort on the yield path (the `finally` cleanup is guarded by `!yieldedToBackground`, and the abort log line count is 0).

**The negative control rules out the harness as the cause.** Same driver, same provider, same child workload, one config key removed; the runs differ in output kind (handle vs result), elapsed time (60 s vs 121 s), and the moment the parent resumed (t+66.8 s vs t+128.2 s). The two runs are not byte-identical, so gate F3 is satisfied.

**The stale-dist trap is closed by construction, not by trust.** The observed output string and the observed log line are both unreachable from the shipped bundle. Had the run somehow used dist, it would have looked exactly like the negative control - blocking for the full 121 s with no handle - which is unmistakable.

**Unit coverage carries the parts a single end-to-end run cannot.** Red-to-green suites pin the timing symbol's inert `Infinity` default, the config plumbing, `adoptRunningSession`, the poller exit, and the yield path; the `tryCompleteTask` concurrency investigation (todo 5) drove the `completingTaskIds` guard that adoption widens the window for. The end-to-end run proves those pieces compose correctly in a live session, which is the thing unit tests cannot show.

**Both real-surface runs proved isolation with a before/after count plus targeted leak queries**, so nothing here was bought at the cost of the host's session database.

---

## What was omitted

- **Secrets: none present, nothing to redact.** The runs used a hermetic local fake provider with the literal API key string `fake-key`; no real credential, token, or auth header was involved, and no `.env` value is quoted anywhere in this directory. Sandbox paths under `/var/folders/.../T/` are machine-local temp dirs and carry no secret material.
- **Plugin log copies are not included.** Each is ~19 MB and host-wide, spanning unrelated sessions from the whole day. Only the specific lines relied upon are quoted verbatim in `task-11-option-c-qa.txt`.
- **Sandbox SQLite DBs are not committed into this directory** beyond the derived text dumps (`task-11-*-sandbox-sessions.txt`, `task-11-*-tool-parts.txt`). The binary snapshots remain under `/tmp/omo-qa-t11/out/<label>/sandbox-opencode.db`.
- **The 10-minute production default was not exercised end to end.** The bounded run used 60000 ms, the schema minimum, so the run fits in QA time. Worth stating precisely: an *unset* config key does **not** mean `Infinity` at runtime. The timing symbol defaults to `Infinity` (`timing.ts`) so the feature is inert for existing tests, but the plugin wiring supplies its own fallback - `tool-registry-core-tools.ts:68` resolves `?? 600_000`. The negative control is unaffected because the child's ~127 s runtime is an order of magnitude below 600 s, so that ceiling is never approached; the control genuinely behaves as an unbounded sync wait. What was *not* separately measured is a real 600 s expiry.
- **The parent-wake delivery of the adopted child's eventual result was not asserted.** This QA proves adoption (a `bg_` handle, a live child, no abort) and observes the child reaching completion, but does not follow the `<system-reminder>` notification back into the parent. The parent-wake machinery is explicitly out of scope per the plan's guardrails, and the child in this scenario outlived the parent's own turn.
- **The first bounded attempt is retained but not the run of record.** `/tmp/omo-qa-t11/out/bounded` ran without the parent-hold, so the yield fired correctly but `opencode run` exited too fast to sample child liveness afterwards. `bounded2` is the run of record; the earlier directory is kept for transparency.
- **No TUI, server, or SSE surface was exercised**, and no tmux assets were used. Case A (`opencode run --format json`) is the right surface for asserting tool-call behavior; the skill itself notes TUI output assertions are fragile.
- **Nothing was pushed and no PR was opened**, per the plan's guardrails. Work stayed local on `dev`.

---

## Artifact index

| File | Contents |
|---|---|
| `metadata.txt` | Isolation proof for both real-opencode runs: sandbox construction, before/after real-DB session counts, leak queries |
| `task-1-tool-text.txt` | Option A, tool description + `.describe()` reword, red-to-green |
| `task-2-atlas-prompts.txt` | Option A, all 8 Atlas prompt variants, before/after steering dump |
| `task-3-timing-red-green.txt` | `MAX_WALL_CLOCK_MS` inert `Infinity` symbol |
| `task-4-config-schema.txt` | `background_task.syncWallClockTimeoutMs` schema field |
| `task-5-atomicity-finding.md` | `tryCompleteTask()` concurrent-entry investigation (verdict: UNSAFE; drove the `completingTaskIds` guard) |
| `task-6-option-a-qa.txt` | Option A real-opencode QA |
| `task-6-run.jsonl`, `task-6-tool-description.txt` | Option A run tape and the on-the-wire tool description |
| `task-7-plumbing-red-green.txt` | Config value threaded to the poller |
| `task-8-adopt-red-green.txt` | `BackgroundManager.adoptRunningSession()` |
| `task-9-poller-red-green.txt` | Poller wall-clock yield exit |
| `task-10-yield-red-green.txt` | `sync-task.ts` adoption path |
| `task-11-option-c-qa.txt` | **Option C real-opencode QA - the central artifact** |
| `task-11-run.jsonl` | Bounded run, raw JSON tape |
| `task-11-without-bound.out` / `.jsonl` | Negative control |
| `task-11-run-qa.sh`, `task-11-fake-llm-busy.mjs` | The driver and the busy-child fake provider |
| `task-11-{bounded2,nobound}-fake-llm.log` | Provider branch timelines |
| `task-11-{bounded2,nobound}-sandbox-sessions.txt` / `-tool-parts.txt` | Sandbox DB dumps |
| `task-12-schema-regen.txt` | Serialized JSON schema asset regeneration |
| `done-claim.json` | Todo 8 recovery claim |
