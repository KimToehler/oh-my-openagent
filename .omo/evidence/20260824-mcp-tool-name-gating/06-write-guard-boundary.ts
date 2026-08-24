import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { handleWriteExistingFileGuardToolExecuteBefore } from "../../../packages/omo-opencode/src/hooks/write-existing-file-guard/tool-execute-before-handler"

const directory = mkdtempSync(join(tmpdir(), "omo-mcp-guard-boundary-"))
const filePath = join(directory, "unread-existing.txt")
writeFileSync(filePath, "protected content\n")

try {
  await handleWriteExistingFileGuardToolExecuteBefore({
    ctx: { directory } as never,
    input: { tool: "mcp__foo__write", sessionID: "qa-session" },
    output: { args: { filePath, content: "blocked content" } },
    readPermissionsBySession: new Map(),
    sessionLastAccess: new Map(),
    getCanonicalSessionRoot: () => directory,
    maxTrackedSessions: 10,
  })
  console.error("FAIL: mcp__foo__write returned without blocking")
  process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message !== "File already exists. Use edit tool instead.") {
    console.error(`FAIL: unexpected error: ${message}`)
    process.exitCode = 1
  } else {
    console.log("PASS: mcp__foo__write blocked unread existing file")
    console.log(`error=${message}`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
