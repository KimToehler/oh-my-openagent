import { describe, expect, it } from "bun:test"

import { applyToolOutputText, resolveToolOutputText } from "./tool-output-text"

describe("resolveToolOutputText", () => {
  it("#given a native payload #when resolving #then the output string is returned unchanged", () => {
    expect(resolveToolOutputText({ output: "BUILD SUCCESSFUL" })).toBe("BUILD SUCCESSFUL")
  })

  it("#given a native payload with empty output #when resolving #then the empty string is preserved", () => {
    expect(resolveToolOutputText({ output: "" })).toBe("")
  })

  it("#given an MCP payload #when resolving #then the text block is returned", () => {
    expect(
      resolveToolOutputText({
        content: [{ type: "text", text: "[background:shell_1234abcd5678ef90 started]" }],
      })
    ).toBe("[background:shell_1234abcd5678ef90 started]")
  })

  it("#given an MCP payload with several text blocks #when resolving #then they are newline joined", () => {
    expect(
      resolveToolOutputText({
        content: [
          { type: "text", text: "[background:shell_1234abcd5678ef90 completed]" },
          { type: "text", text: "BUILD SUCCESSFUL" },
        ],
      })
    ).toBe("[background:shell_1234abcd5678ef90 completed]\nBUILD SUCCESSFUL")
  })

  it("#given an MCP payload mixing image and text blocks #when resolving #then only text is kept", () => {
    expect(
      resolveToolOutputText({
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "done" },
        ],
      })
    ).toBe("done")
  })

  it("#given both shapes #when resolving #then the native output wins", () => {
    expect(
      resolveToolOutputText({
        output: "native",
        content: [{ type: "text", text: "mcp" }],
      })
    ).toBe("native")
  })

  it("#given an MCP payload with no text blocks #when resolving #then undefined is returned", () => {
    expect(
      resolveToolOutputText({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })
    ).toBeUndefined()
  })

  it("#given an empty or malformed payload #when resolving #then undefined is returned", () => {
    expect(resolveToolOutputText(undefined)).toBeUndefined()
    expect(resolveToolOutputText({})).toBeUndefined()
    expect(resolveToolOutputText({ content: [] })).toBeUndefined()
    expect(resolveToolOutputText({ content: "not-an-array" })).toBeUndefined()
    expect(resolveToolOutputText({ content: [null, 42, { type: "text" }] })).toBeUndefined()
  })
})

describe("applyToolOutputText", () => {
  it("#given a native payload #when applying #then output is replaced", () => {
    // given
    const payload: { output: string; content?: unknown } = { output: "original" }

    // when
    const applied = applyToolOutputText(payload, "replaced")

    // then
    expect(applied).toBe(true)
    expect(payload.output).toBe("replaced")
  })

  it("#given an MCP payload #when applying #then the single text block is rewritten", () => {
    // given
    const payload = { content: [{ type: "text", text: "original" }] }

    // when
    const applied = applyToolOutputText(payload, "replaced")

    // then
    expect(applied).toBe(true)
    expect(payload.content).toEqual([{ type: "text", text: "replaced" }])
  })

  it("#given an MCP payload with several text blocks #when applying #then the first holds the text and the rest are emptied", () => {
    // given
    const payload = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }

    // when
    const applied = applyToolOutputText(payload, "replaced")

    // then
    expect(applied).toBe(true)
    expect(payload.content).toEqual([
      { type: "text", text: "replaced" },
      { type: "text", text: "" },
    ])
  })

  it("#given an MCP payload mixing image and text #when applying #then non-text blocks are preserved", () => {
    // given
    const payload = {
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "original" },
      ],
    }

    // when
    const applied = applyToolOutputText(payload, "replaced")

    // then
    expect(applied).toBe(true)
    expect(payload.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "replaced" },
    ])
  })

  it("#given both shapes #when applying #then the native output wins and content is untouched", () => {
    // given
    const payload = { output: "native", content: [{ type: "text", text: "mcp" }] }

    // when
    const applied = applyToolOutputText(payload, "replaced")

    // then
    expect(applied).toBe(true)
    expect(payload.output).toBe("replaced")
    expect(payload.content).toEqual([{ type: "text", text: "mcp" }])
  })

  it("#given a payload with no writable target #when applying #then nothing is written", () => {
    // given
    const noTextBlocks = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }

    // when / then
    expect(applyToolOutputText(undefined, "replaced")).toBe(false)
    expect(applyToolOutputText({}, "replaced")).toBe(false)
    expect(applyToolOutputText({ content: [] }, "replaced")).toBe(false)
    expect(applyToolOutputText({ content: "not-an-array" }, "replaced")).toBe(false)
    expect(applyToolOutputText(noTextBlocks, "replaced")).toBe(false)
    expect(noTextBlocks.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }])
  })
})
