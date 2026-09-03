import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { createHashlineEditTool } from "./tools"
import { computeLineHash } from "./hash-computation"
import { canonicalizeFileText } from "./file-text-canonicalization"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

function createMockContext(options?: {
  directory?: string
  worktree?: string
  ask?: ToolContext["ask"]
  metadata?: ToolContext["metadata"]
}): ToolContext {
  return unsafeTestValue<ToolContext>({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: options?.directory ?? process.cwd(),
    worktree: options?.worktree ?? options?.directory ?? process.cwd(),
    abort: new AbortController().signal,
    metadata: options?.metadata ?? mock(() => {}),
    ask: options?.ask ?? (async () => {}),
  })
}

describe("createHashlineEditTool", () => {
  let tempDir: string
  let tool: ReturnType<typeof createHashlineEditTool>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hashline-edit-test-"))
    tool = createHashlineEditTool()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("applies replace with single LINE#ID anchor", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2\nline3")
    const hash = computeLineHash(2, "line2")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: `2#${hash}`, lines: "modified line2" }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nmodified line2\nline3")
    expect(result).toBe(`Updated ${filePath}`)
  })

  it("applies ranged replace and anchored append", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2\nline3\nline4")
    const line2Hash = computeLineHash(2, "line2")
    const line3Hash = computeLineHash(3, "line3")
    const line4Hash = computeLineHash(4, "line4")

    //#when
    await tool.execute(
      {
        filePath,
        edits: [
          {
            op: "replace",
            pos: `2#${line2Hash}`,
            end: `3#${line3Hash}`,
            lines: "replaced",
          },
          {
            op: "append",
            pos: `4#${line4Hash}`,
            lines: "inserted",
          },
        ],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nreplaced\nline4\ninserted")
  })

  it("returns mismatch error on stale anchor", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: "1#ZZ", lines: "new" }],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("Error")
    expect(result).toContain(">>>")
  })

  it("does not classify invalid pos format as hash mismatch", async () => {
    //#given
    const filePath = path.join(tempDir, "invalid-format.txt")
    fs.writeFileSync(filePath, "line1\nline2")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: "42", lines: "updated" }],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("Error")
    expect(result.toLowerCase()).not.toContain("hash mismatch")
  })

  it("preserves literal backslash-n and supports string[] payload", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2")
    const line1Hash = computeLineHash(1, "line1")

    //#when
    await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: `1#${line1Hash}`, lines: "join(\\n)" }],
      },
      createMockContext(),
    )

    await tool.execute(
      {
        filePath,
        edits: [{ op: "append", pos: `1#${computeLineHash(1, "join(\\n)")}`, lines: ["a", "b"] }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("join(\\n)\na\nb\nline2")
  })

  it("supports anchored prepend and anchored append", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2\nline3")
    const line1 = computeLineHash(1, "line1")
    const line3 = computeLineHash(3, "line3")

    //#when
    await tool.execute(
      {
        filePath,
        edits: [
          { op: "prepend", pos: `3#${line3}`, lines: ["before3"] },
          { op: "append", pos: `1#${line1}`, lines: ["between"] },
        ],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nbetween\nline2\nbefore3\nline3")
  })

  it("returns error when insert text is empty array", async () => {
    //#given
    const filePath = path.join(tempDir, "test.txt")
    fs.writeFileSync(filePath, "line1\nline2")
    const line1 = computeLineHash(1, "line1")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "append", pos: `1#${line1}`, lines: [] }],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("Error")
    expect(result).toContain("non-empty")
  })

  it("supports file rename with edits", async () => {
    //#given
    const filePath = path.join(tempDir, "source.txt")
    const renamedPath = path.join(tempDir, "renamed.txt")
    fs.writeFileSync(filePath, "line1\nline2")
    const line2 = computeLineHash(2, "line2")

    //#when
    const result = await tool.execute(
      {
        filePath,
        rename: renamedPath,
        edits: [{ op: "replace", pos: `2#${line2}`, lines: "line2-updated" }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.readFileSync(renamedPath, "utf-8")).toBe("line1\nline2-updated")
    expect(result).toBe(`Moved ${filePath} to ${renamedPath}`)
  })

  it("supports file delete mode", async () => {
    //#given
    const filePath = path.join(tempDir, "delete-me.txt")
    fs.writeFileSync(filePath, "line1")

    //#when
    const result = await tool.execute(
      {
        filePath,
        delete: true,
        edits: [],
      },
      createMockContext(),
    )

    //#then
    expect(fs.existsSync(filePath)).toBe(false)
    expect(result).toContain("Successfully deleted")
  })

  it("creates missing file with append and prepend", async () => {
    //#given
    const filePath = path.join(tempDir, "created.txt")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [
          { op: "append", lines: ["line2"] },
          { op: "prepend", lines: ["line1"] },
        ],
      },
      createMockContext(),
    )

    //#then
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nline2")
    expect(result).toBe(`Updated ${filePath}`)
  })

  it("accepts replace with one anchor", async () => {
    //#given
    const filePath = path.join(tempDir, "degrade.txt")
    fs.writeFileSync(filePath, "line1\nline2\nline3")
    const line2Hash = computeLineHash(2, "line2")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: `2#${line2Hash}`, lines: ["line2-updated"] }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nline2-updated\nline3")
    expect(result).toBe(`Updated ${filePath}`)
  })

  it("accepts anchored append using end alias", async () => {
    //#given
    const filePath = path.join(tempDir, "alias.txt")
    fs.writeFileSync(filePath, "line1\nline2")
    const line1Hash = computeLineHash(1, "line1")

    //#when
    await tool.execute(
      {
        filePath,
        edits: [{ op: "append", end: `1#${line1Hash}`, lines: ["inserted"] }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\ninserted\nline2")
  })

  it("preserves BOM and CRLF through hashline_edit", async () => {
    //#given
    const filePath = path.join(tempDir, "crlf-bom.txt")
    const bomCrLf = "\uFEFFline1\r\nline2\r\n"
    fs.writeFileSync(filePath, bomCrLf)
    const line2Hash = computeLineHash(2, "line2")

    //#when
    await tool.execute(
      {
        filePath,
        edits: [{ op: "replace", pos: `2#${line2Hash}`, lines: "line2-updated" }],
      },
      createMockContext(),
    )

    //#then
    const bytes = fs.readFileSync(filePath)
    expect(bytes[0]).toBe(0xef)
    expect(bytes[1]).toBe(0xbb)
    expect(bytes[2]).toBe(0xbf)
    expect(bytes.toString("utf-8")).toBe("\uFEFFline1\r\nline2-updated\r\n")
  })

  it("detects LF as line ending when LF appears before CRLF", () => {
    //#given
    const content = "line1\nline2\r\nline3"

    //#when
    const envelope = canonicalizeFileText(content)

    //#then
    expect(envelope.lineEnding).toBe("\n")
  })

  it("detects CRLF as line ending when CRLF appears before LF", () => {
    //#given
    const content = "line1\r\nline2\nline3"

    //#when
    const envelope = canonicalizeFileText(content)

    //#then
    expect(envelope.lineEnding).toBe("\r\n")
  })

  it("rejects delete=true with non-empty edits before normalization", async () => {
    //#given
    const filePath = path.join(tempDir, "delete-reject.txt")
    fs.writeFileSync(filePath, "line1")

    //#when
    const result = await tool.execute(
      {
        filePath,
        delete: true,
        edits: [{ op: "replace", pos: "1#ZZ", lines: "bad" }],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("delete mode requires edits to be an empty array")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("rejects delete=true combined with rename", async () => {
    //#given
    const filePath = path.join(tempDir, "delete-rename.txt")
    fs.writeFileSync(filePath, "line1")

    //#when
    const result = await tool.execute(
      {
        filePath,
        delete: true,
        rename: path.join(tempDir, "new-name.txt"),
        edits: [],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("delete and rename cannot be used together")
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it("rejects missing file creation with anchored append", async () => {
    //#given
    const filePath = path.join(tempDir, "nonexistent.txt")

    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "append", pos: "1#ZZ", lines: ["bad"] }],
      },
      createMockContext(),
    )

    //#then
    expect(result).toContain("File not found")
  })

  it("allows missing file creation with unanchored append", async () => {
    //#given
    const filePath = path.join(tempDir, "newfile.txt")
    
    //#when
    const result = await tool.execute(
      {
        filePath,
        edits: [{ op: "append", lines: ["created"] }],
      },
      createMockContext(),
    )

    //#then
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe("created")
    expect(result).toBe(`Updated ${filePath}`)
  })

  it("#given relative file path #when hashline edit executes #then resolves against context directory", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const main = path.join(tempDir, "main")
    const relativePath = "nested/file.txt"
    const worktreePath = path.join(worktree, relativePath)
    const mainPath = path.join(main, relativePath)
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    fs.mkdirSync(path.dirname(mainPath), { recursive: true })
    fs.writeFileSync(worktreePath, "worktree")
    fs.writeFileSync(mainPath, "main")
    const hash = computeLineHash(1, "worktree")

    //#when
    const result = await tool.execute(
      { filePath: relativePath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: worktree, worktree }),
    )

    //#then
    expect(result).toBe(`Updated ${worktreePath}`)
    expect(fs.readFileSync(worktreePath, "utf8")).toBe("updated")
    expect(fs.readFileSync(mainPath, "utf8")).toBe("main")
  })

  it("#given external file #when permission is denied #then leaves target untouched", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const externalPath = path.join(tempDir, "external.txt")
    fs.mkdirSync(worktree)
    fs.writeFileSync(externalPath, "external")
    const ask = mock(async () => { throw new Error("denied") })
    const hash = computeLineHash(1, "external")

    //#when
    const result = await tool.execute(
      { filePath: externalPath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe(`Error: denied`)
    expect(fs.readFileSync(externalPath, "utf8")).toBe("external")
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith({
      permission: "edit",
      patterns: [externalPath],
      always: ["*"],
      metadata: { filepath: externalPath },
    })
  })

  it("#given external rename destination #when permission is denied #then source remains untouched", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const sourcePath = path.join(worktree, "source.txt")
    const externalPath = path.join(tempDir, "external.txt")
    fs.mkdirSync(worktree)
    fs.writeFileSync(sourcePath, "source")
    const ask = mock(async () => { throw new Error("denied") })
    const hash = computeLineHash(1, "source")

    //#when
    const result = await tool.execute(
      { filePath: sourcePath, rename: externalPath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe(`Error: denied`)
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("source")
    expect(fs.existsSync(externalPath)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("#given granted external file #when hashline edit executes #then updates exact external file", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const externalPath = path.join(tempDir, "external.txt")
    const internalPath = path.join(worktree, "external.txt")
    fs.mkdirSync(worktree)
    fs.writeFileSync(externalPath, "external")
    fs.writeFileSync(internalPath, "internal")
    const ask = mock(async () => {})
    const hash = computeLineHash(1, "external")

    //#when
    const result = await tool.execute(
      { filePath: externalPath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe(`Updated ${externalPath}`)
    expect(fs.readFileSync(externalPath, "utf8")).toBe("updated")
    expect(fs.readFileSync(internalPath, "utf8")).toBe("internal")
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("#given symlink inside worktree targeting external file #when permission is denied #then external target remains unchanged", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const externalPath = path.join(tempDir, "external.txt")
    const linkedPath = path.join(worktree, "linked.txt")
    fs.mkdirSync(worktree)
    fs.writeFileSync(externalPath, "external")
    fs.symlinkSync(externalPath, linkedPath)
    const ask = mock(async () => { throw new Error("denied") })
    const hash = computeLineHash(1, "external")

    //#when
    const result = await tool.execute(
      { filePath: linkedPath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe("Error: denied")
    expect(fs.readFileSync(externalPath, "utf8")).toBe("external")
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("#given missing path through symlinked parent outside worktree #when permission is denied #then file is not created", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const externalDir = path.join(tempDir, "external")
    const linkedParent = path.join(worktree, "linked")
    const externalPath = path.join(externalDir, "created.txt")
    fs.mkdirSync(worktree)
    fs.mkdirSync(externalDir)
    fs.symlinkSync(externalDir, linkedParent)
    const ask = mock(async () => { throw new Error("denied") })

    //#when
    const result = await tool.execute(
      { filePath: path.join(linkedParent, "created.txt"), edits: [{ op: "append", lines: "created" }] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe("Error: denied")
    expect(fs.existsSync(externalPath)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("#given delete target outside accepted worktree #when permission is denied #then file remains", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const externalPath = path.join(tempDir, "external.txt")
    fs.mkdirSync(worktree)
    fs.writeFileSync(externalPath, "external")
    const ask = mock(async () => { throw new Error("denied") })

    //#when
    const result = await tool.execute(
      { filePath: externalPath, delete: true, edits: [] },
      createMockContext({ directory: worktree, worktree, ask }),
    )

    //#then
    expect(result).toBe("Error: denied")
    expect(fs.readFileSync(externalPath, "utf8")).toBe("external")
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("#given path inside worktree but outside nested session directory #when hashline edit executes #then treats path as internal", async () => {
    //#given
    const worktree = path.join(tempDir, "worktree")
    const sessionDirectory = path.join(worktree, "nested", "session")
    const filePath = path.join(worktree, "outside-session.txt")
    fs.mkdirSync(sessionDirectory, { recursive: true })
    fs.writeFileSync(filePath, "worktree")
    const ask = mock(async () => {})
    const hash = computeLineHash(1, "worktree")

    //#when
    const result = await tool.execute(
      { filePath, edits: [{ op: "replace", pos: `1#${hash}`, lines: "updated" }] },
      createMockContext({ directory: sessionDirectory, worktree, ask }),
    )

    //#then
    expect(result).toBe(`Updated ${filePath}`)
    expect(fs.readFileSync(filePath, "utf8")).toBe("updated")
    expect(ask).not.toHaveBeenCalled()
  })
})
