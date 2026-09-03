import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isPathInsideDirectory, resolveInputPath, toCanonicalPath } from "./path-containment"

describe("path containment", () => {
  it("#given relative path #when resolved #then uses supplied directory", () => {
    //#given
    const directory = join(tmpdir(), "path-containment-root")

    //#when
    const result = resolveInputPath(directory, "child.txt")

    //#then
    expect(result).toBe(join(directory, "child.txt"))
  })

  it("#given sibling path sharing lexical prefix #when checked #then reports outside", () => {
    //#given
    const root = "/tmp/worktree"

    //#when
    const result = isPathInsideDirectory("/tmp/worktree-other/file.txt", root)

    //#then
    expect(result).toBe(false)
  })

  it("#given missing child under symlinked parent #when canonicalized #then resolves through symlink", () => {
    //#given
    const tempDir = mkdtempSync(join(tmpdir(), "path-containment-test-"))
    const externalDir = join(tempDir, "external")
    const root = join(tempDir, "root")
    mkdirSync(externalDir)
    mkdirSync(root)
    symlinkSync(externalDir, join(root, "linked"))

    try {
      //#when
      const result = toCanonicalPath(join(root, "linked", "missing.txt"))

      //#then
      expect(result).toBe(join(toCanonicalPath(externalDir), "missing.txt"))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
