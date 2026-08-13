#!/usr/bin/env node
// Self-test for lib/mock-model.mjs. Proves the mock actually speaks the
// OpenAI-compatible SSE dialect opencode expects, including tool calls, before
// anyone trusts it to gate a QA verdict. Run: node mock-model-selftest.mjs
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const mock = join(here, "lib", "mock-model.mjs")

const script = JSON.stringify([
  { when: "PARENT_MARKER", tool: "task", args: { description: "spawn child", prompt: "go" } },
  { when: "CHILD_MARKER", tool: "report_blocked", args: { reason: "needs a key", needs: "the API key" } },
  { text: "fallback text turn" },
])

const child = spawn("node", [mock], { env: { ...process.env, MOCK_SCRIPT: script, MOCK_PORT: "0" } })

let port
const failures = []
function check(name, condition, detail) {
  if (condition) { console.log(`ok   - ${name}`); return }
  failures.push(name)
  console.log(`FAIL - ${name}${detail ? `: ${detail}` : ""}`)
}

const SOME_TOOLS = [{ type: "function", function: { name: "task", parameters: {} } }]

async function post(marker, tools = SOME_TOOLS) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mock-model", stream: true, tools, messages: [{ role: "user", content: marker }] }),
  })
  return await res.text()
}

child.stdout.on("data", async (buf) => {
  const match = String(buf).match(/MOCK_LISTENING (\d+)/)
  if (!match || port) return
  port = Number(match[1])
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    check("health endpoint responds 200", health.status === 200, `got ${health.status}`)

    const parent = await post("PARENT_MARKER")
    check("parent turn emits a tool_calls delta", parent.includes('"tool_calls"'), parent.slice(0, 120))
    check("parent turn selects the `task` tool by `when` match", parent.includes('"name":"task"'), parent.slice(0, 200))
    check("parent turn finishes with finish_reason tool_calls", parent.includes('"finish_reason":"tool_calls"'))
    check("stream terminates with [DONE]", parent.includes("data: [DONE]"))

    const childTurn = await post("CHILD_MARKER")
    check("child turn selects `report_blocked` by `when` match", childTurn.includes('"name":"report_blocked"'), childTurn.slice(0, 200))
    check("child turn carries the scripted args", childTurn.includes("the API key"))

    const leftover = await post("NO_MARKER_HERE")
    check("unmatched request falls through to the text turn", leftover.includes("fallback text turn"), leftover.slice(0, 160))
    check("text turn finishes with finish_reason stop", leftover.includes('"finish_reason":"stop"'))

    const exhausted = await post("NO_MARKER_HERE")
    check("exhausted script repeats the last turn instead of hanging", exhausted.includes("fallback text turn"))

    // `unless` is the loop-breaker: a repeating tool turn must stand down once the
    // harness has sent the tool's result back, or the agent loop spins forever.
    const loopScript = JSON.stringify([
      { tool: "report_blocked", args: { reason: "r", needs: "n" }, repeat: true, unless: "TOOL_RESULT_MARKER" },
      { text: "after the tool result" },
    ])
    const loopChild = spawn("node", [mock], { env: { ...process.env, MOCK_SCRIPT: loopScript, MOCK_PORT: "0" } })
    const loopPort = await new Promise((resolve) => {
      loopChild.stdout.on("data", (b) => {
        const m = String(b).match(/MOCK_LISTENING (\d+)/)
        if (m) resolve(Number(m[1]))
      })
    })
    const loopPost = async (content) => {
      const r = await fetch(`http://127.0.0.1:${loopPort}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, tools: SOME_TOOLS, messages: [{ role: "user", content }] }),
      })
      return await r.text()
    }
    const beforeResult = await loopPost("please call the tool")
    check("repeating tool turn fires while no tool result is present", beforeResult.includes('"name":"report_blocked"'))
    const afterResult = await loopPost("here is the TOOL_RESULT_MARKER you asked for")
    check("`unless` stops the tool turn once its result comes back", afterResult.includes("after the tool result"), afterResult.slice(0, 160))
    check("`unless` turn does not re-emit the tool call", !afterResult.includes('"tool_calls"'))
    loopChild.kill()

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`)
    check("models endpoint responds 200", models.status === 200, `got ${models.status}`)

    // A toolless request must NOT consume a tool turn. OpenCode's title generator
    // sends `tools: {}` as the first request of every session; letting it eat the
    // tool turn makes the real turn fall through to text and the flow never runs.
    const titleGenScript = JSON.stringify([
      { tool: "task", args: { description: "d" }, when: "TITLE_CASE" },
      { text: "text turn" },
    ])
    const tgChild = spawn("node", [mock], { env: { ...process.env, MOCK_SCRIPT: titleGenScript, MOCK_PORT: "0" } })
    const tgPort = await new Promise((resolve) => {
      tgChild.stdout.on("data", (b) => {
        const m = String(b).match(/MOCK_LISTENING (\d+)/)
        if (m) resolve(Number(m[1]))
      })
    })
    const tgPost = async (content, tools) => {
      const r = await fetch(`http://127.0.0.1:${tgPort}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, tools, messages: [{ role: "user", content }] }),
      })
      return await r.text()
    }
    // capture + interpolate: the blocked flow's final hop can only be scripted if a
    // runtime-minted id can be lifted out of one request and injected into a later turn.
    const capScript = JSON.stringify([
      {
        when: "BACKGROUND TASK BLOCKED",
        capture: { child: 'task_id=\\\\"(ses_[A-Za-z0-9]+)\\\\"' },
        tool: "task",
        args: { task_id: "{{child}}", prompt: "answer" },
      },
      { text: "no capture yet" },
    ])
    const capChild = spawn("node", [mock], { env: { ...process.env, MOCK_SCRIPT: capScript, MOCK_PORT: "0" } })
    const capPort = await new Promise((resolve) => {
      capChild.stdout.on("data", (b) => {
        const m = String(b).match(/MOCK_LISTENING (\d+)/)
        if (m) resolve(Number(m[1]))
      })
    })
    const capPost = async (content) => {
      const r = await fetch(`http://127.0.0.1:${capPort}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, tools: SOME_TOOLS, messages: [{ role: "user", content }] }),
      })
      return await r.text()
    }
    const beforeCapture = await capPost("nothing interesting here")
    check("turn needing an uncaptured id is skipped", beforeCapture.includes("no capture yet"), beforeCapture.slice(0, 140))
    const wake = 'a wake saying [BACKGROUND TASK BLOCKED] with task_id="ses_ABC123xyz" inside'
    const afterCapture = await capPost(wake)
    check("capture lifts the runtime id out of the wake", afterCapture.includes("ses_ABC123xyz"), afterCapture.slice(0, 220))
    check("interpolated turn emits a real tool call", afterCapture.includes('"name":"task"'))
    check("no unexpanded placeholder leaks downstream", !afterCapture.includes("{{child}}"))
    capChild.kill()

    const toolless = await tgPost("TITLE_CASE", [])
    check("toolless request does not consume the tool turn", !toolless.includes('"tool_calls"'), toolless.slice(0, 140))
    const withTools = await tgPost("TITLE_CASE", SOME_TOOLS)
    check("the tool turn survives for the request that actually offers tools", withTools.includes('"name":"task"'), withTools.slice(0, 160))
    tgChild.kill()
  } catch (error) {
    check("self-test ran without throwing", false, String(error))
  } finally {
    child.kill()
    console.log(failures.length === 0 ? "\nSELF-TEST PASS" : `\nSELF-TEST FAIL (${failures.length}): ${failures.join(", ")}`)
    process.exit(failures.length === 0 ? 0 : 1)
  }
})

child.stderr.on("data", (buf) => process.stderr.write(buf))
setTimeout(() => { child.kill(); console.log("SELF-TEST FAIL: timeout"); process.exit(1) }, 20000)
