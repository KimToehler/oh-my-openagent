#!/usr/bin/env node
// RW2 QA fake provider - generalized scriptable parent/child driver.
//
// Extends the task-11 busy-child provider with the knobs RW2 needs:
//   PARENT_AFTER_TASK  - what the parent does once the task tool returns:
//                          "hold"        : long bash sleep (observation window)
//                          "bg_output"   : immediately call background_output on
//                                          the bg_ id it saw (hostile: ignores
//                                          the "Do NOT call" instruction)
//                          "end"         : end the turn right away (orphan probe)
//   CHILD_TURNS/CHILD_SLEEP_S - how long the child stays continuously busy
//   TASK_COUNT         - how many task() calls the parent issues before holding
//   RUN_IN_BACKGROUND  - "true" | "false" | "omit" | any literal string, passed
//                        through verbatim so we can test schema tolerance
//   CHILD_FINAL_TEXT   - the child's final answer; used to prove RESULT DELIVERY
//                        (we then grep the parent transcript for it)
//   WAKE_ECHO=1        - on a wake (background task notification) the parent
//                        echoes the notification body back as its own text, so
//                        the delivered content lands in the parent transcript.
//
// Every branch is timestamped so the log is the evidence.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { sendSse, textEvents, toolCallEvents, appendLog } from "/Users/tim/git/oh-my-openagent/.agents/skills/opencode-qa/scripts/lib/fake-openai-events.mjs"

const requestedPort = Number(process.env.FAKE_OPENAI_PORT ?? 0)
const logFile = process.env.FAKE_LLM_LOG ?? path.join(os.tmpdir(), "rw2-fake-llm.log")
const CHILD_TURNS = Number(process.env.CHILD_TURNS ?? 20)
const CHILD_SLEEP_S = Number(process.env.CHILD_SLEEP_S ?? 6)
const PARENT_MARKER = process.env.PARENT_MARKER ?? "Run the wallclock probe"
const CHILD_MARKER = process.env.CHILD_MARKER ?? "WALLCLOCK_CHILD_TASK"
const RUN_IN_BACKGROUND = process.env.RUN_IN_BACKGROUND ?? "false"
const PARENT_AFTER_TASK = process.env.PARENT_AFTER_TASK ?? "hold"
const PARENT_HOLD_S = Number(process.env.PARENT_HOLD_S ?? 90)
const TASK_COUNT = Number(process.env.TASK_COUNT ?? 1)
const CHILD_FINAL_TEXT = process.env.CHILD_FINAL_TEXT ?? "CHILD_DELIVERABLE_PAYLOAD_9F3A"
const WAKE_ECHO = process.env.WAKE_ECHO === "1"
const CHILD_SPAWNS_BG = process.env.CHILD_SPAWNS_BG === "1"

let callCount = 0
let childTurns = 0
let tasksIssued = 0
let childBgSpawned = false
const counts = {}
const latches = { parentHoldIssued: false, bgOutputIssued: false }
const seenBgIds = []
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

// Pull every bg_ handle the transcript has ever shown the parent.
function extractBgIds(s) {
  const out = []
  const re = /bg_[0-9a-f]{8}/g
  let m
  while ((m = re.exec(s)) !== null) out.push(m[0])
  return [...new Set(out)]
}

