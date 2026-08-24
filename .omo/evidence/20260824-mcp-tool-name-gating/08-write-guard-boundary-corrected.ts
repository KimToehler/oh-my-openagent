import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { handleWriteExistingFileGuardToolExecuteBefore } from "/Users/tim/git/oh-my-openagent/packages/omo-opencode/src/hooks/write-existing-file-guard/tool-execute-before-handler"

// canonicalize the root, which the previous probe did NOT do
const directory = realpathSync(mkdtempSync(join(tmpdir(), "omo-guard-probe2-")))
const filePath = join(directory, "unread-existing.txt")
writeFileSync(filePath, "protected content\n")

async function run(tool: string) {
  try {
    await handleWriteExistingFileGuardToolExecuteBefore({
      ctx: { directory } as never,
      input: { tool, sessionID: "qa-session" },
      output: { args: { filePath, content: "blocked content" } },
      readPermissionsBySession: new Map(),
      sessionLastAccess: new Map(),
      getCanonicalSessionRoot: () => directory,
      maxTrackedSessions: 10,
    })
    console.log(`${tool}: NOT BLOCKED`)
  } catch (e) {
    console.log(`${tool}: BLOCKED (${e instanceof Error ? e.message : String(e)})`)
  }
}

await run("write")
await run("mcp__foo__write")
await run("todowrite")
rmSync(directory, { recursive: true, force: true })
