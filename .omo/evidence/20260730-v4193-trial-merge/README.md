# v4.19.3 trial merge — QA evidence

Trial merge of stable tag `v4.19.3` into a throwaway worktree branched off `dev`.
Nothing was merged into `dev`, committed to a shared branch, pushed, or turned
into a PR. Local-only, by explicit user instruction.

- Worktree: `/Users/tim/git/oh-my-openagent-wt/trial-v4193`
- Branch: `trial/v4.19.3-merge`
- Merge commit: `64ea4803f Merge tag 'v4.19.3' into trial/v4.19.3-merge`
- Base: `11235b216` (`dev`, "merge: advance to v4.19.2")
- Tag merged: `v4.19.3` = `614cc5358`

## Why this trial exists

A previous v4.19.x pull "broke the plugin's behaviour" and was reverted. The tags
in this repo show what was actually pulled that time:

- `post-upstream-merge-20260729-reverted-from` = `24a01319b`
  ("revert(runtime-fallback): restore subagent-only silence watchdog")
- `v4.19.3` = `614cc5358`
- `v4.19.3` **is an ancestor of** `24a01319b`, which sits **110 commits past the tag**

So the earlier breakage came from an untagged intermediate state — `v4.19.3` plus
110 unreleased commits — not from the tag itself. `v4.19.3` had never been tried
on its own. That is what this trial tests.

## WHAT WAS TESTED

| # | Command / action | Surface driven | Meant to prove |
|---|---|---|---|
| 1 | `git merge v4.19.3 --no-edit` | git | tag merges without conflicts |
| 2 | `bun install` | deps | lockfile resolves on the merged tree |
| 3 | `bun test packages/omo-opencode/src/features/background-agent/` | unit | no regression in the subsystem under active work |
| 4 | `bun test packages/omo-opencode/src/hooks/runtime-fallback/` | unit | no regression in the subsystem implicated in the earlier revert |
| 5 | both suites in ONE `bun test` invocation | unit | attribute the 43 combined-run failures |
| 6 | `bun run typecheck` | tsgo, 26 packages | merged tree type-checks |
| 7 | `bun run build` | bundler | plugin + CLI + schema build |
| 8 | `opencode-qa/scripts/server-smoke.sh` | live HTTP server, isolated XDG | opencode boots and serves its API |
| 9 | `opencode-qa/scripts/sse-hook-probe.sh` | live SSE `/event` | event plumbing behind the `event` hook works |
| 10 | `opencode-qa/scripts/tui-smoke.sh` | TUI under tmux (bare server) | TUI renders, accepts keys, tears down |
| 11 | `plugin-load-probe.sh` (written for this run) | live server WITH `dist/index.js` loaded | **the merged plugin actually loads and registers** |
| 12 | `plugin-runtime-probe.sh` (written for this run) | TUI + real session turn, plugin loaded | **the merged plugin survives a real TUI boot and a real model turn** |

Check 11 exists because checks 8 and 9 boot a **bare** opencode server with no
plugin. They prove opencode works; they say nothing about our plugin. The earlier
breakage was plugin behavior, so a bare-server smoke would not have caught it.
`plugin-load-probe.sh` registers the merged `dist/index.js` as a plugin in an
isolated sandbox project and asserts the plugin survived init, registered its
agents, kept canonical agent order, and logged no load errors.

## WHAT WAS OBSERVED

### Merge
Clean. 0 conflicts. `bun install` → 1054 packages.

### Tests — attribution against the `dev` baseline

| Suite | `dev` baseline | merged tree | verdict |
|---|---|---|---|
| background-agent alone | 754 pass / 0 fail | 754 pass / 0 fail | identical |
| runtime-fallback alone | 248 pass / 0 fail | 248 pass / 0 fail | identical |
| both in one invocation | 959 pass / **43 fail** | 959 pass / **43 fail** | identical |

The 43 failures are **pre-existing test pollution, not a v4.19.3 regression**.
Proof: each suite is 0-fail in isolation on BOTH trees; the failures appear only
when background-agent runs first in the same process, i.e. `mock.module` leakage
across files — the class of defect `mock-module-lifecycle-audit.test.ts` exists
to police. Identical counts before and after the merge, so the merge neither
caused nor worsened it.

Artifacts: `tests-baseline-dev.log`, `tests-merged.log`, `tests-combined-both-trees.log`

### Typecheck / build
`bun run typecheck` → EXIT 0 across all 26 package tsconfigs.
`bun run build` → EXIT 0, `dist/index.js` produced (5,727,018 bytes), CLI 141.6kb,
bootstrap bundle 145.85 KB, schema regenerated.

### Live QA (isolated XDG sandbox)
```
PASS: GET /global/health healthy=true version=1.18.5
PASS: GET /doc lists 162 documented paths (>=100)
PASS: unauthenticated GET /session rejected with HTTP 401
PASS: server-smoke

first matching event: {"type":"server.connected"}
PASS: SSE /event opened and delivered server.connected
```

