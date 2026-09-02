# QA evidence: sandbox plugin registration

**Worktree:** `fix/qa-sandbox-plugin-registration`
**Base:** `dev` @ `8b1831cf2`
**Surface:** real `opencode serve` 1.18.20, isolated by `script/agent/qa-sandbox.sh`; fake OpenAI only drives deterministic native-tool calls.

## What was tested

1. Source `script/agent/qa-sandbox.sh` with no hand-written OpenCode plugin config.
2. Start real `opencode serve` in `$OMO_QA_PROJ`.
3. Set valid isolated omo config: `{"[opencode]":{"hashline_edit":true}}`.
4. Drive native `read` through a fake-model tool call against a real sandbox file.
5. Assert plugin startup with `oqa_assert_plugin_loaded`, which checks the plugin's `ENTRY - plugin loading` log marker.
6. Compare host OpenCode DB session count before and after.
7. Negative control: replace configured plugin with nonexistent `dist/DOES-NOT-EXIST.js`; confirm `/config` lists it while `oqa_assert_plugin_loaded` fails.

## What was observed

### Positive control

- `11-plugin-loaded-assertion.txt`: `PASS: omo plugin loaded (1 ENTRY line(s))`.
- `10-session-messages.json`: native `read` tool output includes `1#SN|QA_SANDBOX_ANCHOR`.
- `13-isolation.txt`: host session count stayed `3642 -> 3642`, `unchanged=yes`.
- Fake model made exactly two calls: one native `read`, one completion response.

### Negative control

- `/config` listed `file:///.../dist/DOES-NOT-EXIST.js`.
- Server health still returned 200.
- `oqa_assert_plugin_loaded` failed because no plugin log existed, correctly rejecting a healthy server with absent omo hooks.

## Why this is enough

This drives real OpenCode server/plugin loading plus a real native tool execution. It proves default sandbox registration leads to actual plugin initialization and observable hashline behavior, while host DB isolation remains intact. Negative control proves the new assertion catches the exact false-positive state `/config` cannot detect.

## Driver corrections during QA

- `/session/:id/command` accepts slash-command `arguments`; it is not native tool execution API. First run returned HTTP 400 before tool execution.
- First fake-model branch returned `read` after every tool result, causing a loop. Corrected temporary QA driver to return completion after one tool result; not included in shipped diff.

## Omitted

Raw server and fake-model logs retained as scoped artifacts above. No credentials, tokens, provider keys, or environment dumps copied into this report.
