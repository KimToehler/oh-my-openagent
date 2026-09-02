# Todo 1 - self-abort runtime probe

## WHAT WAS TESTED

Worktree: `/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report` at `6417390ed`.

Real harness command sequence, run from worktree:

```sh
source script/agent/qa-sandbox.sh
opencode serve --port 51378 --hostname 127.0.0.1 --print-logs
curl -sN -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:51378/global/event
curl -X POST -u opencode:$OPENCODE_SERVER_PASSWORD \
  -H 'content-type: application/json' \
  -d '{"model":{"providerID":"openai","modelID":"gpt-fake"},"parts":[{"type":"text","text":"SELF_ABORT_SUCCESS"}]}' \
  'http://127.0.0.1:51378/session/<parent>/prompt_async?directory=/Users/tim/git/oh-my-openagent/.worktrees/subagent-blocked-report'
```

Repeated with `SELF_ABORT_FAILURE`. Isolated XDG values came from `script/agent/qa-sandbox.sh`. Local fake OpenAI Responses server drove a real OpenCode `task` call intended to create child, then child `probe_self_abort` temporary tool. Probe tool was deleted afterwards.

Temporary child tool intended exact code:

```ts
const task = manager.findBySession(context.sessionID)
await manager.cancelTask(task.id, {
  source: "probe",
  reason: "probe blocked text",
  abortSession: true,
  skipNotification: false,
})
```

Failure mode additionally replaced in-memory child `client.session.abort` with throwing `PROBE_FORCED_ABORT_FAILURE`, then attempted second cancellation and recorded private `completingTaskIds` membership. Temporary production-adjacent changes were removed before finish.

Isolation count commands:

```sh
sqlite3 'file:/Users/tim/.local/share/opencode/opencode.db?mode=ro' 'SELECT count(*) FROM session;'
```

## WHAT WAS OBSERVED

### Raw isolation output

Before:

```text
1631
```

After:

```text
1631
```

No host OpenCode session was created.

### Raw server health output

```json
{"healthy":true,"version":"1.18.15"}
```

### Raw prompt submission output

```text
SUCCESS ses_018e9c7fcffer2yIHFWnfzzXew
204
FAILURE ses_018e998e6ffeHG9CZyHB9Q2vkj
204
```

### (a) Parent wake notification

**INCONCLUSIVE.** Exact child sequence never began. Raw fake-provider and SSE output proves OpenCode started parent tool `task`, but tool was interrupted before creating child. No child session, no `probe_self_abort` entry, no `[BACKGROUND TASK ...]` parent wake, and no parent wake body reached wire.

Raw SSE success-path tool result:

```json
{"type":"tool","tool":"task","callID":"c2","state":{"status":"error","input":{},"raw":"","error":"Tool execution aborted","metadata":{"interrupted":true},"time":{"start":1786288424141,"end":1786288424141}}}
```

Raw installed OpenCode log:

```text
timestamp=2026-08-09T15:13:44.143Z level=WARN run=84c23c5f message="loop exit with orphaned interrupted tool" session.id=ses_018e9c7fcffer2yIHFWnfzzXew messageID=msg_fe71639140010Qph6DwUiRFUnN tool=task callID=c2
```

### (b) In-flight tool result after child abort

**INCONCLUSIVE for requested child self-abort.** Child tool never ran. Closest real observed result: OpenCode marked parent `task` tool error `Tool execution aborted` and exited loop with `orphaned interrupted tool`; it did not hang during 12-second observation.

Raw failure scenario equivalent:

```json
{"type":"tool","tool":"task","callID":"c4","state":{"status":"error","input":{},"raw":"","error":"Tool execution aborted","metadata":{"interrupted":true},"time":{"start":1786288433416,"end":1786288433416}}}
```

```text
timestamp=2026-08-09T15:13:53.419Z level=WARN run=84c23c5f message="loop exit with orphaned interrupted tool" session.id=ses_018e998e6ffeHG9CZyHB9Q2vkj messageID=msg_fe71667610010UP8mPtPzi0Vxl tool=task callID=c4
```

### (c) `task.error` in parent notification body

**INCONCLUSIVE.** No child task existed and no parent notification dispatched. `probe blocked text` cannot be observed in notification body.

Raw probe output:

```text
cat: /tmp/omo-self-abort-persistent2/probe.log: No such file or directory
```

This is expected only insofar as temporary child tool was never invoked; it is evidence against claiming test execution.

### (d) `completingTaskIds` clear on success and abort failure

**INCONCLUSIVE.** Neither exact success nor forced abort-failure entered `cancelTask`; neither emitted probe records. No claim made about cleanup or permanent uncancellability.

### Raw request evidence: model attempted parent `task`, not child probe

```text
SELF_ABORT_FAILURE
SELF_ABORT_FAILURE
"name":"task"
```

SSE showed parent tool input remained empty:

```json
{"type":"tool","tool":"task","callID":"c4","state":{"status":"pending","input":{},"raw":""}}
```

## WHY IT IS ENOUGH

This establishes only harness facts: real OpenCode `1.18.15` ran in isolated XDG sandbox, SSE streamed live server events, prompt route accepted both cases, and host DB remained unchanged. It does **not** settle Todo 1 decisive mechanism because OpenCode interrupted parent `task` before child creation. Therefore hard gate remains closed. Do not implement Todos 2-12 from this evidence.

