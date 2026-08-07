import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { createLogger } from "./logger"

const TEST_PREFIX = "omo-utils-logger-runtime-id"

// The QA scripts under .agents/skills/opencode-qa/scripts/ pull the ISO timestamp
// out of a log line with a bare-bracket-class grep. This mirrors that shape so a
// future prefix edit that shadows the timestamp fails here instead of in the shell.
const QA_SCRIPT_TIMESTAMP_REGEX =
  /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/
const RUNTIME_ID_REGEX = /^\[[^\]]+\] \[rt:([^\]]+)\] /

function readLines(logFilePath: string): string[] {
  return fs
    .readFileSync(logFilePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
}

describe("#given the logger emits two lines in one realm", () => {
  let tempDir: string
  let logFilePath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEST_PREFIX}-`))
    logFilePath = path.join(tempDir, "runtime-id.log")
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("#when the runtime ids are compared #then they are identical and non-empty", () => {
    // given
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })

    // when
    logger.log("FIRST-LINE")
    logger.log("SECOND-LINE")
    logger._flushForTesting()

    // then
    const [first, second] = readLines(logFilePath)
    const firstRuntimeId = first?.match(RUNTIME_ID_REGEX)?.[1]
    const secondRuntimeId = second?.match(RUNTIME_ID_REGEX)?.[1]

    expect(firstRuntimeId).toBeDefined()
    expect(firstRuntimeId).not.toBe("")
    expect(secondRuntimeId).toBe(firstRuntimeId as string)
  })

  test("#when two loggers in the same realm emit #then they report the same runtime id", () => {
    // given
    const otherLogFilePath = path.join(tempDir, "other.log")
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })
    const otherLogger = createLogger({
      logFileName: "unused.log",
      resolveLogFilePath: () => otherLogFilePath,
    })

    // when
    logger.log("FROM-LOGGER-A")
    otherLogger.log("FROM-LOGGER-B")
    logger._flushForTesting()
    otherLogger._flushForTesting()

    // then
    const runtimeIdA = readLines(logFilePath)[0]?.match(RUNTIME_ID_REGEX)?.[1]
    const runtimeIdB = readLines(otherLogFilePath)[0]?.match(RUNTIME_ID_REGEX)?.[1]

    expect(runtimeIdA).toBeDefined()
    expect(runtimeIdB).toBe(runtimeIdA as string)
  })

  test("#when the runtime id is inspected #then it carries this process pid", () => {
    // given
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })

    // when
    logger.log("PID-LINE")
    logger._flushForTesting()

    // then
    const runtimeId = readLines(logFilePath)[0]?.match(RUNTIME_ID_REGEX)?.[1]
    expect(runtimeId).toBe(`${process.pid}:${(runtimeId ?? "").split(":")[1] ?? ""}`)
    expect((runtimeId ?? "").split(":")[1] ?? "").not.toBe("")
  })
})

describe("#given a log line is emitted", () => {
  let tempDir: string
  let logFilePath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEST_PREFIX}-qa-`))
    logFilePath = path.join(tempDir, "qa-compat.log")
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("#when the ISO timestamp is extracted by the QA-script regex #then it still matches the timestamp and not the runtime id", () => {
    // given
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })
    const before = new Date().toISOString().slice(0, 19)

    // when
    logger.log("[prompt-async-gate] promptAsync dispatching", { source: "parent-wake" })
    logger._flushForTesting()

    // then
    const line = readLines(logFilePath)[0] ?? ""
    const extracted = line.match(QA_SCRIPT_TIMESTAMP_REGEX)?.[0]
    const runtimeId = line.match(RUNTIME_ID_REGEX)?.[1] ?? ""

    expect(extracted).toBeDefined()
    expect(extracted).toBe(line.slice(1, 20))
    expect(extracted?.slice(0, 13)).toBe(before.slice(0, 13))
    expect(runtimeId).not.toBe("")
    expect(QA_SCRIPT_TIMESTAMP_REGEX.test(runtimeId)).toBe(false)
  })

  test("#when the runtime id segment is scanned #then it contains no ISO-date-shaped substring", () => {
    // given
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })

    // when
    logger.log("RUNTIME-ID-SHAPE")
    logger._flushForTesting()

    // then
    const runtimeId = readLines(logFilePath)[0]?.match(RUNTIME_ID_REGEX)?.[1] ?? ""
    expect(runtimeId).not.toBe("")
    expect(runtimeId).toMatch(/^[0-9a-f:-]+$/)
    expect(runtimeId).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/)
  })

  test("#when a line carries message and data #then the timestamp stays first and the runtime id follows it", () => {
    // given
    const logger = createLogger({ logFileName: "unused.log", resolveLogFilePath: () => logFilePath })

    // when
    logger.log("Task queued", { taskId: "bg_f3c12652" })
    logger._flushForTesting()

    // then
    const line = readLines(logFilePath)[0] ?? ""
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[rt:[^\]]+\] Task queued \{"taskId":"bg_f3c12652"\}$/,
    )
  })
})
