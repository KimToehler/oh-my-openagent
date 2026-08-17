import { describe, expect, it } from "bun:test"

import { resolveToolOutputText } from "./tool-output-text"

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
