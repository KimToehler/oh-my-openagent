# MCP tool-output blindspot QA

## WHAT WAS TESTED

All commands ran from `/Users/tim/git/oh-my-openagent/.worktrees/fix-mcp-tool-output-blindspot` on branch `fix/mcp-tool-output-blindspot`.

1. Built worktree plugin with `bun run build`.
   - Artifact: `build.log`
2. Ran required regression slice:
   ```sh
   bun test packages/omo-opencode/src/hooks/unpolled-shell-job/ \
     packages/omo-opencode/src/plugin/tool-execute-after.test.ts \
     packages/omo-opencode/src/shared/tool-output-text.test.ts
   ```
   - Artifact: `scoped-tests.log`
3. Ran required adapter type check:
   ```sh
   bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json
   ```
   - Artifact: `typecheck.log`
4. Real after probe. Sourced `script/agent/qa-sandbox.sh`, wrote sandbox-only `opencode.json` with:
   ```json
   {"plugin":["file:///Users/tim/git/oh-my-openagent/.worktrees/fix-mcp-tool-output-blindspot/dist/index.js"],"mcp":{"lean-ctx":{"type":"local","command":["/Users/tim/.local/bin/lean-ctx","mcp"]}}}
   ```
   Started isolated `opencode serve`, then drove real `opencode run --attach ... --format json` against OpenCode `1.18.15` using model `opencode/deepseek-v4-flash-free`.
   Prompt required real MCP tool `lean-ctx_ctx_shell` with `command: "sleep 30; printf OMO_MCP_TRACKED_COMMAND"` and `run_in_background: true`.
   - Artifacts: `after-real-opencode-events.jsonl`, `after-plugin-log.txt`, `after-session-export.json`
5. Real before probe. Stashed uncommitted fix, rebuilt pre-fix `dev` code, repeated same isolated OpenCode/MCP detached-shell action with `sleep 30; printf OMO_MCP_BASELINE_COMMAND`, then restored stash and rebuilt fixed dist.
   - Artifacts: `before-real-opencode-events.jsonl`, `before-plugin-log.txt`
6. Read host session count before and after. No OpenCode process used host XDG directories.
   - Artifact: `isolation.txt`

## WHAT WAS OBSERVED

### Fixed build: real MCP result tracked

`after-real-opencode-events.jsonl` records a genuine MCP tool invocation, not TS-level direct invocation:

- Tool: `lean-ctx_ctx_shell`
- Session: `ses_fef66e507ffeZ7OUTJEvIuupuu`
- Detached job: `shell_f430a14815f2bb4a`
- Raw tool result text: `[background:shell_f430a14815f2bb4a started ...]`
- Requested command: `sleep 30; printf OMO_MCP_TRACKED_COMMAND`

`after-plugin-log.txt` proves loaded `dist/index.js` received session idle and dispatched unpolled-shell guard for that exact job:

```text
[unpolled-shell-job] Prompted session to poll its detached shell jobs {"sessionID":"ses_fef66e507ffeZ7OUTJEvIuupuu","jobIds":["shell_f430a14815f2bb4a"]}
```

`after-session-export.json` contains `OMO_MCP_TRACKED_COMMAND` five times and contains zero `started before it was tracked` strings. This is emitted guard message content and proves tracker retained actual `args.command`, not fallback command label.

### Pre-fix build: raw MCP result did not arm guard

`before-real-opencode-events.jsonl` records equivalent genuine MCP call:

- Tool: `lean-ctx_ctx_shell`
- Session: `ses_fef689a72ffeRU8xw1uiVFf8LB`
- Detached job: `shell_94a23ddb54b49195`
- Command: `sleep 30; printf OMO_MCP_BASELINE_COMMAND`

`before-plugin-log.txt` has no `[unpolled-shell-job] Prompted ...` line for this session or job. Old handler checked `.output`, but OpenCode delivered MCP raw `content[]`; start result therefore never reached tracker. This contrast is expected old failure. No fabricated fallback claim: baseline did not reach status-poll adoption path in this probe.

### Regression gates

- Build completed: `build.log` ends `build: all steps completed`.
- Scoped tests: `56 pass`, `0 fail`, 4 files. See `scoped-tests.log`.
- `tsgo --noEmit`: zero output and zero exit status. See `typecheck.log`.

### Isolation and cleanup

`isolation.txt` records host database `/Users/tim/.local/share/opencode/opencode.db`: 2221 sessions before and 2221 after. Each real run used fresh `OMO_QA_ROOT` with isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `CODEX_HOME`. Each sandbox had one session only. EXIT traps killed/waited isolated `opencode serve` process and removed sandbox. Test-generated `packages/omo-senpi/plugin/extensions/*` change reverted with `git checkout --`.

## WHY IT IS ENOUGH

This covers production execution path: OpenCode `1.18.15` loaded worktree-built `dist/index.js`, launched real MCP server `lean-ctx`, accepted real model tool call, produced real raw MCP start text, then invoked real `session.idle` hook. Difference from pre-fix build is observable: fixed build injected actual command into guard prompt; pre-fix build never armed guard.

Unit tests cover raw-MCP extraction, terminal poll clearing, tracker adoption policy, and cooldown behavior. Build plus package type check cover bundle/type integrity.

Residual risk: live probe verifies start tracking and idle nudge. It does not independently reproduce every possible lean-ctx status wording or every OpenCode MCP provider shape. Covered unit tests exercise terminal `content[]` poll and unparseable-status behavior.

## WHAT WAS OMITTED

- `.env` contents, provider credentials, auth headers, and environment dumps omitted.
- Raw OpenCode/plugin logs kept only session/job IDs and command markers required for proof.
- No host OpenCode config, DB content, or session transcript copied.