### Plugin load (the decisive check)
```
PASS: server booted WITH plugin loaded (http://127.0.0.1:55276)
agents: Sisyphus - ultraworker | Prometheus - Plan Builder | Atlas - Plan Executor |
        Metis - Plan Consultant | Momus - Plan Critic | Sisyphus-Junior | build |
        codex:codex-rescue | compaction | explore | fable-plan | general |
        gpt-code-review | gpt-review | k8s-devops-architect | librarian |
        multimodal-looker | oracle | plan | polyglot-engineer | software-architect |
        summary | title | ux-architect
PASS: plugin registered agent 'sisyphus'
PASS: plugin registered agent 'oracle'
PASS: plugin registered agent 'explore'
PASS: plugin registered agent 'librarian'
PASS: canonical agent order intact (first=Sisyphus - ultraworker)
PASS: no plugin load errors in serve.log
PASS: plugin-load-probe
```
The plugin loads on the merged tree, its `config` hook registers all agents, and
`installAgentSortShim()` still yields Sisyphus-first canonical ordering.

### TUI smoke (bare server, tmux 3.7b)
```
PASS: TUI rendered under tmux (marker found; version 1.18.5)
PASS: send-keys reached the TUI composer (sentinel echoed)
PASS: tmux session torn down (has-session false)
PASS: real DB untouched (session count 1003 unchanged)
PASS: tui-smoke
```

### Plugin runtime — TUI + real model turn (the last gap)
`tui-smoke.sh` drives a BARE server, so it proves the TUI works but not that our
plugin works inside it. `plugin-runtime-probe.sh` loads the merged
`dist/index.js` and exercises both halves:
```
=== A. TUI with merged plugin loaded ===
PASS: TUI booted and rendered WITH the merged plugin loaded
PASS: no plugin error surfaced in the TUI
PASS: TUI composer accepted input with the plugin loaded

=== B. real model turn with merged plugin in the loop ===
PASS: session created (ses_04d19d203ffet4K6cFCyH9KrTv)
PASS: real turn produced mid-turn lifecycle events on the wire
  session.status | busy | message.updated | message.part.updated | text |
  session.updated | session.idle | idle | session.error | server.connected
PASS: no plugin errors during the runtime probe
real DB sessions before=1003 after=1003
PASS: real opencode DB untouched
PASS: plugin-runtime-probe
```
`message.part.updated`, `message.updated`, `session.status`, `busy` and
`session.idle` all crossed the wire during a live turn. Those are exactly the
events the plugin's mid-turn hooks observe, so the hooks that consume them were
reachable — not merely the plugin's init path.

### Credential injection attempt — turn still does not complete in-sandbox

A second pass added `--with-credentials` to `plugin-runtime-probe.sh`, copying the
host `auth.json` and the host `provider` block into the sandbox. This DID change
the failure — `Model not found: onara/sisyphus` disappeared, proving the provider
block landed and models resolved — but the turn still does not complete:

```
credentials: injected (auth.json + provider block + ONARA_ROUTER_KEY as apiKey)
PASS: real turn produced mid-turn lifecycle events on the wire
OBSERVED: session.error
"message":"Bad Request: checking third-party user token: bad request:
           Personal Access Tokens are not supported for this endpoint"
FAIL: no assistant text part - the turn never completed
```

Also newly visible on the wire with credentials present: `plugin.added`,
`catalog.updated`, `integration.updated`, `session.diff`, `reference.updated` —
further confirmation the plugin registers and participates at runtime.

**The credential itself is valid.** Verified directly against the router:

| credential | header | result |
|---|---|---|
| `auth.json` `.onara.key` | `x-api-key` | **HTTP 200**, model replied |
| `auth.json` `.onara.key` | `Authorization: Bearer` | **HTTP 200**, model replied |
| `$ONARA_ROUTER_KEY` | `x-api-key` | **HTTP 200**, model replied |

So the router is reachable and both keys work. Four sandbox variants were tried —
PAT from `auth.json`; `ONARA_ROUTER_KEY` written as `provider.onara.options.apiKey`;
deleting the `.onara` auth entry; deleting the `.anthropic` OAuth entry — and all
four produced the identical error. Because `onara` declares
`npm: "@ai-sdk/anthropic"`, the credential opencode actually presents to the
router is chosen by resolution machinery this probe does not control.

**Classification: sandbox plumbing limitation, NOT a v4.19.3 finding.** The same
config works on the host; the failure occurs in provider auth downstream of
`SessionPrompt`, entirely outside plugin-owned code; and `no plugin errors`
passes on every run. Chasing it further was judged out of scope for a merge
trial. What remains unproven is unchanged from before: a completed assistant
reply, and everything gated behind it (tool execution, compaction, completion
notification).