function buildTaskCall(n) {
  const args = {
    description: `wallclock busy child ${n}`,
    prompt: `${CHILD_MARKER}_${n}: keep working, run repeated shell sleeps until told to stop`,
    subagent_type: "explore",
    load_skills: [],
  }
  if (RUN_IN_BACKGROUND !== "omit") {
    args.run_in_background = RUN_IN_BACKGROUND === "true" ? true
      : RUN_IN_BACKGROUND === "false" ? false
      : RUN_IN_BACKGROUND // literal passthrough for hostile-type tests
  }
  return args
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
    return
  }
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ counts, seenBgIds, childTurns, tasksIssued }))
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

  for (const id of extractBgIds(inputStr)) {
    if (!seenBgIds.includes(id)) seenBgIds.push(id)
  }

  if (isTitle) {
    logBranch("title")
    sendSse(res, textEvents(callCount, "rw2 wallclock probe"))
    return
  }

  // ---- child session -------------------------------------------------------
  if (isChild && !isParent) {
    // optional: child spawns its own background child on its first turn
    if (CHILD_SPAWNS_BG && !childBgSpawned) {
      childBgSpawned = true
      logBranch("child-spawn-bg")
      sendSse(res, toolCallEvents(callCount, "task", `call_child_bg_${callCount}`, {
        description: "grandchild",
        prompt: "GRANDCHILD_TASK: say done",
        subagent_type: "explore",
        run_in_background: true,
        load_skills: [],
      }))
      return
    }
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
    sendSse(res, textEvents(callCount, CHILD_FINAL_TEXT))
    return
  }

  if (inputStr.includes("GRANDCHILD_TASK")) {
    logBranch("grandchild")
    sendSse(res, textEvents(callCount, "GRANDCHILD_DONE"))
    return
  }

  // ---- wake (background task notification delivered to the parent) ---------
  if (isWake) {
    logBranch("wake", { bgIds: seenBgIds })
    // Echo a compact fingerprint of what we were told, so the delivered content
    // is observable in the parent transcript rather than only in the request.
    const gotPayload = inputStr.includes(CHILD_FINAL_TEXT)
    const text = WAKE_ECHO
      ? `WAKE_ACK payload_present=${gotPayload} bg_ids=${seenBgIds.join(",")}`
      : `WAKE_ACK ${callCount}`
    sendSse(res, textEvents(callCount, text))
    return
  }

  // ---- parent session ------------------------------------------------------
  if (isParent && tasksIssued < TASK_COUNT && (!hasResult || tasksIssued > 0)) {
    // issue TASK_COUNT task() calls back to back (first before any tool result)
    tasksIssued++
    logBranch("parent-task-call", { n: tasksIssued, run_in_background: RUN_IN_BACKGROUND })
    sendSse(res, toolCallEvents(callCount, "task", `call_agent_${callCount}`, buildTaskCall(tasksIssued)))
    return
  }

  if (isParent && PARENT_AFTER_TASK === "bg_output" && !latches.bgOutputIssued && seenBgIds.length > 0) {
    latches.bgOutputIssued = true
    logBranch("parent-bg-output", { bgId: seenBgIds[seenBgIds.length - 1] })
    sendSse(res, toolCallEvents(callCount, "background_output", `call_bgout_${callCount}`, {
      task_id: seenBgIds[seenBgIds.length - 1],
    }))
    return
  }

  if (isParent && PARENT_AFTER_TASK === "hold" && !latches.parentHoldIssued && PARENT_HOLD_S > 0) {
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
    sendSse(res, textEvents(callCount, `PARENT_TURN_ENDED bg_ids=${seenBgIds.join(",")}`))
    return
  }

  logBranch("default")
  sendSse(res, textEvents(callCount, `fake response ${callCount}`))
})

function logFinalCounts() {
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")
  const line = `[${new Date().toISOString()}] FINAL_COUNTS ${summary} childTurns=${childTurns} seenBgIds=${seenBgIds.join(",")}\n`
  appendLog(logFile, line)
  process.stdout.write(line)
}

server.listen(requestedPort, "127.0.0.1", () => {
  const addr = server.address()
  const port = typeof addr === "object" && addr !== null ? addr.port : requestedPort
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    appendLog(logFile, `[${new Date().toISOString()}] START port=${port} CHILD_TURNS=${CHILD_TURNS} CHILD_SLEEP_S=${CHILD_SLEEP_S} RUN_IN_BACKGROUND=${RUN_IN_BACKGROUND} PARENT_AFTER_TASK=${PARENT_AFTER_TASK} TASK_COUNT=${TASK_COUNT}\n`)
  } catch {}
  process.stdout.write(`fake-openai listening on ${port}\n`)
})

process.on("SIGTERM", () => { logFinalCounts(); server.close(() => process.exit(0)) })
process.on("SIGINT", () => { logFinalCounts(); server.close(() => process.exit(0)) })
