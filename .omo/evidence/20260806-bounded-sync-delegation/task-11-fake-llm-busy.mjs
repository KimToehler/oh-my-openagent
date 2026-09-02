#!/usr/bin/env node
// Task 11 QA fake provider: a BUSY child.
//
// Difference from the bundled fake-openai-server.mjs: the child session does not
// answer in one turn. It emits a repeating `bash sleep` tool call, so the child
// session holds a continuous busy/running status well past the 60s wall-clock
// bound. That is the only shape that can trip the new bound - a child that goes
// idle quickly would never reach it, and continuous activity is precisely the
// case the pre-existing INACTIVITY window can never catch.
//
// Every branch decision is logged with a timestamp; the child branch timestamps
// after the parent's tool call returned are the child-liveness evidence.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { sendSse, textEvents, toolCallEvents, appendLog } from "/Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

const requestedPort = Number(process.env.FAKE_OPENAI_PORT ?? 0)
const logFile = process.env.FAKE_LLM_LOG ?? path.join(os.tmpdir(), "fake-llm-busy.log")
const CHILD_TURNS = Number(process.env.CHILD_TURNS ?? 20)
const CHILD_SLEEP_S = Number(process.env.CHILD_SLEEP_S ?? 6)
const PARENT_MARKER = process.env.PARENT_MARKER ?? "Run the wallclock probe"
const CHILD_MARKER = process.env.CHILD_MARKER ?? "WALLCLOCK_CHILD_TASK"
const RUN_IN_BACKGROUND = process.env.RUN_IN_BACKGROUND === "true"
// After the task tool returns, the parent holds its turn open with a long bash
// sleep. Without it `opencode run` tears the server down the instant the parent
// turn ends, leaving no observable window in which to prove the child survived.
const PARENT_HOLD_S = Number(process.env.PARENT_HOLD_S ?? 90)

let callCount = 0
let childTurns = 0
const counts = { title: 0, "parent-task-call": 0, "parent-hold": 0, "parent-final": 0, child: 0, "child-done": 0, wake: 0, default: 0 }
const latches = { parentTaskCallIssued: false, parentHoldIssued: false }
const t0 = Date.now()

function logBranch(branch, extra = {}) {
  counts[branch] = (counts[branch] ?? 0) + 1
  const line = `[${new Date().toISOString()}] t+${((Date.now() - t0) / 1000).toFixed(1)}s branch=${branch} call=${callCount}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}\n`
  appendLog(logFile, line)
  process.stdout.write(line)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function hasToolResult(s) {
  return (
    s.includes('"type":"function_call_output"') ||
    s.includes('"type": "function_call_output"') ||
    s.includes('"type":"tool_result"') ||
    s.includes('"type": "tool_result"') ||
    s.includes('"role":"tool"') ||
    s.includes('"role": "tool"')
  )
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }
  if (req.method !== "POST" || !req.url?.includes("/responses")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }))
    return
  }

  callCount++
  const raw = await readBody(req)
  let body
  try { body = JSON.parse(raw) } catch { body = {} }
  const inputStr = JSON.stringify(body.input ?? body.messages ?? body)

  const isTitle = inputStr.includes("Generate a title")
  const isParent = inputStr.includes(PARENT_MARKER)
  const isChild = inputStr.includes(CHILD_MARKER)
  const isWake = inputStr.includes("[BACKGROUND TASK")
  const hasResult = hasToolResult(inputStr)

  if (isTitle) {
    logBranch("title")
    sendSse(res, textEvents(callCount, "wallclock yield probe"))
    return
  }

  // Child session: keep emitting bash sleeps so the session stays busy past the bound.
  if (isChild && !isParent) {
    childTurns++
    if (childTurns <= CHILD_TURNS) {
      logBranch("child", { childTurn: childTurns })
      sendSse(res, toolCallEvents(callCount, "bash", `call_child_bash_${callCount}`, {
        command: `sleep ${CHILD_SLEEP_S}; echo CHILD_ALIVE_TURN_${childTurns}`,
        description: "stay busy",
      }))
      return
    }
    logBranch("child-done", { childTurn: childTurns })
    sendSse(res, textEvents(callCount, "CHILD_FINISHED_ALL_TURNS"))
    return
  }

  if (isWake) {
    logBranch("wake")
    sendSse(res, textEvents(callCount, `WAKE_ACK ${callCount}`))
    return
  }

  if (isParent && !hasResult && !latches.parentTaskCallIssued) {
    latches.parentTaskCallIssued = true
    logBranch("parent-task-call", { run_in_background: RUN_IN_BACKGROUND })
    sendSse(res, toolCallEvents(callCount, "task", `call_agent_${callCount}`, {
      description: "wallclock busy child",
      prompt: `${CHILD_MARKER}: keep working, run repeated shell sleeps until told to stop`,
      subagent_type: "explore",
      run_in_background: RUN_IN_BACKGROUND,
      load_skills: [],
    }))
    return
  }

  if (isParent && !latches.parentHoldIssued && PARENT_HOLD_S > 0) {
    latches.parentHoldIssued = true
    logBranch("parent-hold", { holdSeconds: PARENT_HOLD_S })
    sendSse(res, toolCallEvents(callCount, "bash", `call_parent_hold_${callCount}`, {
      command: `sleep ${PARENT_HOLD_S}; echo PARENT_HOLD_DONE`,
      description: "hold parent turn open so child liveness is observable",
    }))
    return
  }

  if (isParent) {
    logBranch("parent-final")
    sendSse(res, textEvents(callCount, "PARENT_TURN_ENDED"))
    return
  }

  logBranch("default")
  sendSse(res, textEvents(callCount, `fake response ${callCount}`))
})

function logFinalCounts() {
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")
  const line = `[${new Date().toISOString()}] FINAL_COUNTS ${summary} childTurns=${childTurns}\n`
  appendLog(logFile, line)
  process.stdout.write(line)
}

server.listen(requestedPort, "127.0.0.1", () => {
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : requestedPort
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    appendLog(logFile, `[${new Date().toISOString()}] START port=${port} CHILD_TURNS=${CHILD_TURNS} CHILD_SLEEP_S=${CHILD_SLEEP_S} RUN_IN_BACKGROUND=${RUN_IN_BACKGROUND}\n`)
  } catch {}
  process.stdout.write(`fake-openai listening on ${port}\n`)
})

process.on("SIGTERM", () => { logFinalCounts(); server.close(() => process.exit(0)) })
process.on("SIGINT", () => { logFinalCounts(); server.close(() => process.exit(0)) })
