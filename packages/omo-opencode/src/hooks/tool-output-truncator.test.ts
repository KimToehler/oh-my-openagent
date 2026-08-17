import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test"
import { createToolOutputTruncatorHook } from "./tool-output-truncator"
import * as dynamicTruncator from "../shared/dynamic-truncator"

describe("createToolOutputTruncatorHook", () => {
  let hook: ReturnType<typeof createToolOutputTruncatorHook>
  let truncateSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    truncateSpy = spyOn(dynamicTruncator, "createDynamicTruncator").mockReturnValue({
      truncate: mock(async (_sessionID: string, output: string, options?: { targetMaxTokens?: number }) => ({
        result: output,
        truncated: false,
        targetMaxTokens: options?.targetMaxTokens,
      })),
      getUsage: mock(async () => null),
      truncateSync: mock(() => ({ result: "", truncated: false })),
    })
    hook = createToolOutputTruncatorHook({} as never)
  })

  it("passes modelContextLimitsCache through to createDynamicTruncator", () => {
    const ctx = {} as never
    const modelContextLimitsCache = new Map<string, number>()
    const modelCacheState = {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    }

    truncateSpy.mockClear()
    createToolOutputTruncatorHook(ctx, { modelCacheState })

    expect(truncateSpy).toHaveBeenLastCalledWith(ctx, modelCacheState)
  })

  describe("tool.execute.after", () => {
    const createInput = (tool: string) => ({
      tool,
      sessionID: "test-session",
      callID: "test-call-id",
    })

    const createOutput = (outputText: string) => ({
      title: "Result",
      output: outputText,
      metadata: {},
    })

    describe("#given webfetch tool", () => {
      describe("#when output is processed", () => {
        it("#then should use aggressive truncation limit (10k tokens)", async () => {
          const truncateMock = mock(async (_sessionID: string, _output: string, options?: { targetMaxTokens?: number }) => ({
            result: "truncated",
            truncated: true,
            targetMaxTokens: options?.targetMaxTokens,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("webfetch")
          const output = createOutput("large content")

          await hook["tool.execute.after"](input, output)

          expect(truncateMock).toHaveBeenCalledWith(
            "test-session",
            "large content",
            { targetMaxTokens: 10_000 }
          )
        })
      })

      describe("#when using WebFetch variant", () => {
        it("#then should also use aggressive truncation limit", async () => {
          const truncateMock = mock(async (_sessionID: string, _output: string, options?: { targetMaxTokens?: number }) => ({
            result: "truncated",
            truncated: true,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("WebFetch")
          const output = createOutput("large content")

          await hook["tool.execute.after"](input, output)

          expect(truncateMock).toHaveBeenCalledWith(
            "test-session",
            "large content",
            { targetMaxTokens: 10_000 }
          )
        })
      })
    })

    describe("#given grep tool", () => {
      describe("#when output is processed", () => {
        it("#then should use default truncation limit (50k tokens)", async () => {
          const truncateMock = mock(async (_sessionID: string, _output: string, options?: { targetMaxTokens?: number }) => ({
            result: "truncated",
            truncated: true,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("grep")
          const output = createOutput("grep output")

          await hook["tool.execute.after"](input, output)

          expect(truncateMock).toHaveBeenCalledWith(
            "test-session",
            "grep output",
            { targetMaxTokens: 50_000 }
          )
        })
      })
    })

    describe("#given truncation fails", () => {
      describe("#when output is processed", () => {
        it("#then should leave the tool output unchanged", async () => {
          // given
          const truncateMock = mock(async () => {
            throw new Error("truncation failed")
          })
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("grep")
          const output = createOutput("grep output")

          // when
          await hook["tool.execute.after"](input, output)

          // then
          expect(output.output).toBe("grep output")
        })
      })
    })

    describe("#given non-truncatable tool", () => {
      describe("#when tool is not in TRUNCATABLE_TOOLS list", () => {
        it("#then should not call truncator", async () => {
          const truncateMock = mock(async () => ({
            result: "truncated",
            truncated: true,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("Read")
          const output = createOutput("file content")

          await hook["tool.execute.after"](input, output)

          expect(truncateMock).not.toHaveBeenCalled()
        })
      })
    })

    describe("#given an MCP tool whose text lives in content[]", () => {
      const createMcpOutput = (outputText: string) => ({
        title: "",
        metadata: {},
        content: [{ type: "text", text: outputText }],
      })

      describe("#when a listed MCP tool is processed", () => {
        it("#then should truncate lsp_diagnostics and write back into content[]", async () => {
          // given
          const truncateMock = mock(async (_sessionID: string, _output: string, options?: { targetMaxTokens?: number }) => ({
            result: "truncated",
            truncated: true,
            targetMaxTokens: options?.targetMaxTokens,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("lsp_diagnostics")
          const output = createMcpOutput("huge diagnostics payload")

          // when
          await hook["tool.execute.after"](input, output as never)

          // then
          expect(truncateMock).toHaveBeenCalledWith(
            "test-session",
            "huge diagnostics payload",
            { targetMaxTokens: 50_000 }
          )
          expect(output.content).toEqual([{ type: "text", text: "truncated" }])
        })
      })

      describe("#when truncate_all_tool_outputs is enabled", () => {
        it("#then should truncate unlisted MCP tools too", async () => {
          // given
          const truncateMock = mock(async () => ({
            result: "truncated",
            truncated: true,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never, {
            experimental: { truncate_all_tool_outputs: true },
          })

          const input = createInput("context7_query-docs")
          const output = createMcpOutput("huge docs payload")

          // when
          await hook["tool.execute.after"](input, output as never)

          // then
          expect(truncateMock).toHaveBeenCalled()
          expect(output.content).toEqual([{ type: "text", text: "truncated" }])
        })
      })

      describe("#when the truncator reports no truncation", () => {
        it("#then should leave content[] untouched", async () => {
          // given
          const truncateMock = mock(async (_sessionID: string, output: string) => ({
            result: output,
            truncated: false,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never)

          const input = createInput("lsp_diagnostics")
          const output = createMcpOutput("small payload")

          // when
          await hook["tool.execute.after"](input, output as never)

          // then
          expect(output.content).toEqual([{ type: "text", text: "small payload" }])
        })
      })
    })

    describe("#given truncate_all_tool_outputs enabled", () => {
      describe("#when any tool output is processed", () => {
        it("#then should truncate non-listed tools too", async () => {
          const truncateMock = mock(async (_sessionID: string, _output: string, options?: { targetMaxTokens?: number }) => ({
            result: "truncated",
            truncated: true,
          }))
          truncateSpy.mockReturnValue({
            truncate: truncateMock,
            getUsage: mock(async () => null),
            truncateSync: mock(() => ({ result: "", truncated: false })),
          })
          hook = createToolOutputTruncatorHook({} as never, {
            experimental: { truncate_all_tool_outputs: true },
          })

          const input = createInput("Read")
          const output = createOutput("file content")

          await hook["tool.execute.after"](input, output)

          expect(truncateMock).toHaveBeenCalled()
        })
      })
    })
  })
})
