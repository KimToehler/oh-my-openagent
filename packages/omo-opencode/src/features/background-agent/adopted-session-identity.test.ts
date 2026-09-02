import { describe, expect, test } from "bun:test"
import { resolveAdoptedSessionIdentity } from "./adopted-session-identity"

type FakeClient = Parameters<typeof resolveAdoptedSessionIdentity>[0]

function createClient(messages: unknown, options: { throws?: boolean } = {}): FakeClient {
  return {
    session: {
      messages: async () => {
        if (options.throws) {
          throw new Error("session messages unavailable")
        }
        return { data: messages }
      },
    },
  } as unknown as FakeClient
}

const DIRECTORY = "/tmp/adopted-session-identity-test"

describe("resolveAdoptedSessionIdentity", () => {
  test("#given a transcript whose newest message carries the owning agent #when identity is resolved #then that agent is returned", async () => {
    // given
    const client = createClient([
      { info: { agent: "explore", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } } },
      { info: { agent: "momus", model: { providerID: "anthropic", modelID: "claude-opus-4" } } },
    ])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBe("momus")
    expect(identity.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4" })
  })

  test("#given the newest message is a compaction message #when identity is resolved #then the pre-compaction agent is recovered instead of the compaction name", async () => {
    // given
    const client = createClient([
      { info: { agent: "plan", model: { providerID: "anthropic", modelID: "claude-opus-4" } } },
      { info: { agent: "compaction", model: { providerID: "anthropic", modelID: "claude-haiku-4" } } },
    ])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBe("plan")
    expect(identity.agent).not.toBe("compaction")
  })

  test("#given a transcript with no agent on any message #when identity is resolved #then no agent is returned so the caller can refuse adoption", async () => {
    // given
    const client = createClient([{ info: { role: "assistant" } }, { info: { role: "user" } }])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBeUndefined()
  })

  test("#given an empty transcript #when identity is resolved #then no agent is returned", async () => {
    // given
    const client = createClient([])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBeUndefined()
  })

  test("#given the session messages fetch fails and no stored transcript exists #when identity is resolved #then no agent is returned instead of throwing", async () => {
    // given
    const client = createClient(undefined, { throws: true })

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_missing_child", DIRECTORY)

    // then
    expect(identity.agent).toBeUndefined()
  })

  test("#given a message carrying an agent but no model #when identity is resolved #then the agent is returned without a model", async () => {
    // given
    const client = createClient([{ info: { agent: "oracle" } }])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBe("oracle")
    expect(identity.model).toBeUndefined()
  })

  test("#given split messages where the newest lacks a model #when identity is resolved #then agent and model merge independently across messages", async () => {
    // given
    const client = createClient([
      { info: { agent: "explore", model: { providerID: "anthropic", modelID: "claude-sonnet-4" } } },
      { info: { agent: "librarian" } },
    ])

    // when
    const identity = await resolveAdoptedSessionIdentity(client, "ses_child", DIRECTORY)

    // then
    expect(identity.agent).toBe("librarian")
    expect(identity.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
  })
})
