# Background completion reason QA

## WHAT WAS TESTED

- Test 8 RED: `bun test packages/omo-opencode/src/features/background-agent/background-task-notification-template.test.ts` after adding clean completed task with `completionReason: "session-gone"` and no unfinished todos.
- Template GREEN: same selector after separating completed todo-count and reason suffixes.
- Feature suite: `bun test packages/omo-opencode/src/features/background-agent/`.
- Scoped typecheck: `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`.
- Build: `bun run build`.
- Live QA: `/tmp/bg-completion-reason-live-qa.sh` used `mock-model.mjs`, isolated XDG plus sandboxed HOME, HTTP `opencode serve`, `mockprov/mock-model` pins for every agent and category, then direct session API prompt. Parent transcript and SQLite artifacts stored beside this report.

## WHAT WAS OBSERVED

- RED assertion showed `reason: session-gone` absent from clean completed summary. Full output: `34-test-8-red-output.txt`.
- GREEN selector: 30 pass, 0 fail, 68 expect calls. Full feature suite: 917 pass, 0 fail, 2402 expect calls. Scoped tsgo exited 0. Build completed. Outputs: `35-template-green-output.txt`, `36-feature-suite-output.txt`, `37-scoped-tsgo-output.txt`.
- Live parent transcript contains `[ALL BACKGROUND TASKS COMPLETE]` and `reason: session-gone`: `29-live-notification-line-mock-qa.txt`, `25-parent-transcript-mock-qa.jsonl`.
- Programmatic checks found one completion notification block and one valid union reason: `30-live-assertions-mock-qa.txt`.
- Real DB session count was 3064 before and 3064 after: `23-real-db-before-mock-qa.txt`, `32-real-db-after-mock-qa.txt`; empty `33-real-db-count-diff-mock-qa.txt` proves equality.
- Teardown receipt: `31-mock-qa-cleanup-receipt.txt` records mock dead and sandbox absent. Server PID had already been cleared by shared cleanup, shown as empty and `alive=no`.

## WHY IT IS ENOUGH

- RED proves prior 916-pass state missed clean completion reason output.
- Three template cases lock behavior: clean completion renders reason, unfinished todos preserve `completed with 3 unfinished todos, reason: todo-gate-expired`, and no reason renders no `reason:` qualifier.
- Live server exercised `session-gone` only through plugin, background delegation, completion notification, and parent transcript persistence with local mock provider. `terminal-session-status`, `todo-gate-expired`, `idle-status`, and `session-idle-event` have unit coverage only; this remains residual risk. Mock request log proves requests reached `mock-model.mjs`, not vendor provider.
- DB before/after and teardown receipt prove isolation and cleanup.

## WHAT WAS OMITTED

- No credentials, auth headers, or environment dumps copied. Mock uses `apiKey: "not-needed"` and local loopback only.
- Earlier failed fake Responses API attempt remains as historical artifacts `12` through `22`; it used incompatible endpoint/server pairing and is not claimed as passing QA.
