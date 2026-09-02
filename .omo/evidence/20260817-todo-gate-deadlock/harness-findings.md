# Harness findings - discovered while driving todo #9 QA (2026-08-17)

Context: two consecutive subagent lanes failed to drive an isolated opencode session for
todo #9 of `.omo/plans/background-agent-todo-gate-deadlock.md`. Both concluded the QA
environment was broken. Root diagnosed the environment directly and proved it is NOT.
These are the real findings, in priority order. Each is a candidate for its own future commit.

---

## F-A. `ctx_execute` kills processes it spawns, including detached ones (BUG, high impact)

**Observed:** lane 1 launched its QA runner from `lean-ctx ctx_execute`. The mock model
started and printed `MOCK_LISTENING 57512`, then the whole runner vanished. Its
`parent-run.jsonl` stayed zero bytes. The lane's own note:

```
Runner killed when `ctx_execute` hard-timed out at 2s. Process did not survive detachment.
```

**Why it misleads:** the visible symptom is "`opencode run` produced zero bytes", which
points the investigator at opencode, the plugin, or credentials. The actual cause is the
tool killing its own process group. Lane 2 inherited that misdiagnosis and spent its whole
budget on it, reporting the environment as unusable.

**Impact:** any long-lived QA driver, server, or watcher launched from `ctx_execute` dies
silently after about 2 seconds. Backgrounding inside the call does not save it.

**Suggested fix:** either detach spawned children from the call's process group
(`setsid` / `spawn` with `detached: true` and an unref'd stdio), or fail loudly when a
command tries to background, or document the kill semantics in the tool description.
Today the tool description says nothing about spawned children being reaped.

**Workaround that works:** launch from `ctx_shell` with
`nohup <cmd> > /tmp/x.log 2>&1 & disown`, then poll the log from separate later calls.

---

## F-B. Plugin log is NOT isolated by the XDG sandbox (BUG, correctness risk for all QA)

**Observed:** the plugin logger writes to `os.tmpdir()/oh-my-opencode.log`, a path that
`XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` do NOT redirect.
During root's probe the shared file was 13543536 bytes and being appended to by the live
parent session at the same moment.

**Why it matters:** the documented QA recipe for reading plugin logs is to clear the log,
drive a session, then read it back. Lane 1's runner did exactly that:

```
rm -f "${TMPDIR:-/tmp}/oh-my-opencode.log" ...
```

That deletes the log the *parent* opencode session is actively writing to, and any log
line the QA then reads may belong to a different concurrent session. So the isolation
proof the repo requires (unchanged session counts in the real DB) can pass while the log
evidence is still cross-contaminated.

**Impact:** log-derived QA evidence is racy whenever another opencode process is running,
which is the normal case when an agent is driving the QA. This weakens exactly the
evidence `AGENTS.md` demands.

**Suggested fix:** honour an env override for the log path (for example
`OMO_LOG_DIR` or deriving from `XDG_STATE_HOME`) so a sandboxed run gets its own file.
Then update the `opencode-qa` skill to set it and to stop deleting a shared path.

---

## F-C. `ctx_shell` write-guard false-positives on relative redirects into temp dirs (PAPERCUT)

**Observed:** this command was rejected:

```
cd "$ROOT"; opencode run 'say hi' --format json > out.json 2>err.txt
```

with

```
ERROR: ctx_shell detected a file-write command (shell redirect > or >>).
... Output capture to temp paths (/tmp, /var/tmp, $TMPDIR) is allowed.
```

`$ROOT` was a `mktemp -d` directory under `$TMPDIR`, so the write WAS to an allowed
location. The guard cannot resolve a relative redirect target after a `cd`, so it blocks it.

**Impact:** minor but real friction for QA scripts, which naturally `cd` into a sandbox and
write relative paths. Forces every redirect to be spelled as an absolute `/tmp/...` path.

**Suggested fix:** resolve the redirect target against the command's effective working
directory before deciding, or allow relative targets when the command contains a `cd` into
an allowed prefix.

---

## F-D. Subagents can type "BLOCKED" instead of calling `report_blocked`, and then hang forever (BEHAVIOR)

**Observed:** lane 1 wrote the word `BLOCKED` in its message text but never invoked the
`report_blocked` tool. The task stayed `running` for 47 minutes with no notification, no
evidence file, and no live process. Last real tool activity was at 01:15; discovery was at
01:58.

**Why status alone did not reveal it:** `background_output` reported
`Status: running, Last tool: lean-ctx_ctx_execute`. Wall-clock duration kept climbing while
the last-tool field never advanced. Liveness had to be inferred by comparing the last
activity timestamp against the clock, and by checking `ps` for the processes the lane
claimed to be running.

**Impact:** a silent 43-minute stall that only a human noticing "this is taking too long"
surfaced. Lane 2, correctly, DID call `report_blocked` and was handled in under 2 minutes.

**Suggested fix:** detect a final assistant message that announces blockage without a
matching `report_blocked` call and either convert it or emit a warning to the parent.
Cheap heuristic, high value.

---

## F-E. The QA path itself is HEALTHY (negative finding, proven)

Both lanes concluded the environment was unusable. That conclusion is wrong, and this
section is the disproof so no future lane re-litigates it.

| Probe | Result |
| --- | --- |
| `opencode --version` | 1.18.15 at `/opt/homebrew/bin/opencode` |
| bare `opencode run` in XDG sandbox | reaches a real provider, fails only on credentials (`Personal Access Tokens are not supported for this endpoint`), which is exactly what the mock model exists to avoid |
| `mock-model-selftest.mjs` | SELF-TEST PASS, 20 assertions |
| `opencode run` against the mock provider | `RUN_EXIT=0`, real streamed JSON, 4 requests served by the mock |
| same, plus `plugin: ["file://.worktrees/todo-gate-qa/dist/index.js"]` | `RUN_EXIT=0`, real streamed JSON, plugin log written |

So: mock model works, plugin loads from a `file://` bundle, and a sandboxed
`opencode run` completes. The blocker was F-A, not the harness.

The dirty-file objection lane 2 raised is also a non-issue: the only modified file in the
pinned worktrees is `packages/omo-senpi/plugin/extensions/omo-task.js`, a senpi extension
that is not part of the opencode bundle under test, and it is identical in both the stock
and patched worktrees, so it cannot bias a BEFORE/AFTER comparison.

---

## Verified-good recipe (use this, it is proven end to end)

1. Start the mock from `ctx_shell`, detached, and wait for `MOCK_LISTENING <port>`.
2. Write `$XDG_CONFIG_HOME/opencode/opencode.json` with both the `plugin` array pointing at
   the built `dist/index.js` and a `mock` provider on `http://127.0.0.1:<port>/v1`.
3. Drive with `opencode run '<prompt>' --model mock/mock-model --format json`.
4. Anything long-lived goes through `nohup ... & disown` from `ctx_shell`, polled by a
   bounded loop in later calls. Never `ctx_execute`.

Bundle distinctness for this plan's BEFORE/AFTER, already verified:
stock `todo-gate grace expired` = 0 and `todoGateGraceMs` = 0;
patched = 1 and 8 respectively.
