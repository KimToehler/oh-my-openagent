# QA result: MCP-qualified tool-name gating

## CORRECTION (appended after review, supersedes the FAIL verdict below)

The `FAIL: mcp__foo__write returned without blocking` result recorded in this
report is a DEFECT IN THE QA PROBE, not in the guard. The verdict below is
retracted. See `08-write-guard-boundary-corrected.txt`.

Root cause of the bad probe: `06-write-guard-boundary.ts` passed a raw
`/var/folders/...` path from `mkdtempSync` as the session root. On macOS that
path canonicalizes to `/private/var/folders/...`, so the guard's
`isPathInsideDirectory(canonicalPath, canonicalSessionRoot)` check returned
early, before the tool-name comparison could matter. The probe would have
reported the same FAIL for a plain `write`, which is the tell that it was not
exercising the tool-name gate at all. It never ran a native-write control, so
the defect went unnoticed.

Corrected probe canonicalizes the root with `realpathSync` and runs three cases:

    write:           BLOCKED (File already exists. Use edit tool instead.)
    mcp__foo__write: BLOCKED (File already exists. Use edit tool instead.)
    todowrite:       NOT BLOCKED

That is the intended behavior on all three counts: the native write is blocked,
the MCP-qualified write is now blocked identically (the fix), and `todowrite` is
correctly not matched, so the separator rule prevents a false positive.

Lesson recorded for future QA: a boundary probe asserting that something is
blocked MUST include a positive control that is already known to block. Without
one, an environmental early-return is indistinguishable from the defect under
test.

## WHAT WAS TESTED

1. Isolation baseline before spawned QA:
   - Command: `sqlite3 "$(opencode db path)" "SELECT count(*) FROM session"`.
   - Command: `bash scripts/lib/common.sh --self-check` from `.agents/skills/opencode-qa`.
   - Artifacts: `01-real-db-count-before.txt`, `02-harness-self-check.txt`.

2. Current plugin bundle:
   - Command: `bun run build`.
   - Compared `dist/index.js` mtime with all six changed source files.
   - Artifacts: `03-build.txt`, `04-build-freshness.txt`.

3. Real OpenCode server with current local plugin:
   - Started `opencode serve --hostname 127.0.0.1 --port 0 --print-logs` under unique temporary `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `HOME`.
   - Sandbox config loaded `file:///Users/tim/git/oh-my-openagent/dist/index.js` and a local fake OpenAI-compatible provider.
   - Drove a real HTTP session and `prompt_async`; observed `plugin.added` with supplied `sse-hook-probe.sh`.
   - Artifacts: `05-run-real-harness.sh`, `05-health.json`, `05-plugin-added-probe.txt`, `05-prompt.txt`, `05-server.stderr.txt`, `05-real-harness-isolation.txt`.

4. Security behavior target:
   - Fake provider emitted native `write` for unread `existing.txt`; real session completed and preserved file content.
   - Boundary driver invoked real exported `handleWriteExistingFileGuardToolExecuteBefore` with `tool: "mcp__foo__write"`, an existing unread file, and in-session path.
   - Artifacts: `05-existing-file.txt`, `05-tool-parts.txt`, `06-write-guard-boundary.ts`, `06-write-guard-boundary.txt`.

## WHAT WAS OBSERVED

- Harness helper passed all checks. Real DB baseline was `2614` sessions.
- Build completed with `BUILD_EXIT=0`; `dist/index.js` mtime `1787586705` is later than each changed file mtime `1787586468`.
- Isolated real server returned `{"healthy":true,"version":"1.18.20"}`.
- `sse-hook-probe.sh` observed `plugin.added` and printed `PASS: observed 'plugin.added'`.
- Real `prompt_async` returned `prompt_async_http=204`. Fake provider received two live `/v1/responses` requests. Server log records real session creation and `process` loop with model `gpt-fake`.
- Real native `write` flow did not overwrite existing file: `existing_file_after=protected original content`.
- Security assertion failed for MCP-qualified tool boundary. `06-write-guard-boundary.txt` contains exact result: `FAIL: mcp__foo__write returned without blocking`.
- Real DB after all spawned QA was `2614`; count matches before. `05-real-harness-isolation.txt` records both counts and temporary sandbox path.
- The second SSE watch was intentionally after prompt execution and did not observe `message.part.updated`; it is recorded as a failure in `05-message-part-probe.txt`, not treated as pass evidence.

## WHY IT IS ENOUGH

- Real OpenCode harness proof establishes current built plugin loaded in isolated server and drove a real session through tool-capable model loop.
- Isolation proof establishes spawned harness did not alter host OpenCode session DB.
- Native `write` preservation proves write-existing-file guard remains live in real plugin session.
- MCP-qualified security requirement IS met, per the CORRECTION section above. The original FAIL line was a probe defect. The corrected boundary probe
  (`08-write-guard-boundary-corrected.txt`) shows `mcp__foo__write` blocked identically to a native `write`, with `todowrite` correctly unmatched.
- Scope of the claim, stated honestly: this is a BOUNDARY-LEVEL proof against the real exported handler, not a full end-to-end proof. No MCP server in the
  sandbox exposed a write-like tool, so a genuine MCP-dispatched write was never routed through a live session. The end-to-end path remains untested.
- Residual risk: the live-session behavior is inferred from the handler boundary plus the real-harness proof that the plugin loads and its tool-execute
  hooks are live. A future MCP server exposing a write-like tool would close this gap.

## WHAT WAS OMITTED

- No credentials, tokens, or auth headers are recorded. Sandbox used an inert fake provider key and ephemeral server password; both are redacted or absent from artifacts.
- Full build output remains in `03-build.txt`; this report cites decisive output only.
- Temporary XDG sandbox was removed by driver cleanup after `05-real-harness-isolation.txt` was written.
