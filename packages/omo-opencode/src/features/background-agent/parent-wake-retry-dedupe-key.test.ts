import { describe, expect, test } from "bun:test"
import type { PendingParentWake } from "./parent-wake-dedupe"
import {
  createEmptyAssistantTurnRetryDedupeKey,
  createNoAssistantOutputRetryDedupeKey,
} from "./parent-wake-history-state"

function createWake(notifications: string[], noAssistantOutputRetryCount?: number): PendingParentWake {
  return {
    promptContext: {},
    notifications,
    shouldReply: true,
    ...(noAssistantOutputRetryCount !== undefined ? { noAssistantOutputRetryCount } : {}),
  }
}

describe("parent wake retry dedupe key serialization", () => {
  test("#given distinct notification arrays containing a NUL boundary #when creating empty-turn retry keys #then the keys differ", () => {
    // given
    const splitNotifications = createWake(["a", "b"])
    const embeddedBoundary = createWake(["a\u0000b"])

    // when
    const splitKey = createEmptyAssistantTurnRetryDedupeKey(splitNotifications)
    const embeddedKey = createEmptyAssistantTurnRetryDedupeKey(embeddedBoundary)

    // then
    expect(splitKey).not.toBe(embeddedKey)
  })

  test("#given distinct notification arrays containing a NUL boundary #when creating no-output retry keys #then the keys differ", () => {
    // given
    const splitNotifications = createWake(["a", "b"], 1)
    const embeddedBoundary = createWake(["a\u0000b"], 1)

    // when
    const splitKey = createNoAssistantOutputRetryDedupeKey(splitNotifications)
    const embeddedKey = createNoAssistantOutputRetryDedupeKey(embeddedBoundary)

    // then
    expect(splitKey).not.toBe(embeddedKey)
  })

  test("#given a retry count that can resemble a notification #when creating no-output retry keys #then field boundaries remain distinct", () => {
    // given
    const retryCountOne = createWake(["x"], 1)
    const notificationOne = createWake(["1", "x"], 0)

    // when
    const retryCountKey = createNoAssistantOutputRetryDedupeKey(retryCountOne)
    const notificationKey = createNoAssistantOutputRetryDedupeKey(notificationOne)

    // then
    expect(retryCountKey).not.toBe(notificationKey)
  })
})
