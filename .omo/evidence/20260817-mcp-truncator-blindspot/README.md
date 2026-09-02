# QA evidence: tool-output-truncator never ran for MCP tools

Date: 2026-08-17
Change: `packages/omo-opencode/src/hooks/tool-output-truncator.ts` +
`packages/omo-opencode/src/shared/tool-output-text.ts` (`applyToolOutputText`)

## What was tested

That the `tool-output-truncator` hook actually truncates the output of an **MCP**
tool, and that the truncation reaches the model.

This is the follow-up to the `unpolled-shell-job` fix. That change proved the
READ side: for MCP tools `tool.execute.after` receives the RAW MCP result, whose
text lives in `content[]`, so `.output` is `undefined` and a
`typeof output.output === "string"` guard drops 100% of MCP calls.

The truncator carried the same guard. Its own commit (`25a5c2eeb`) lists the
intent explicitly:

```
Truncated tools:
- lsp_find_references (new)
- lsp_document_symbols (new)
- lsp_workspace_symbols (new)
- lsp_diagnostics (new)
```

`lsp_diagnostics` is an MCP tool (built-in `lsp` stdio MCP server, tool
`diagnostics`, composed as `${server}_${tool}`), so that feature had never
executed once.

The WRITE side is also asymmetric, verified against the OpenCode 1.18.15 bundle:

- native: `V = {...h, attachments}` -> hook -> `return V`, so `.output` writes propagate.
- MCP: hook gets raw `m`, then the result is rebuilt as
  `{output: <joined content[] text>, content: m.content}` AFTER all hooks.
  So `.output` writes are DISCARDED and only a `content[]` edit survives.

## How it was tested

Real MCP wire data, not a hand-built fixture.

- `huge-mcp-server.mjs` - a real stdio MCP server speaking JSON-RPC
  (`initialize` / `tools/list` / `tools/call`). Its `diagnostics` tool returns a
  ~20.9 MB text payload with a known header (`QA_MCP_HEADER_LINE_1..3`) and a
  known tail sentinel (`QA_MCP_TAIL_SENTINEL_SHOULD_BE_TRUNCATED_AWAY`).
- `probe.mjs` - performs the MCP handshake, takes the returned result object
  **exactly as OpenCode passes it** to `tool.execute.after` on the MCP path,
  runs the real hook over it, then reproduces OpenCode's post-hook
  normalization (`output` rebuilt by joining `content[]` text blocks) to show
  what the model actually receives.

Run:

```bash
QA_MCP_LINES=200000 bun probe.mjs <path-to-tool-output-truncator.ts>
```

## What was observed

Payload as the hook receives it on the MCP path (both runs):

```
has .output          : false
typeof .output       : undefined
content[] blocks     : 1
content[0].text chars: 20888998
```

That alone confirms the blindspot: there is no `.output` to read.

| Run | Artifact | chars in -> out | marker | exit |
|---|---|---|---|---|
| BEFORE (pre-fix, `HEAD` version) | `probe-BEFORE-fix.txt` | 20888998 -> 20888998 | absent | 1 (FAIL) |
| AFTER (fixed) | `probe-AFTER-fix.txt` | 20888998 -> 196771 | present | 0 (PASS) |

After the fix the model receives 196771 chars / 1925 lines: the 3 header lines
are preserved, the payload ends with
`[198081 more lines truncated due to context window limit]`, and the tail
sentinel is gone. Before the fix all 20.9 MB passed through untouched, tail
sentinel included.

Unit gates:

- `tool-output-text.test.ts` + `tool-output-truncator.test.ts`: 24 pass / 0 fail.
- Causality re-checked by reverting only the fix hunk in place: the 2 new MCP
  cases fail, restoring makes them pass again.
- `bun run typecheck`: clean across all workspace packages.
- Full `bun test`: 15548 pass / 11 fail. The 11 are pre-existing and unrelated
  (agent command audit, skill-loader ulw-plan dedup, BackgroundManager poll,
  reflection flow); confirmed by stashing the change and re-running those
  suites on a clean tree, which reproduces the same failures. No failing suite
  imports either changed file.

## Why this is enough

The probe exercises the real MCP transport and the real built hook, and asserts
on the post-hook normalized text (what the model sees), not on an intermediate.
The before/after pair isolates the fix as the only variable: identical input,
identical harness, opposite outcome.

## What was omitted

- No live model call: the probe drives the hook directly, so no provider
  credentials, tokens, or auth headers appear in any artifact.
- No real MCP server from the user's config was contacted; the QA server is a
  local stub in this folder.
- The 20.9 MB payloads themselves are not stored, only the measured
  lengths/lines and the first/last lines.
- A temporary in-tree copy of the pre-fix hook was needed for the BEFORE run
  (relative imports); it was deleted afterwards and `git status` confirmed the
  tree holds only the two intended file changes.
