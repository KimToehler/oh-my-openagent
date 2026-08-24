# QA result: resume adopt-on-miss fallback

## WHAT WAS TESTED

1. Harness readiness: `bash .agents/skills/opencode-qa/scripts/lib/common.sh --self-check` passed. Output: `01-harness-self-check.txt`.
2. Current bundle: `bun run build` completed. `dist/index.js` mtime is newer than all four requested source files. Output: `02-build-freshness.txt`.
3. Isolation baseline: `sqlite3 "$(opencode db path)" "SELECT count(*) FROM session"` returned `2660` before any attempted spawned QA. Output: `03-real-db-count-before.txt`.
4. Required topology capability review, after reading `opencode-qa` skill plus `references/events-hooks.md` and `references/server-api.md`:
   - isolated `opencode serve` is supported;
   - separate attached client is supported by `opencode run --attach` and SDK `createOpencodeClient({ baseUrl })`;
   - server API can create sessions, submit prompts, list children, read messages, and observe SSE;
   - no documented HTTP, SDK, or existing executable harness operation invokes local OMO native `task` with `task_id: "ses_..."` from a separate client process.
   Output: `04-topology-capability-gap.txt`.

## WHAT WAS OBSERVED

- Build freshness: `dist/index.js` mtime `1787600779` is later than each requested source mtime `1787600528`.
- Real host DB count before probe: `2660`.
- Required two-process topology cannot be driven with current harness. External attachment reaches OpenCode session prompting, not OMO `task` continuation. `POST /session/:id/prompt_async` would add ordinary child-session input and bypass `BackgroundManager.resume()`.
- No fake provider, isolated server, client/host, tmux asset, temporary QA directory, or port was spawned by this blocked run. Therefore no retained `ses_...`, survival proof, post-restart transcript, active-session control pair, or absent-session runtime error exists.
- Existing `opencode serve` listeners were detected during preflight on ports `64855` and `64833`. They were not created, used, or stopped by this QA.

Verdicts:

- HAPPY: BLOCKED. Deciding observable: no external route exists to invoke OMO native `task(task_id="ses_...")` after client restart.
- REFUSAL: BLOCKED. Deciding observable: active-session refusal also requires same unavailable native `task` invocation; no control pair can reach guard honestly.
- ABSENT: BLOCKED. Deciding observable: absent-session restart error requires same unavailable native `task` invocation.

## WHY IT IS ENOUGH

This report does not claim end-to-end proof. Required topology has strict requirement: separate first and second plugin client/host processes, same server-owned child session, native OMO continuation after first manager exits. Current public server API exposes raw session prompts only. Raw prompt continuation does not exercise `BackgroundManager.resume()` and is explicitly rejected as substitute by task instructions.

Missing capability: supported executable client/host driver able to invoke OMO registry tool `task` directly with controlled arguments, capture its `taskId`, terminate first manager host without server termination, then start fresh manager host and invoke `task({ task_id })` against same OpenCode server.

## WHAT WAS OMITTED

- No credentials, tokens, or authorization headers recorded.
- No fake provider/server/client logs exist because topology was not started.
- No cleanup command ran against pre-existing listeners, preventing unrelated process disruption.
- No product source changed.

## CORRECTED TOPOLOGY RUN (server restart)

### WHAT WAS TESTED

1. Fresh bundle build and freshness comparison: `bun run build`; `dist/index.js` is newer than all four requested changed source files. Capture: `02-build-freshness.txt`.
2. Strict sandbox setup: `script/agent/qa-sandbox.sh` conventions via `oqa_mk_isolated_xdg`, canonical project path from `realpathSync`, local OpenAI-compatible mock provider, local `dist/index.js` plugin bundle, password-protected `opencode serve`. First server PID, sandbox path, canonical project root, parent session, and attempted child ID: `08-topology-and-spawn.txt`.
3. Correct orphaning action: first `opencode serve` PID was killed. Capture: `10-server1-death.txt`.
4. Restart path: fresh server started against same sandbox DB and canonical project root. Sandbox session-row lookup before and after restart: `09-child-pre-restart-sandbox-row.txt`, `11-child-survives-restart.txt`.
5. Model-side continuation and absent-session probes: `12-post-restart-child-transcript.json`, `13-absent-response.json`.
6. Cleanup and host DB isolation: `15-cleanup-receipt.txt`, `16-host-db-after-corrected-run.txt`.

### WHAT WAS OBSERVED

- Build freshness passed. `dist/index.js` mtime `1787602092799053387` exceeded all requested source mtimes. `02-build-freshness.txt` records full comparison.
- Host DB count before corrected run was `2661`; after cleanup was `2661`. The isolated run did not write host DB.
- First server death passed: `10-server1-death.txt` records `PASS server1 78746 gone`.
- Mock-provider model-side spawn did **not** yield a real child session. Capture regex selected fixture-looking `ses_def456` from mock request content instead of a server-minted child ID. Both sandbox DB row queries are empty: `09-...` and `11-...`.
- Therefore no persisted child existed for restart adoption. `12-post-restart-child-transcript.json` is server error `Session not found: ses_def456`, not happy-path proof.
- ABSENT probe did not reach fallback. `13-absent-response.json` contains mock `PARENT_FINAL`, proving scripted `ABSENT_MARKER` tool turn was not selected after earlier turn mismatch.
- REFUSAL has no valid active-session control pair. `14-refusal-control-gap.txt` records missing deterministic active-child capability. This run also cannot use a negative-only assertion.
- Initial cleanup command exposed two server descendants and sandbox removal failure. Manual cleanup killed both remaining `opencode serve` processes, verified no `opencode serve` or `mock-model.mjs` remained, removed sandbox, and host DB count stayed `2661`. This manual receipt must be treated as final cleanup evidence; stale `15-cleanup-receipt.txt` is failed intermediate evidence, not success proof.

