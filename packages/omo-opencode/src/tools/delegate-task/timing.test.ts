declare const require: (name: string) => any
const { describe, expect, test } = require("bun:test")
import {
  __resetTimingConfig,
  __setTimingConfig,
  getDefaultSyncPollTimeoutMs,
  getDefaultSyncWallClockTimeoutMs,
  getTimingConfig,
} from "./timing"

describe("timing sync poll timeout defaults", () => {
  test("default sync inactivity timeout is 30 minutes", () => {
    // #given
    __resetTimingConfig()

    // #when
    const timeout = getDefaultSyncPollTimeoutMs()

    // #then
    expect(timeout).toBe(30 * 60 * 1000)
  })

  test("default sync inactivity timeout accessor follows MAX_POLL_TIME_MS config", () => {
    // #given
    __resetTimingConfig()

    // #when
    __setTimingConfig({ MAX_POLL_TIME_MS: 123_456 })

    // #then
    expect(getDefaultSyncPollTimeoutMs()).toBe(123_456)

    __resetTimingConfig()
  })
})

describe("timing sync wall-clock timeout defaults", () => {
  test("default sync wall-clock timeout is inert", () => {
    // #given
    __resetTimingConfig()

    // #when
    const timeout = getDefaultSyncWallClockTimeoutMs()

    // #then
    expect(timeout).toBe(Infinity)
  })

  test("sync wall-clock timeout accessor follows MAX_WALL_CLOCK_MS config", () => {
    // #given
    __resetTimingConfig()

    // #when
    __setTimingConfig({ MAX_WALL_CLOCK_MS: 1234 })

    // #then
    expect(getDefaultSyncWallClockTimeoutMs()).toBe(1234)
  })

  test("reset restores inert sync wall-clock timeout", () => {
    // #given
    __setTimingConfig({ MAX_WALL_CLOCK_MS: 1234 })

    // #when
    __resetTimingConfig()

    // #then
    expect(getDefaultSyncWallClockTimeoutMs()).toBe(Infinity)
  })

  test("timing config includes sync wall-clock timeout", () => {
    // #given
    __resetTimingConfig()

    // #when
    const config = getTimingConfig()

    // #then
    expect(config.MAX_WALL_CLOCK_MS).toBe(Infinity)
  })
})

  describe("WAIT_FOR_SESSION_TIMEOUT_MS default", () => {
  test("default wait for session timeout is 1 minute", () => {
    // #given
    __resetTimingConfig()

    // #when
    const config = getTimingConfig()

    // #then
    expect(config.WAIT_FOR_SESSION_TIMEOUT_MS).toBe(60_000)
  })
})
