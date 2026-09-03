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

  it("#given existing symlink escaping root #when canonicalized #then reports outside", () => {
    //#given
    const tempDir = mkdtempSync(join(tmpdir(), "path-containment-test-"))
    const externalDir = join(tempDir, "external")
    const root = join(tempDir, "root")
    mkdirSync(externalDir)
    mkdirSync(root)
    symlinkSync(externalDir, join(root, "linked"))

    try {
      //#when
      const result = isPathInsideDirectory(toCanonicalPath(join(root, "linked")), toCanonicalPath(root))

      //#then
      expect(result).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("#given missing child under symlinked parent #when canonicalized #then reports outside", () => {
    //#given
    const tempDir = mkdtempSync(join(tmpdir(), "path-containment-test-"))
    const externalDir = join(tempDir, "external")
    const root = join(tempDir, "root")
    mkdirSync(externalDir)
    mkdirSync(root)
    symlinkSync(externalDir, join(root, "linked"))

    try {
      //#when
      const target = toCanonicalPath(join(root, "linked", "missing.txt"))
      const result = isPathInsideDirectory(target, toCanonicalPath(root))

      //#then
      expect(target).toBe(join(toCanonicalPath(externalDir), "missing.txt"))
      expect(result).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("#given path inside canonical root #when checked #then reports inside", () => {
    //#given
    const tempDir = mkdtempSync(join(tmpdir(), "path-containment-test-"))
    const root = join(tempDir, "root")
    mkdirSync(root)

    try {
      //#when
      const result = isPathInsideDirectory(toCanonicalPath(join(root, "child.txt")), toCanonicalPath(root))

      //#then
      expect(result).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
