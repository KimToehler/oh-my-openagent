#!/usr/bin/env bash
set -euo pipefail

REPO='/Users/tim/git/oh-my-openagent'
EVIDENCE="$REPO/.omo/evidence/20260824-mcp-tool-name-gating"
SKILL="$REPO/.agents/skills/opencode-qa"
REAL_DB="$(opencode db path)"
DB_BEFORE="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
SANDBOX="$(mktemp -d -t omo-mcp-gating.XXXXXX)"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
export HOME="$SANDBOX/home"
export OPENCODE_TEST_HOME="$HOME"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$HOME/.omo" "$SANDBOX/project"
if [ -d /Users/tim/.opencode/bin ]; then
  mkdir -p "$HOME/.opencode"
  ln -s /Users/tim/.opencode/bin "$HOME/.opencode/bin"
fi

FAKE="$EVIDENCE/05-fake-provider.mjs"
cat >"$FAKE" <<'MJS'
import http from 'node:http'
import { sendSse, textEvents, toolCallEvents } from '/Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs'
let count = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    count += 1
    process.stderr.write(`request=${count} method=${req.method} path=${req.url} bytes=${body.length}\n`)
    if (count === 1) {
      sendSse(res, toolCallEvents(count, 'write', 'call_write_existing', { filePath: 'existing.txt', content: 'must-not-overwrite' }))
      return
    }
    sendSse(res, textEvents(count, 'fake provider completed after write guard'))
  })
})
server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
MJS

cleanup() {
  [ -n "${WATCH_PID:-}" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
  wait "${FAKE_PID:-}" 2>/dev/null || true
  DB_AFTER="$(sqlite3 "$REAL_DB" 'SELECT count(*) FROM session')"
  printf 'real_db=%s\nsessions_before=%s\nsessions_after=%s\nsandbox=%s\n' "$REAL_DB" "$DB_BEFORE" "$DB_AFTER" "$SANDBOX" >"$EVIDENCE/05-real-harness-isolation.txt"
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

bun "$FAKE" >"$EVIDENCE/05-fake-provider.stdout.txt" 2>"$EVIDENCE/05-fake-provider.stderr.txt" &
FAKE_PID=$!
for _ in $(seq 1 80); do
  if grep -q '^PORT=' "$EVIDENCE/05-fake-provider.stdout.txt"; then break; fi
  sleep 0.1
done
FAKE_PORT="$(sed -n 's/^PORT=//p' "$EVIDENCE/05-fake-provider.stdout.txt" | head -1)"
test -n "$FAKE_PORT"

cat >"$XDG_CONFIG_HOME/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://${REPO}/dist/index.js"],
  "model": "openai/gpt-fake",
  "provider": {
    "openai": {
      "options": { "apiKey": "redacted", "baseURL": "http://127.0.0.1:${FAKE_PORT}/v1", "timeout": 60000 },
      "models": { "gpt-fake": { "tool_call": true, "limit": { "context": 200000, "output": 8192 } } }
    }
  },
  "permission": { "write": "allow", "edit": "allow", "read": "allow" }
}
JSONC
printf '{ "[opencode]": { "disabled_mcps": ["context7", "codegraph"] } }\n' >"$HOME/.omo/omo.jsonc"
printf 'protected original content\n' >"$SANDBOX/project/existing.txt"

PASS='qa-password-not-recorded'
export OPENCODE_SERVER_PASSWORD="$PASS"
opencode serve --hostname 127.0.0.1 --port 0 --print-logs >"$EVIDENCE/05-server.stdout.txt" 2>"$EVIDENCE/05-server.stderr.txt" &
SERVER_PID=$!
for _ in $(seq 1 120); do
  URL="$(sed -nE 's/.*(http:\/\/127\.0\.0\.1:[0-9]+).*/\1/p' "$EVIDENCE/05-server.stdout.txt" | head -1)"
  [ -n "${URL:-}" ] && break
  sleep 0.1
done
test -n "$URL"
for _ in $(seq 1 80); do
  curl -sf -u "opencode:$PASS" "$URL/global/health" >/dev/null && break
  sleep 0.1
done
curl -sf -u "opencode:$PASS" "$URL/global/health" | jq -c . >"$EVIDENCE/05-health.json"

bash "$SKILL/scripts/sse-hook-probe.sh" --attach "$URL" --password "$PASS" --directory "$SANDBOX/project" --event plugin.added --timeout 20 >"$EVIDENCE/05-plugin-added-probe.txt" 2>&1 &
WATCH_PID=$!
sleep 0.4
SESSION="$(curl -sf -u "opencode:$PASS" -H 'content-type: application/json' -d '{}' "$URL/session?directory=$SANDBOX/project" | jq -r '.id')"
test -n "$SESSION" && test "$SESSION" != null
curl -sf -u "opencode:$PASS" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"Write existing.txt"}]}' "$URL/session/$SESSION/prompt_async?directory=$SANDBOX/project" -o /dev/null -w 'prompt_async_http=%{http_code}\n' >"$EVIDENCE/05-prompt.txt"
wait "$WATCH_PID"; unset WATCH_PID

bash "$SKILL/scripts/sse-hook-probe.sh" --attach "$URL" --password "$PASS" --directory "$SANDBOX/project" --event message.part.updated --timeout 20 >"$EVIDENCE/05-message-part-probe.txt" 2>&1 &
WATCH_PID=$!
sleep 0.4
curl -sf -u "opencode:$PASS" "$URL/session/$SESSION/message?directory=$SANDBOX/project" | jq -c . >"$EVIDENCE/05-session-messages.json"
wait "$WATCH_PID" || true; unset WATCH_PID

sqlite3 "$XDG_DATA_HOME/opencode/opencode.db" "SELECT coalesce(json_extract(data, '$.tool'), ''), coalesce(json_extract(data, '$.state.status'), ''), replace(coalesce(json_extract(data, '$.state.output'), ''), char(10), ' ') FROM part WHERE session_id = '$SESSION' AND json_extract(data, '$.type') = 'tool';" >"$EVIDENCE/05-tool-parts.txt"
printf 'existing_file_after=%s\n' "$(cat "$SANDBOX/project/existing.txt")" >"$EVIDENCE/05-existing-file.txt"
printf 'session_id=%s\nserver_url=%s\nsandbox_db=%s\n' "$SESSION" "$URL" "$XDG_DATA_HOME/opencode/opencode.db" >"$EVIDENCE/05-harness-metadata.txt"
