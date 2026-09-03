import { existsSync, realpathSync } from "fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "path"

export function resolveInputPath(directory: string, inputPath: string): string {
  return normalize(isAbsolute(inputPath) ? inputPath : resolve(directory, inputPath))
}

export function isPathInsideDirectory(pathToCheck: string, directory: string): boolean {
  const relativePath = relative(directory, pathToCheck)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

export function toCanonicalPath(absolutePath: string): string {
  let existingPath = absolutePath
  let suffix = ""

  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath)
    if (parent === existingPath) return normalize(absolutePath)
    suffix = join(basename(existingPath), suffix)
    existingPath = parent
  }

  try {
    return normalize(join(realpathSync.native(existingPath), suffix))
  } catch {
    return normalize(absolutePath)
  }
}
