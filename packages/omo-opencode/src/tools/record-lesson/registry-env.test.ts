import { afterEach, describe, expect, test } from "bun:test"
import { tool } from "@opencode-ai/plugin"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createCoreTools } from "../../plugin/tool-registry-core-tools"
import type { ToolRegistryFactories } from "../../plugin/tool-registry-factories"

const fakeTool = tool({ description: "fake", args: {}, async execute(): Promise<string> { return "ok" } })
const originalHome = process.env.HOME
const originalLessonsDir = process.env.OMO_LESSONS_DIR
const temporaryDirs: string[] = []

function createTemporaryDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(directory)
  return directory
}

function createFactories(): ToolRegistryFactories {
  return unsafeTestValue({
    createBackgroundTools: () => ({}), createCallOmoAgent: () => fakeTool, createLookAt: () => fakeTool,
    createSkillMcpTool: () => fakeTool, createSkillTool: () => fakeTool, createGrepTools: () => ({}),
    createGlobTools: () => ({}), createSessionManagerTools: () => ({}), createDelegateTask: () => fakeTool,
    discoverCommandsSync: () => [],
  })
}

async function recordLesson(projectDir: string): Promise<string> {
  const recordLessonTool = createCoreTools({
    ctx: unsafeTestValue({ directory: projectDir }),
    pluginConfig: unsafeTestValue({ disabled_agents: ["multimodal-looker"], lessons: { enabled: true, storage: "user" } }),
    managers: unsafeTestValue({ backgroundManager: {}, tmuxSessionManager: {}, skillMcpManager: {}, modelFallbackControllerAccessor: {} }),
    skillContext: { mergedSkills: [], availableSkills: [], browserProvider: "playwright", disabledSkills: new Set() },
    availableCategories: [], factories: createFactories(),
  }).record_lesson
  if (recordLessonTool === undefined) throw new Error("record_lesson was not registered")
  return recordLessonTool.execute({
    title: "Keep production environment plumbing",
    what_went_wrong: "Registry construction omitted environment variables, so user storage resolved beneath the launch directory instead of HOME. ".repeat(3),
    rule_for_next_time: "Exercise production construction paths without injecting dependencies unavailable at the real call site. ".repeat(3),
    globs: ["packages/omo-opencode/src/plugin/**/*.ts"],
    citations: ["packages/omo-opencode/src/plugin/tool-registry-core-tools.ts"],
  }, unsafeTestValue({}))
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalLessonsDir === undefined) delete process.env.OMO_LESSONS_DIR
  else process.env.OMO_LESSONS_DIR = originalLessonsDir
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("#given record_lesson is constructed by the production registry without injected env", () => {
  test("#when user storage records a lesson #then the artifact is written beneath HOME instead of cwd", async () => {
    // given
    const projectDir = process.cwd()
    const homeDir = createTemporaryDir("omo-record-lesson-home-")
    process.env.HOME = homeDir
    delete process.env.OMO_LESSONS_DIR

    // when
    const result = await recordLesson(projectDir)

    // then
    expect(result).toContain(join(homeDir, ".omo", "rules", "lessons"))
    expect(result).not.toContain(join(process.cwd(), ".omo", "rules", "lessons"))
  })

  test("#when OMO_LESSONS_DIR is set #then the artifact is written beneath the override", async () => {
    // given
    const projectDir = process.cwd()
    const overrideDir = createTemporaryDir("omo-record-lesson-override-")
    process.env.OMO_LESSONS_DIR = overrideDir

    // when
    const result = await recordLesson(projectDir)

    // then
    expect(result).toContain(overrideDir)
  })
})