Re-plan runtime probe harness: make real background child creation deterministic before testing child tool execution, then rerun exact `findBySession()` plus `cancelTask(... abortSession: true, skipNotification: false)` sequence.

## WHAT WAS OMITTED

- Fake-provider request bodies omitted because they include full generated system prompts and tool catalog, not needed for verdict.
- `OPENCODE_SERVER_PASSWORD`, sandbox paths, auth headers, provider `apiKey` were not copied.
- Temporary source probe, fake server script, isolated XDG root, server PIDs, and captured `/tmp` artifacts were deleted after extracting above raw output.

### Teardown receipt

```text
lsof -nP -iTCP:51377 -sTCP:LISTEN
# no output
lsof -nP -iTCP:51378 -sTCP:LISTEN
# no output
ps ax -o pid=,command= | rg 'omo-self-abort|opencode serve --port 5137'
# no matching spawned OpenCode/fake-provider process; command process and rg itself excluded
```

`tmux ls` after probe:

```text
main: 1 windows (created Fri Aug  7 16:34:34 2026)
read-file: 1 windows (created Fri Aug  7 16:31:40 2026)
```

Those sessions pre-existed probe. Probe spawned none.

## ATTEMPT 2

### Method and level

**OPTION 3, SEAM-LEVEL.** Time-boxed direct real-server construction could not improve Q-A because manager state is process-local. Rather than repeat model-driven child creation, a temporary Bun script constructed the real `BackgroundManager` from current worktree source. It used the real `cancelTask()` implementation, its real `abortWithTimeout()` path, real `ParentWakeNotifier`, notification template, notification queue, and prompt-dispatch path. Client transport was faithful in-process fake: `session.abort()` recorded child abort and resolved, while `session.promptAsync()` captured exact parent prompt. This proves manager seam only, not live OpenCode session delivery.

No production file was changed. Temporary `/tmp/attempt2-self-abort.ts` was deleted.

### Exact temporary probe invocation

```ts
const task = manager.findBySession("child-session")
await manager.cancelTask(task.id, {
  source: "probe",
  reason: "probe blocked text",
  abortSession: true,
  skipNotification: false,
})
```

Forced failure replaced `client.session.abort` with an async throw, then invoked cancellation twice, once with abort enabled and once with `abortSession: false`.

### Raw output: success path

```text
CHILD_TOOL_ENTERED
FIND_BY_SESSION=child-task
SUCCESS_RESULT=true
CHILD_ABORTED=child-session
TASK_STATUS=cancelled
TASK_ERROR=probe blocked text
CHILD_TOOL_RESULT=SWALLOWED_BY_ABORTED_SESSION
PARENT_WAKE=parent-session:<system-reminder>
[ALL BACKGROUND TASKS FINISHED - 1 FAILED]

**Failed:**
- `child-task`: child probe | session: `child-session` [CANCELLED] - probe blocked text

All sibling background tasks are complete. Your next action should be to call `background_output(task_id="<id>")` for each task ID above. If a task ID returns not-found, fall back to `session_read(session_id="<session>")` using the session id on that task's line.

**ACTION REQUIRED:** 1 task(s) failed. Check errors above and decide whether to retry or proceed.
</system-reminder>
<!-- OMO_INTERNAL_INITIATOR -->
SUCCESS_COMPLETING=false
```

### Raw output: forced abort-failure path

```text
FAILURE_RESULT=false
FAILURE_STATUS=running
FAILURE_COMPLETING=false
FAILURE_RETRY=true
```

### Answers

(a) **YES at manager seam.** `cancelTask()` completed child abort and emitted parent wake through captured `session.promptAsync()`. Not harness-level: transport fake does not prove OpenCode wire dispatch survives actual session teardown.

(b) **YES, seam-level swallowed.** Simulated still-running child tool context did not receive a normal result after own abort. This is modelled observation, not real agent-loop observation.

(c) **YES, seam-level.** `TASK_ERROR=probe blocked text`; same text survives in parent notification: `[CANCELLED] - probe blocked text`.

(d) **YES, seam-level.** `SUCCESS_COMPLETING=false`; forced abort failure returned false, task remained running, `FAILURE_COMPLETING=false`, and second cancellation returned `FAILURE_RETRY=true`. No permanent uncancellability at tested branch.

### Isolation note

Attempt 2 did **not** spawn OpenCode or create a session. It therefore did not write the host DB. Current read-only host count after attempt was `1633`, while Attempt 1's recorded before/after pair was `1631/1631`. This later change cannot be attributed to Attempt 2 because its script made no SQLite or HTTP session-create call. Do not use `1633` as an isolation proof; only Attempt 1 has before/after isolation proof.

### Teardown receipt

```text
temporary-script=deleted
lsof -nP -iTCP:51377 -sTCP:LISTEN
# no output
lsof -nP -iTCP:51378 -sTCP:LISTEN
# no output
lsof -nP -iTCP:51379 -sTCP:LISTEN
# no output
ps ax -o pid=,command= | rg '[o]pencode serve --port 5137|[a]ttempt2-self-abort'
# no matching spawned process
```

`tmux ls` showed only pre-existing sessions:

```text
main: 1 windows (created Fri Aug  7 16:34:34 2026)
read-file: 1 windows (created Fri Aug  7 16:31:40 2026)
```
