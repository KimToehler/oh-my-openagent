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
