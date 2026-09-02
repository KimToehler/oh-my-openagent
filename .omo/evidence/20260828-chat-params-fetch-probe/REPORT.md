# Chat Params Fetch Header Probe

## WHAT WAS TESTED

Command:

```sh
cd /Users/tim/git/oh-my-openagent
source script/agent/qa-sandbox.sh
cd "$OMO_QA_PROJ"
opencode run --model mockprov/mock-model --format json 'Reply with exactly probe complete'
```

Isolation capture:

```text
HOME=/var/folders/c6/rmmgm5s52vsc2_g434mnp_nm0000gn/T/omo-qa-sandbox.XXXXXX.ffCPgTYlxf/home
OMO_QA_PROJ=/var/folders/c6/rmmgm5s52vsc2_g434mnp_nm0000gn/T/omo-qa-sandbox.XXXXXX.ffCPgTYlxf/proj
```

Throwaway mock and plugin existed only below `$OMO_QA_PROJ/probe`. Plugin set `output.options.fetch`; wrapper wrote `PROBE_CHAT_PARAMS_FETCH_SET`, `PROBE_FETCH_CALLED`, and `PROBE_HEADER` to sandbox-only file. Sandbox `opencode.json` loaded only throwaway plugin and `mockprov`. Sandbox `omo.jsonc` contained literal `"[opencode]"` object with every agent and category pinned to `mockprov/mock-model`.

## WHAT WAS OBSERVED

Raw direct mock check before OpenCode:

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
X-9Router-Upstream-Model: anthropic/claude-opus-5
Date: Fri, 28 Aug 2026 14:25:15 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked
```

Raw first live run result:

```text
COMMAND: opencode run --model mockprov/mock-model --format json "Reply with exactly probe complete"
{"type":"error","timestamp":1787927116577,"sessionID":"ses_fb73d45c5ffeeWf40SgWPTl3mS","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_82534509"}}}
EXIT=1
```

Raw mock-server capture during that run:

```text
MOCK_REQUEST=/v1/chat/completions
```

Raw plugin file-log capture in later diagnostic run:

```text
<empty file>
```

Raw later known-mock attempt result:

```text
{"type":"error","timestamp":1787927311838,"sessionID":"ses_fb73a4b0affebJrclGPFtYMXAi","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_7ff56f9b"}}}
EXIT=1
```

`PROBE_HEADER=anthropic/claude-opus-5` did not appear. `PROBE_CHAT_PARAMS_FETCH_SET` did not appear. Probe therefore did not establish whether OpenCode forwards `options.fetch`: failing completion occurred before plugin hook instrumentation was observable. This is **inconclusive**, not NO.

Captured raw artifacts:

- `00-isolation.txt`
- `01-curl-header.txt`
- `03-opencode-stdout.txt`
- `04-opencode-stderr.txt`
- `05-opencode-exit.txt`
- `06-mock-stderr.txt`
- `16-filelog-stdout.txt`
- `20-plugin-file-log.txt`
- `26-baseline-curl-header.txt`
- `27-base-mock-stdout.txt`
- `31-base-mock-plugin-log.txt`

## WHY IT IS ENOUGH

Enough to prove isolation and upstream header behavior. Not enough to answer target question: live chat completion failed, so required successful completion and wrapper execution did not occur. A provider-namespaced `options.fetch` variant was not meaningful because direct `options.fetch` hook itself was not reached; it remains required for a conclusive negative experiment after root-cause fix.

## WHAT WAS OMITTED

No credentials, auth headers, host config, host Codex state, host OMO state, or host OpenCode DB content captured. Sandbox paths retained only because isolation proof requires them. No repository files under `packages/` changed. No commit or push.
