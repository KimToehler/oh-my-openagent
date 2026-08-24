WHAT WAS TESTED

- `bun test packages/omo-opencode/src/tools/background-task/task-result-format.test.ts`
- Surface: `formatTaskResult()` default background-output formatter for completed tasks.
- Behavior: multiple assistant text turns survive when a later assistant message carries a provider/session error; terminal error remains visible.

WHAT WAS OBSERVED

RED before production fix:

```text
exit=1
1 pass
1 fail
3 expect() calls
Ran 2 tests across 1 file. [72.00ms]

80 |     expect(output).toContain("First useful result")
                        ^
error: expect(received).toContain(expected)

Expected to contain: "First useful result"
Received: "Task Result\n\nTask ID: task-1\nDescription: background task\nDuration: 5s\nSession ID: ses-1\n\n---\n\nSecond useful result\n\nSession error: Provider failed after progress (terminal)"
```

The first RED run used the same `ses-1` session ID as preceding test. `consumeNewMessages()` correctly cursor-deduplicated first turn. Test changed only its session ID to `ses-2`, preserving test intent and isolating cursor state.

GREEN after production fix:

```text
exit=0
1
1

 2 pass
 0 fail
 6 expect() calls
Ran 2 tests across 1 file. [74.00ms]
```

WHY IT IS ENOUGH

Regression test supplies two real assistant text parts followed by an errored assistant message. Before fix, early session-error return omits transcript. After fix, formatter consumes text first, returns both transcript and `Session error: ... (terminal)`. Existing zero-part error test remains unchanged and passes. Header fields remain in shared final return path.

WHAT WAS OMITTED

- Full Bun output omitted because known lean-ctx triage defect discards dense logs. Captured decisive exit, assertion, pass/fail, and count lines shown above.
- No credentials, environment dumps, tokens, or auth headers captured.
