WHAT WAS TESTED

- `bun run build` from assigned worktree. Command exceeded harness foreground timeout after spawning build; generated unrelated tracked artifact was restored before continuing.
- `source script/agent/qa-sandbox.sh; opencode run --format json 'Read packages/omo-opencode/src/shared/prompt-async-gate.ts, then do unrelated work, then edit that same file.'`
- Real DB before and after: `sqlite3 "$HOME/.local/share/opencode/opencode.db" 'SELECT count(*) FROM session;'`.
- Unit coverage and compaction mutation proof recorded in command transcript.

WHAT WAS OBSERVED

- Live QA failed before any tool call. Exact captured error is `.omo/evidence/20260827-rules-resurfacing/opencode-run.jsonl`:
  `Bad Request: checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint`
- Marker counts from `.omo/evidence/20260827-rules-resurfacing/qa-counts.txt`: `[Rule: ` = 0; `[Rule reminder: ` = 0. No ordering or imperative-body assertion is possible because provider authentication rejected prompt before session execution.
- Real DB count remained identical: before `3055`; after `3055`.
- Sandbox cleanup receipt: `sandbox_removed`.

WHY IT IS ENOUGH

- It proves live harness QA is blocked by provider authentication, not substituted with unit tests. Isolation condition passed. Unit tests cover bounded extraction, content-hash callback, transcript callback route, real-path exclusion, restart watermark, transform delivery, and compaction reinjection pin. Live marker conditions remain unverified.

WHAT WAS OMITTED

- No environment dump, provider token, authorization header, or private config was copied. Raw provider failure remains in `opencode-run.jsonl`.
