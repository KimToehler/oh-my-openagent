#!/usr/bin/env node
// Real-harness probe: speaks MCP over stdio to the QA server, takes the RAW
// result object exactly as opencode hands it to `tool.execute.after` for an MCP
// tool, runs the BUILT plugin's tool-output-truncator over it, then reproduces
// opencode's post-hook normalization (output rebuilt from content[]) to prove
// what the model actually receives.

import { spawn } from "node:child_process"
import readline from "node:readline"
import { pathToFileURL } from "node:url"

const TRUNCATOR_PATH = process.argv[2]
if (!TRUNCATOR_PATH) {
  console.error("usage: probe.mjs <path-to-tool-output-truncator.ts>")
  process.exit(2)
}

function rpc(child, rl, method, params, id) {
  return new Promise((resolve) => {
    const onLine = (line) => {
      if (!line.trim()) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === id) {
        rl.off("line", onLine)
        resolve(msg.result)
      }
    }
    rl.on("line", onLine)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}

const child = spawn("node", [new URL("./huge-mcp-server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
})
const rl = readline.createInterface({ input: child.stdout })

await rpc(child, rl, "initialize", { protocolVersion: "2024-11-05", capabilities: {} }, 1)
const toolsList = await rpc(child, rl, "tools/list", {}, 2)
const rawResult = await rpc(child, rl, "tools/call", { name: "diagnostics", arguments: {} }, 3)
child.kill()

console.log("=== MCP server advertised tools ===")
console.log(toolsList.tools.map((t) => t.name).join(", "))

// This object is byte-for-byte what opencode passes as the `output` argument of
// tool.execute.after on the MCP path: the raw MCP result. Note: NO `.output`.
const hookPayload = { ...rawResult, metadata: {}, title: "" }

// Capture BEFORE the hook: the spread is shallow, so hookPayload.content[0] IS
// rawResult.content[0] and the hook mutates it in place.
const originalLength = rawResult.content[0].text.length
const originalLines = rawResult.content[0].text.split("\n").length

console.log("\n=== payload as the hook receives it (MCP path) ===")
console.log("has .output          :", Object.hasOwn(hookPayload, "output"))
console.log("typeof .output       :", typeof hookPayload.output)
console.log("content[] blocks     :", hookPayload.content.length)
console.log("content[0].text chars:", hookPayload.content[0].text.length)
console.log("content[0].text lines:", hookPayload.content[0].text.split("\n").length)

const { createToolOutputTruncatorHook } = await import(pathToFileURL(TRUNCATOR_PATH).href)

// Force truncation deterministically: no live server, so getContextWindowUsage
// returns null and dynamicTruncate falls back to the targetMaxTokens path.
const ctx = {
  client: {
    session: {
      messages: async () => {
        throw new Error("no live session in probe")
      },
    },
  },
}

const hook = createToolOutputTruncatorHook(ctx)
await hook["tool.execute.after"](
  { tool: "lsp_diagnostics", sessionID: "qa-probe-session", callID: "qa-call" },
  hookPayload,
)

console.log("\n=== after the hook ran ===")
console.log("content[0].text chars:", hookPayload.content[0].text.length)
console.log("content[0].text lines:", hookPayload.content[0].text.split("\n").length)

// Reproduce opencode's normalization that happens AFTER every plugin hook:
//   let q=[]; for (M of m.content) if (M.type==="text") q.push(M.text)
//   output: <truncated join of q>
const modelReceives = hookPayload.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n")

console.log("\n=== what the model actually receives ===")
console.log("chars                :", modelReceives.length)
console.log("lines                :", modelReceives.split("\n").length)
console.log("header preserved     :", modelReceives.includes("QA_MCP_HEADER_LINE_1"))
console.log("truncation marker    :", /truncated due to context window limit/.test(modelReceives))
console.log("tail sentinel gone   :", !modelReceives.includes("QA_MCP_TAIL_SENTINEL"))
console.log("\n--- first 3 lines ---")
console.log(modelReceives.split("\n").slice(0, 3).join("\n"))
console.log("--- last 2 lines ---")
console.log(modelReceives.split("\n").slice(-2).join("\n"))

console.log("\n=== shrink ===")
console.log(`chars ${originalLength} -> ${modelReceives.length}`)
console.log(`lines ${originalLines} -> ${modelReceives.split("\n").length}`)

const ok =
  modelReceives.length < originalLength &&
  modelReceives.includes("QA_MCP_HEADER_LINE_1") &&
  /truncated due to context window limit/.test(modelReceives) &&
  !modelReceives.includes("QA_MCP_TAIL_SENTINEL")

console.log("\nRESULT:", ok ? "PASS - MCP content[] truncation propagates" : "FAIL")
process.exit(ok ? 0 : 1)
