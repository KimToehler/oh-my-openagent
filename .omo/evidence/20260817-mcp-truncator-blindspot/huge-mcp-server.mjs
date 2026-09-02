#!/usr/bin/env node
// Minimal stdio MCP server for QA. Exposes one tool that returns a HUGE text
// payload in content[], so the tool-output-truncator has something oversized to
// truncate. Server name is supplied by the opencode MCP config key; the tool is
// named `diagnostics` so the composed tool name matches the truncator's
// TRUNCATABLE_TOOLS entry `lsp_diagnostics` when registered under server `lsp`.

import readline from "node:readline"

const LINES = Number(process.env.QA_MCP_LINES ?? 200000)

function hugePayload() {
  const out = []
  out.push("QA_MCP_HEADER_LINE_1")
  out.push("QA_MCP_HEADER_LINE_2")
  out.push("QA_MCP_HEADER_LINE_3")
  for (let i = 0; i < LINES; i++) {
    out.push(`QA_MCP_BODY_LINE_${i} ${"x".repeat(80)}`)
  }
  out.push("QA_MCP_TAIL_SENTINEL_SHOULD_BE_TRUNCATED_AWAY")
  return out.join("\n")
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

const rl = readline.createInterface({ input: process.stdin })

rl.on("line", (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method } = req

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "qa-huge", version: "0.0.1" },
      },
    })
    return
  }

  if (method === "notifications/initialized") return

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "diagnostics",
            description: "QA stub returning a huge payload",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    })
    return
  }

  if (method === "tools/call") {
    const payload = hugePayload()
    process.stderr.write(`[qa-mcp] returning ${payload.length} chars\n`)
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: payload }] },
    })
    return
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} })
  }
})
