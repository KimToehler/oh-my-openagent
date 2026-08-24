import type { PluginInput } from "@opencode-ai/plugin"
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const storageMaps = new Map<string, Set<string>>()

mock.module("./storage", () => ({
  loadInjectedPaths: (sessionID: string) => storageMaps.get(sessionID) ?? new Set<string>(),
  saveInjectedPaths: (sessionID: string, paths: Set<string>) => {
    storageMaps.set(sessionID, paths)
  },
  clearInjectedPaths: (sessionID: string) => {
    storageMaps.delete(sessionID)
  },
}))

afterAll(() => {
  mock.restore()
})

const SRC_README_CONTENT = "# SRC README\nsrc-level readme body"
const BASE_OUTPUT = "base output"

describe("createDirectoryReadmeInjectorHook tool matching", () => {
  let testRoot = ""
  let srcDirectory = ""

  beforeEach(() => {
    storageMaps.clear()

    testRoot = join(tmpdir(), `directory-readme-injector-hook-${randomUUID()}`)
    srcDirectory = join(testRoot, "src")
    mkdirSync(srcDirectory, { recursive: true })
    writeFileSync(join(srcDirectory, "README.md"), SRC_README_CONTENT)
    writeFileSync(join(srcDirectory, "file.ts"), "export const sourceFile = true\n")
  })

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  async function runToolExecuteAfter(
    tool: string,
    sessionID: string,
  ): Promise<{ title: string; output: string; metadata: unknown }> {
    const { createDirectoryReadmeInjectorHook } = await import("./hook")
    const ctx = { client: {}, directory: testRoot } as unknown as PluginInput
    const hook = createDirectoryReadmeInjectorHook(ctx)
    const output = {
      title: join(srcDirectory, "file.ts"),
      output: BASE_OUTPUT,
      metadata: {},
    }

    await hook["tool.execute.after"]({ tool, sessionID, callID: "call-1" }, output)
    return output
  }

  describe("#given an MCP-prefixed read tool", () => {
    describe("#when tool.execute.after reports lean-ctx_ctx_read", () => {
      it("#then injects the directory README.md", async () => {
        const output = await runToolExecuteAfter("lean-ctx_ctx_read", "session-mcp-read")

        expect(output.output).toContain("[Project README:")
        expect(output.output).toContain(SRC_README_CONTENT)
      })
    })

    describe("#when tool.execute.after reports mcp__server__read", () => {
      it("#then injects the directory README.md", async () => {
        const output = await runToolExecuteAfter("mcp__server__read", "session-mcp-double")

        expect(output.output).toContain("[Project README:")
        expect(output.output).toContain(SRC_README_CONTENT)
      })
    })
  })

  describe("#given the native read tool", () => {
    describe("#when tool.execute.after reports read", () => {
      it("#then still injects the directory README.md", async () => {
        const output = await runToolExecuteAfter("read", "session-native-read")

        expect(output.output).toContain("[Project README:")
        expect(output.output).toContain(SRC_README_CONTENT)
      })
    })
  })

  describe("#given a non-read MCP tool", () => {
    describe("#when tool.execute.after reports lean-ctx_ctx_shell", () => {
      it("#then leaves the output untouched", async () => {
        const output = await runToolExecuteAfter("lean-ctx_ctx_shell", "session-mcp-shell")

        expect(output.output).toBe(BASE_OUTPUT)
      })
    })
  })
})