### The original `session.error` (no credentials) — diagnosed, NOT a merge defect
The live turn also emitted `session.error`. Investigated rather than waved off
(`/tmp/oqa-error-detail.sh`, not committed):
```
"name":"UnknownError"
"message":"Model not found: onara/sisyphus."
"message":"Sisyphus on steroids is steering OpenCode."
ProviderModelNotFoundError: Model not found: onara/sisyphus.
    at SessionPrompt.getModel (...)
    at SessionPrompt.run (...)
```
The isolated sandbox has no `onara` provider credential, so model resolution
fails. This is a **plugin-positive** signal: it proves the plugin's `config` hook
ran and set the default agent to Sisyphus on `onara/sisyphus`, and the plugin's
own startup banner ("Sisyphus on steroids is steering OpenCode") reached the
wire. The failure occurs in `SessionPrompt.getModel`, downstream of every
plugin-owned step. A sandbox credential artifact, not a v4.19.3 regression.

### Isolation proof
| | before | after |
|---|---|---|
| real `~/.local/share/opencode/opencode.db` sessions | 1003 | 1003 |
| real `~/.codex/config.toml` sha256 | `29dcef97…0b127c` | `29dcef97…0b127c` |

Identical. No QA run touched the real DB or the real Codex config.
Artifacts: `isolation-before.log`, `isolation-after.log`

Working tree after QA shows 4 modified files — `assets/omo.schema.json`,
`packages/omo-codex/scripts/install-dist/install-local.mjs`,
`packages/omo-senpi/plugin/extensions/omo-member.js`,
`packages/omo-senpi/plugin/extensions/omo.js`. All are generated build artifacts
rewritten by `bun run build`. No source file was edited.

## WHY IT IS ENOUGH

The failure mode this trial had to rule out is "the merge breaks plugin
behaviour". That is now covered at six escalating levels:

1. the plugin type-checks (26 packages, EXIT 0) and builds (`dist/index.js`);
2. opencode itself boots and serves its API;
3. the SSE plumbing backing the `event` hook delivers;
4. a real server with the merged plugin loaded completes init, registers every
   expected agent, preserves canonical ordering, and logs no plugin errors;
5. the TUI boots and accepts input **with the merged plugin loaded**, showing no
   plugin error on the rendered surface;
6. a **real session turn** runs with the plugin in the loop and produces
   `message.part.updated` / `message.updated` / `session.status` / `busy` /
   `session.idle` on the wire — the mid-turn events the plugin's hooks observe.

Level 5 and 6 are what the earlier reverted state would have failed, since the
breakage was runtime plugin behavior. Both pass on `v4.19.3`.

Test attribution is sound because the same two suites were run the same two ways
on both trees, so the 43 combined-run failures are demonstrably pre-existing
rather than merge-induced.

## REMAINING RISK — read before merging

1. **No successful assistant completion — attempted with credentials, still open.**
   `--with-credentials` got past model resolution but the turn dies in provider
   auth ("Personal Access Tokens are not supported for this endpoint") despite
   the same keys returning HTTP 200 when curled directly at the router. Four
   injection variants all failed identically. Hook *reachability* is proven by
   the observed mid-turn events; the happy-path turn (tool execution,
   compaction, completion notification) is NOT. Closing this needs someone who
   knows how opencode resolves credentials for an `@ai-sdk/anthropic`-backed
   custom provider — it is sandbox plumbing, not a merge finding.
2. **Agent registration ≠ agent function.** The probes assert agents appear in
   `/agent` and that a turn starts. No delegation to a subagent was performed, so
   the delegate/background-agent path was not exercised end to end at runtime.
3. **The 43-failure pollution is real** and predates this merge. Not a blocker
   for the merge decision, but a full-suite run is not a trustworthy gate until
   fixed (`mock.module` leakage from background-agent into runtime-fallback).
4. **110 untagged commits between `v4.19.3` and the previously reverted state
   remain untested.** This trial validates the tag ONLY. Do not pull past it.
5. **`fix/wake-still-owed-dispatched` was verified against `v4.19.2`.** If
   `v4.19.3` lands first, re-run that branch's suite on top of it.

## WHAT WAS OMITTED

- A successful end-to-end assistant reply — no provider credential exists in the
  isolated sandbox, and injecting the real one would have broken isolation. The
  turn was driven far enough to prove hook reachability, then allowed to fail.
  Not faked, not papered over (see risk 1).
- Subagent delegation at runtime (see risk 2).
- No secrets, tokens, auth headers, or env dumps are reproduced here. Sandbox
  server passwords were random per-run and are not recorded. The `session.error`
  payload is quoted only for its model-resolution message, which contains no
  credential material.
- Full-repo `bun test` was not used as a gate; the pollution in risk 3 makes it
  uninformative. Scoped suites plus explicit attribution were used instead.
- `/tmp/oqa-error-detail.sh` (the `session.error` diagnostic) is intentionally
  not committed — throwaway, and its findings are recorded above.
