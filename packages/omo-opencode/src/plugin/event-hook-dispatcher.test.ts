import { describe, expect, it, mock } from "bun:test"
import type { CreatedHooks } from "../create-hooks"
import type { OhMyOpenCodeConfig } from "../config"
import type { BackgroundManager } from "../features/background-agent"
import type { ModelCacheState } from "../plugin-state"
import { createEventHookDispatcher, createEventHookRunner } from "./event-hook-dispatcher"
import type { EventInput } from "./event-types"
import { createSessionHooks } from "./hooks/create-session-hooks"
import type { PluginContext } from "./types"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"

function sessionIdleInput(sessionID: string): EventInput {
  return unsafeTestValue<EventInput>({
    event: {
      type: "session.idle",
      properties: { sessionID },
    },
  })
}

describe("createEventHookDispatcher", () => {
  describe("#given a session hook that is registered as a bare handler", () => {
    describe("#when a session.idle event is dispatched", () => {
      it("#then it invokes the lesson nudge hook with that event", async () => {
        // given
        const lessonNudge = mock(async () => {})
        const hooks = unsafeTestValue<CreatedHooks>({ lessonNudge })
        const dispatch = createEventHookDispatcher(hooks, createEventHookRunner())
        const input = sessionIdleInput("ses_lesson_nudge")

        // when
        await dispatch(input)

        // then
        expect(lessonNudge).toHaveBeenCalledTimes(1)
        expect(lessonNudge).toHaveBeenCalledWith(unsafeTestValue<never>(input))
      })
    })
  })

  describe("#given the lesson nudge hook is disabled and therefore null", () => {
    describe("#when a session.idle event is dispatched", () => {
      it("#then dispatching does not throw", async () => {
        // given
        const hooks = unsafeTestValue<CreatedHooks>({ lessonNudge: null })
        const dispatch = createEventHookDispatcher(hooks, createEventHookRunner())

        // when
        const dispatched = dispatch(sessionIdleInput("ses_lesson_nudge_null"))

        // then
        await expect(dispatched).resolves.toBeUndefined()
      })
    })
  })
})

/**
 * Session hook members consumed by a tier other than the event dispatcher.
 * Adding a name here requires proving a real consumer exists: find the call
 * site that reads the member and runs it, then cite it in the review. A name
 * added without such a consumer silently reintroduces the dead hook defect
 * this guard exists to catch.
 */
const NON_EVENT_TIER_SESSION_HOOKS = new Set([
  "modelFallback",
  "nonInteractiveEnv",
  "editErrorRecovery",
  "delegateTaskRetry",
  "startWork",
  "prometheusMdOnly",
  "sisyphusJuniorNotepad",
  "noSisyphusGpt",
  "noHephaestusNonGpt",
  "questionLabelTruncator",
  "taskResumeInfo",
])

describe("session hook dispatch coverage", () => {
  describe("#given every member returned by createSessionHooks", () => {
    describe("#when one event is dispatched", () => {
      it("#then each event-tier member receives it or is explicitly allowlisted to another tier", async () => {
        // given
        const sessionHooks = createSessionHooks({
          ctx: unsafeTestValue<PluginContext>({ directory: "/tmp", client: {} }),
          pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
          modelCacheState: unsafeTestValue<ModelCacheState>({}),
          backgroundManager: unsafeTestValue<BackgroundManager>({}),
          isHookEnabled: () => false,
          safeHookEnabled: true,
        })
        const handlers: Record<string, ReturnType<typeof mock>> = {}
        const hookStubs: Record<string, unknown> = {}
        const bareHandlers = new Set(["sessionNotification", "lessonNudge"])
        const handlerMembers = new Set(["todoContinuationEnforcer", "atlasHook"])
        const eventTierMembers = Object.keys(sessionHooks).filter(
          (member) => !NON_EVENT_TIER_SESSION_HOOKS.has(member),
        )

        for (const member of eventTierMembers) {
          const handler = mock(() => {})
          handlers[member] = handler
          hookStubs[member] = bareHandlers.has(member)
            ? handler
            : handlerMembers.has(member)
              ? { handler }
              : { event: handler }
        }

        const dispatch = createEventHookDispatcher(
          unsafeTestValue<CreatedHooks>(hookStubs),
          createEventHookRunner(),
        )
        const input = sessionIdleInput("ses_dispatch_coverage")

        // when
        await dispatch(input)

        // then
        for (const member of eventTierMembers) {
          expect(handlers[member]).toHaveBeenCalledTimes(1)
          expect(handlers[member]).toHaveBeenCalledWith(unsafeTestValue<never>(input))
        }
      })
    })
  })

  describe("#given the allowlist of session hooks consumed by other tiers", () => {
    describe("#when the lesson nudge hook is looked up", () => {
      it("#then it is absent because it belongs to the event tier", () => {
        // given
        const member = "lessonNudge"

        // when
        const allowlisted = NON_EVENT_TIER_SESSION_HOOKS.has(member)

        // then
        expect(allowlisted).toBe(false)
      })
    })
  })
})
