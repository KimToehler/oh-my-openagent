import { beforeEach, describe, expect, it } from "bun:test"
import {
  initLiveServerRoute,
  isLiveParentWakeRoutingDisabled,
  setLiveParentWakeRoutingDisabled,
  tryResolveDispatchClientSync,
} from "./live-server-route"

// Regression guard for the parent-wake render stall.
//
// Since opencode 1.18.x every event carries location metadata and the
// instance SSE stream filters on it
// (packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts).
// The attached TUI subscribes to that filtered `/event` stream, so a prompt
// injected through a SEPARATE SDK client built from `serverUrl` alone lands in
// a different instance context: the message persists, but the render event is
// filtered away and nothing repaints until opencode restarts.
//
// Owning the session (`GET /session/{id}` -> 200) does NOT prove owning the
// TUI's event stream, so the live route cannot be made render-safe by adding
// more affinity probes. Until a render-affinity handshake exists upstream the
// live route must stay opt-in.
describe("live-server-route render safety", () => {
  // Restore the shipped default between cases: the opt-in case below flips the
  // module-level flag, and leaking that would mask a regression in the default.
  beforeEach(() => {
    setLiveParentWakeRoutingDisabled(true)
  })

  describe("#given a fresh process that never configured the live route", () => {
    it("#when the module default is read #then live parent-wake routing is disabled", async () => {
      //#given
      // Load a pristine copy of the module so the assertion observes the shipped
      // default rather than a value some other case already set.
      const freshModulePath = `./live-server-route?render-safety-default=${Date.now()}`

      //#when
      const fresh = (await import(freshModulePath)) as {
        isLiveParentWakeRoutingDisabled: () => boolean
      }

      //#then
      expect(fresh.isLiveParentWakeRoutingDisabled()).toBe(true)
    })
  })

  describe("#given a registered client with a reachable server url", () => {
    it("#when a parent wake resolves its dispatch route #then it stays in-process so the attached TUI renders", () => {
      //#given
      const inProcessClient = {}
      initLiveServerRoute({
        serverUrl: new URL("http://127.0.0.1:4096"),
        directory: "/tmp/render-safety",
        inProcessClient,
      })

      //#when
      const resolved = tryResolveDispatchClientSync(inProcessClient, "ses_render_safety")

      //#then
      expect(resolved).toBeDefined()
      expect(resolved?.route).toBe("in-process")
      expect(resolved?.reason).toBe("flag")
      expect(resolved?.client).toBe(inProcessClient)
    })
  })

  describe("#given an operator explicitly opts back into the live route", () => {
    it("#when routing is re-enabled #then the resolver stops forcing the in-process client", () => {
      //#given
      const inProcessClient = {}
      initLiveServerRoute({
        serverUrl: new URL("http://127.0.0.1:4096"),
        directory: "/tmp/render-safety-optin",
        inProcessClient,
      })

      //#when
      setLiveParentWakeRoutingDisabled(false)
      const resolved = tryResolveDispatchClientSync(inProcessClient, "ses_render_safety_optin")

      //#then
      // With the flag cleared the "flag" short-circuit no longer applies, so the
      // resolver proceeds to probe availability/affinity instead of returning
      // in-process for reason "flag".
      expect(resolved?.reason).not.toBe("flag")
    })
  })
})