Verdicts:

- HAPPY: BLOCKED. Deciding observable: no server-minted child `ses_...` was captured or found in sandbox DB, so post-restart `resume()` adoption was never invoked.
- REFUSAL: BLOCKED. Deciding observable: no deterministic active-child positive control exists; negative-only probe prohibited.
- ABSENT: BLOCKED. Deciding observable: `ABSENT_MARKER` did not execute `task`, so restart-specific `session_read` error was not observed.

### WHY IT IS ENOUGH

Run proves corrected topology mechanics up to killing real server process and preserving strict host DB isolation. It does not prove product behavior. Mock script capture matched an instruction/schema fixture ID before server returned a real `task_id`, so model-side spawn cannot deterministically supply required child identity. No weaker HTTP prompt substitute was used because it bypasses `BackgroundManager.resume()`.

### WHAT WAS OMITTED

- No product source changed.
- No credentials, tokens, password, or authorization headers recorded.
- No fabricated happy-path transcript, active-session control, or absent-session error claimed.
- Temporary QA runner lived in `/tmp` and was removed with sandbox cleanup; it is not product or evidence source.

## ATTEMPT 4 (execution run)

### WHAT WAS TESTED

- Ran `bash .agents/skills/opencode-qa/scripts/resume-adopt-restart-probe.sh --evidence-dir .omo/evidence/20260824-resume-adopt-fallback`.
- Used isolated XDG state, canonicalized sandbox project path, local fake OpenAI server, local `dist/index.js`, then killed and restarted real `opencode serve` against same sandbox state.
- Spawned child from model-side `task` call. Child ID came from sandbox DB and passed shape plus row assertions.

### WHAT WAS OBSERVED

- Host session count: `2661` before and `2661` after. Captures: `19-host-session-count-before.txt`, `31-host-session-count-after.txt`.
- Server-minted child persisted across restart. Captures: `23-child-id.txt`, `24-child-row.txt`, `26-server-killed.txt`, `27-child-survived-restart.txt`.
- HAPPY did not produce new child transcript turn: pre-restart message count `2`, post-restart `2`. Capture: `28-happy-counts.txt`.
- REFUSAL and ABSENT model controls were issued but no dedicated control assertion was reached. Capture: `29-scenarios.txt`.
- Cleanup receipt records spawned server and fake-model processes no longer alive: `30-cleanup-receipt.txt`.

Verdicts:

- HAPPY: FAIL. Deciding observable: `pre=2 post=2` in `28-happy-counts.txt`.
- REFUSAL: NOT-REACHED. Deciding observable: no control-specific assertion implemented in this run.
- ABSENT: NOT-REACHED. Deciding observable: no control-specific assertion implemented in this run.

### WHY IT IS ENOUGH

Execution proves child record exists, survives real server restart, and continuation attempt did not append a child transcript turn. It does not establish cause because fake-model continuation tool request needs deeper capture analysis.

### WHAT WAS OMITTED

- No credentials, passwords, auth headers, or raw request payloads recorded.
- No claim that active or nonexistent controls passed.

## ATTEMPT 5 (corrected tool invocation)

### WHAT WAS TESTED

- Corrected fake model continuation tool from read-only `background_output` to `task`, with `task_id`, `prompt: RESUME_ADOPT_PROBE_CONTINUATION`, `description`, and `run_in_background: false`.
- Added one-shot branch latches. Corrected run: `bash .agents/skills/opencode-qa/scripts/resume-adopt-restart-probe.sh --evidence-dir .omo/evidence/20260824-resume-adopt-fallback`.
- Added child transcript marker assertion.

### WHAT WAS OBSERVED

- Attempt 4 HAPPY=FAIL was a probe defect: fake model called `background_output`, which cannot invoke continuation.
- Corrected fake model selected `restart-resume` once. Capture: `33-fake-openai.log`.
- Child survived restart. Capture: `40-child-survived-restart.txt`.
- HAPPY still did not append child transcript content. `41-happy-counts.txt` records `pre=2 post=2`; `42-happy-marker.txt` is empty, so marker grep did not match.
- Host DB count was `2663` before and after this isolated run. Captures: `32-host-session-count-before.txt`, `44-host-session-count-after.txt`.
- Cleanup: server PID `5800` and fake model PID `5724` were dead. Capture: `43-cleanup-receipt.txt`.

Verdicts:

- HAPPY: FAIL. Deciding observable: `grep -F RESUME_ADOPT_PROBE_CONTINUATION 42-happy-marker.txt` produced no match; count remained `pre=2 post=2`.
- REFUSAL: NOT-REACHED. Deciding observable: control assertion omitted after HAPPY result.
- ABSENT: NOT-REACHED. Deciding observable: control assertion omitted after HAPPY result.

### WHY IT IS ENOUGH

Corrected run proves task continuation call was model-driven once, child persisted across real server restart, and marker did not land in child transcript. Product adoption remains unproven.

### WHAT WAS OMITTED

- No credentials, passwords, headers, or raw requests.
- No active-session or nonexistent-session control claim.
