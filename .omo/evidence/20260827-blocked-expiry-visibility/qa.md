# WHAT WAS TESTED

- `bun test packages/omo-opencode/src/features/background-agent/blocked-expiry-notification.test.ts`
- `bun test packages/omo-opencode/src/features/background-agent/blocked-notify.test.ts`
- Mutation: removed `|| isBlocked` from `manager.ts`, ran only `blocked-notify.test.ts`, restored exact source, reran it.
- `bash .agents/skills/opencode-qa/scripts/blocked-escalation-probe.sh --self-test`

# WHAT WAS OBSERVED

Test 1 first RED produced `Expected to contain: "Blocked task expired unanswered"` and `Received: ""`. After expiry enqueue, deterministic expiry seam test passed. Mutation failed with `Expected: true` and `Received: false`; restored source passed. Probe self-test passed five assertions.

# WHY IT IS ENOUGH

Deterministic tests exercise real manager escalation callbacks, terminal transition, notification construction, resumed-task suppression, public parent-wake flush, and no-completion-reason rendering. Repaired contract pin proves `isBlocked` matters when `allComplete` is false. No parent-wake flush runner or active-defer ceiling constant changed.

# WHAT WAS OMITTED

Live sandbox expiry run omitted after one fast probe self-test because supplied live probe hardcodes a 120-second expiry, exceeding foreground QA budget. No provider was contacted. Scoped suite and typecheck output recorded in final review response.
