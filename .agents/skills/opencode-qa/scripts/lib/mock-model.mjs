// mock-model.mjs - a local OpenAI-compatible chat/completions SSE server for opencode-qa.
//
// WHY: opencode talks to a model over HTTP. Pointing an @ai-sdk/openai-compatible
// provider at this server lets QA drive a REAL opencode turn end-to-end with NO
// real API call, no key, and no network egress - so we exercise OUR plugin and
// never a vendor. The codex-qa side has had this for a while
// (.agents/skills/codex-qa/scripts/lib/mock-model.mjs); this is the OpenCode twin.
//
// Unlike the codex one, this must emit TOOL CALLS, not just text: the flows worth
// QA-ing (a parent delegating via `task`, a child calling `report_blocked`) only
// happen when the model asks for a tool.
//
// SCRIPTING: pass a JSON array of turns via MOCK_SCRIPT (inline) or MOCK_SCRIPT_FILE.
// Each request consumes the next turn; the last turn repeats once exhausted, so an
// extra probe request cannot wedge the run.
//
//   text turn:  { "text": "done" }
//   tool turn:  { "tool": "report_blocked", "args": { "reason": "x", "needs": "y" } }
//
// MATCHING (optional): give a turn a "when" substring and it is only used when the
// incoming request body contains that substring. This is how one server drives both
// the parent session and the child session differently. Turns without "when" match
// anything. First match wins; matched turns are consumed unless "repeat": true.
//
// "unless" is the inverse and is what keeps a tool turn from looping forever: the
// turn is skipped when the body DOES contain the substring. A tool turn should
// carry `"unless": "<the tool name>"` scoped to a tool-result marker, so once the
// harness sends the tool's result back, the mock stops re-requesting it and falls
// through to the next turn. Without this, a `repeat: true` tool turn will spin the
// agent loop indefinitely - observed at 325 requests before the run was killed.
//
// CAPTURE (optional): a turn may carry `"capture": { "<name>": "<regex>" }`. When the
// turn matches, each regex runs against the request body and capture group 1 is stored
// under that name. Any later turn can interpolate it with `{{name}}` inside its `args`
// or `text`. This exists because the ids that matter are only knowable at RUNTIME - the
// parent must answer a blocked child with `task(task_id="<child session>")`, and that
// session id is minted mid-run. Without capture, the final hop of the blocked flow
// cannot be scripted at all.
//
// Env:
//   MOCK_PORT         TCP port (default 0 = OS-assigned). The chosen port is printed
//                     as "MOCK_LISTENING <port>" on stdout for the caller to read back.
//   MOCK_SCRIPT       inline JSON array of turns.
//   MOCK_SCRIPT_FILE  path to a JSON file containing that array.
//   MOCK_LOG          if set, every request body is appended to this file (for
//                     asserting what the harness actually sent).
import { appendFileSync, readFileSync } from "node:fs"
import { createServer } from "node:http"

function loadScript() {
  const file = process.env.MOCK_SCRIPT_FILE
  const raw = file ? readFileSync(file, "utf8") : process.env.MOCK_SCRIPT
  if (!raw) return [{ text: "Hello from the opencode-qa mock model." }]
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error("MOCK_SCRIPT must be a JSON array of turns")
  return parsed
}

const script = loadScript()
const consumed = new Set()
const captured = new Map()

function runCaptures(turn, body) {
  if (!turn.capture) return
  for (const [name, pattern] of Object.entries(turn.capture)) {
    const match = body.match(new RegExp(pattern))
    if (match && match[1] !== undefined) captured.set(name, match[1])
  }
}

function interpolate(value) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, name) => captured.get(name) ?? whole)
  }
  if (Array.isArray(value)) return value.map(interpolate)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, interpolate(inner)]))
  }
  return value
}

function pickTurn(body, hasTools) {
  for (let index = 0; index < script.length; index += 1) {
    if (consumed.has(index)) continue
    const turn = script[index]
    // A tool turn is unusable when the request advertises no tools. OpenCode's
    // title generator deliberately sends `tools: {}` (session/prompt.ts), so the
    // FIRST request of a session is toolless. Without this guard that request
    // consumes the tool turn, the real turn then falls through to text, and the
    // flow silently never happens - which reads exactly like a broken feature.
    if (turn.tool && !hasTools) continue
    if (turn.when !== undefined && !body.includes(turn.when)) continue
    if (turn.unless !== undefined && body.includes(turn.unless)) continue
    // A turn that interpolates an id it has never captured would send the literal
    // "{{name}}" downstream and fail confusingly. Skip it until the capture exists.
    const pending = JSON.stringify(turn.args ?? turn.text ?? "").match(/\{\{(\w+)\}\}/g)
    if (pending?.some((token) => !captured.has(token.slice(2, -2)))) continue
    runCaptures(turn, body)
    if (turn.repeat !== true) consumed.add(index)
    return { ...turn, args: interpolate(turn.args), text: interpolate(turn.text) }
  }
  return script[script.length - 1] ?? { text: "exhausted" }
}

function streamText(res, text) {
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })
  send({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  res.write("data: [DONE]\n\n")
  res.end()
}

function streamToolCall(res, turn) {
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  send({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: turn.id ?? `call_${turn.tool}`,
          type: "function",
          function: { name: turn.tool, arguments: JSON.stringify(turn.args ?? {}) },
        }],
      },
      finish_reason: null,
    }],
  })
  send({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === "POST" && req.url && req.url.includes("/chat/completions")) {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${body}\n---\n`)
      let hasTools = false
      try {
        const parsed = JSON.parse(body)
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
      } catch {
        hasTools = false
      }
      // Captures run against EVERY request before turn selection. The id we need
      // (a blocked child's session) arrives inside a wake the parent receives, and
      // the turn that answers it is not the turn that observes it.
      for (const turn of script) runCaptures(turn, body)
      const turn = pickTurn(body, hasTools)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      if (turn.tool) streamToolCall(res, turn)
      else streamText(res, turn.text ?? "")
    })
    return
  }
  if (req.method === "GET" && req.url && req.url.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }))
    return
  }
  res.writeHead(404).end()
})

const port = Number(process.env.MOCK_PORT || 0)
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`MOCK_LISTENING ${server.address().port}\n`)
})
