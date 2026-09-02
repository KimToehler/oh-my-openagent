# Evidence: shrink root AGENTS.md below Claude Code's 40k-char limit

**Date:** 2026-08-17
**Change:** relocate reference-heavy sections out of the root `AGENTS.md` (symlinked as `CLAUDE.md`) into the nested per-directory `AGENTS.md` hierarchy plus one path-scoped `.omo/rules` shard.
**Trigger:** Claude Code warned `CLAUDE.md is over the 40.0k-char limit (55.1k chars)`.

## WHAT WAS TESTED

This change is documentation-only. No plugin source, hook, tool, config schema, installer, or prompt
was modified, so neither the `opencode-qa` nor the `codex-qa` live-harness flow applies. What IS
behaviorally live here is the rules/AGENTS.md INJECTION machinery that reads these files at runtime,
so that is what was driven.

| # | Command / action | Surface driven | Behavior it proves |
|---|---|---|---|
| 1 | `bun test script/agents-md-dev-env.test.ts` | The dev-env contract test that greps the root `AGENTS.md` AND `CLAUDE.md` for 13 pinned tokens | The relocation did not drop a token the suite pins, and `CLAUDE.md` still resolves and still contains `DEVELOPMENT ENVIRONMENT` |
| 2 | `bun test packages/omo-opencode/src/shared/markdown-link-audit.test.ts` | Repo-wide markdown local-link audit | Every relative link written or moved by this change resolves on disk, and no machine-local absolute path leaked in |
| 3 | `bun test` on `agents-md-core`, `rules-engine`, `hooks/rules-injector`, `hooks/directory-agents-injector`, `hooks/hephaestus-agents-md-injector` | The five suites that pin nested-AGENTS.md walk-up discovery, root-skip, realpath dedupe, and rule matching | The injection machinery still behaves identically against the restructured hierarchy |
| 4 | `bun .omo/evidence/20260817-agents-md-shrink/rule-gate-probe.ts` | The REAL `matchRule()` from `packages/rules-engine/src/engine/matcher.ts`, fed the actual parsed frontmatter of the new rule file | The new `.omo/rules` shard is PATH-GATED (lazy), not `alwaysApply` (eager). This is the load-bearing claim of the whole change |
| 5 | `wc -c` on every touched file | File sizes | The root file is under the 40k limit and the moved content actually landed in the destinations |
| 6 | `git status --short` | Working tree | Only intended files touched |

## WHAT WAS OBSERVED

**1. Dev-env contract test - PASS.** `4 pass, 0 fail, 16 expect() calls`. Independently re-verified
every pinned token by grep after the edit: `script/agent/setup.sh`, `script/agent/cleanup.sh`,
`script/agent/cleanup-hook.sh`, `script/agent/qa-sandbox.sh`, `.env.example`, `.devcontainer`,
`.cursor/environment.json`, `.claude/settings.json`, `.codex/setup.sh`, `single source of truth`,
`in sync`, `and the matching skill`, `CLAUDE.md`, `DEVELOPMENT ENVIRONMENT` - all 14 present.
The `DEVELOPMENT ENVIRONMENT` section was deliberately left untouched because the symlink means
`CLAUDE.md` is the same inode, and the test asserts on both.

**2. Markdown link audit - PASS.** `16 pass, 0 fail`. This is the gate that would have caught a
wrong relative depth in a moved link (destination files sit 2-3 levels below the repo root, so
`../../` and `../../../` prefixes differ per file).

**3. Injection machinery - PASS.** `134 pass, 0 fail, 240 expect() calls across 28 files`.

**4. Path-gating probe - PASS, 0 failures.** Captured verbatim in `rule-gate-probe.out`:

```
globs parsed: 24
alwaysApply in frontmatter: false

PASS  matched=true  expected=true   packages/omo-opencode/src/shared/prompt-async-gate.ts
PASS  matched=true  expected=true   packages/omo-opencode/src/hooks/goal/index.ts
PASS  matched=true  expected=true   packages/omo-opencode/src/features/background-agent/manager.ts
PASS  matched=true  expected=true   packages/omo-opencode/src/cli/run/runner.ts
PASS  matched=false expected=false  packages/omo-opencode/src/config/schema/team-mode.ts
PASS  matched=false expected=false  packages/web/app/page.tsx
PASS  matched=false expected=false  AGENTS.md
PASS  matched=false expected=false  docs/guide/team-mode.md

RESULT: PATH-GATED as intended (0 failures)
```

The negative cases are the point: the rule does NOT match unrelated files, so it costs zero context
until someone actually opens a prompt-dispatch route. A rule with `alwaysApply: true` would have
matched all 8 and made the situation worse than the status quo.

**5. Sizes - before / after.**

| File | Before | After | Delta |
|---|---|---|---|
| `AGENTS.md` (= `CLAUDE.md`) | 55,769 | 36,368 | **-19,401** |
| `packages/omo-codex/AGENTS.md` | 16,286 | 18,919 | +2,633 |
| `packages/omo-opencode/src/AGENTS.md` | 9,838 | 15,624 | +5,786 |
| `packages/omo-config-core/AGENTS.md` | 10,175 | 11,982 | +1,807 |
| `.github/workflows/AGENTS.md` | (did not exist) | 4,043 | new |
| `.omo/rules/internal-prompt-injection.md` | (did not exist) | 3,913 | new |

Root is now **36,368 chars, 3,632 under the 40,000 limit.** Note the totals do not balance to zero,
by design: a large share of the removed root text was DUPLICATE of detail the nested files already
owned, so it was deleted and replaced with a pointer rather than moved.

**6. Working tree.** `git status --short` showed only the six files above, plus two pre-existing
unrelated entries that this change did not touch (`packages/omo-senpi/plugin/extensions/omo-task.js`
modified, `HANDOFF-PROMPT-mid-batch-wake-starvation.md` untracked).

### Drift found and corrected as a side effect

`packages/omo-opencode/src/AGENTS.md` claimed `53 base, 63 with team-mode` hooks and `63 dirs`. The
root claimed 60 composed / 52 active / 64 max and 64 dirs. Counted directly from each composer's
return object: Session 26 (`create-session-hooks.ts:74`), ToolGuard 18
(`create-tool-guard-hooks.ts:54`), Transform 7 (`create-transform-hooks.ts:29`), Continuation 7
(`create-continuation-hooks.ts:26`), Skill 2 (`create-skill-hooks.ts:14`) = **60 composed**, minus 8
gated-null-by-default = **52 active**, plus 4 direct team event handlers
(`plugin/event-team-handlers.ts:1-4`) = **64 max**. `ls -d hooks/*/ | wc -l` = **64 dirs**. The ROOT
was correct; the nested file had drifted and was corrected. It had been missing `unpolledShellJob`
(Session) and `monitorStatusInjector` (Transform) entirely.

## WHY IT IS ENOUGH

The intended behavior is "the root instruction file stops exceeding Claude Code's limit, without
losing any information and without moving always-on content into a different always-on channel."

- **Size claim** is directly measured (`wc -c`), not estimated.
- **No information lost** is covered by the link audit (every pointer resolves to the file that now
  owns the detail) plus a manual before/after read of all 414 original lines. The delegated
  destination workers each reported, item by item, which facts they added versus skipped as
  already-covered.
- **No context regression** is the risk that mattered most, and it is the one thing a passing test
  suite could NOT have told us. It was proven empirically against the real matcher in probe 4:
  `.omo/rules` is `tool.execute.after`-triggered and glob-filtered
  (`hooks/rules-injector/hook.ts:36-80`, `matcher.ts:29-71`), and nested `AGENTS.md` files are
  walk-up-on-access with the root SKIPPED by default (`agents-md-core/src/injector.ts:40-45`,
  `rules-engine/src/agents-md.ts:16-37`). Content moved into either channel therefore loads on demand
  instead of every turn.
- **Test-pinned content preserved** is covered by probe 1 plus an independent grep of all 14 tokens.

**Residual risk.**
1. Whether Claude Code natively walks the nested `AGENTS.md` hierarchy is version-dependent. This is
   mitigated structurally rather than by trust: every relocated section leaves an EXPLICIT markdown
   link in the root, which any harness can follow regardless of native support. The failure mode is
   one extra read, not lost information.
2. Upstream (`code-yeongyu/oh-my-openagent`) edits `AGENTS.md` frequently, so a 19k restructure will
   conflict on future `upstream/dev` merges. Accepted deliberately per the fork-local decision; the
   durable fix is upstreaming the restructure.
3. Root still sits only 3,632 chars under the limit. Further growth will re-trip the warning. The
   remaining large sections are `NOTES` (~5.5k) and `DEVELOPMENT ENVIRONMENT` (4.2k); the latter is
   test-pinned and cannot shrink without updating `script/agents-md-dev-env.test.ts` in the same
   change.

## WHAT WAS OMITTED

- **No live-harness QA run.** Deliberate and scoped: this change touches only `.md` files and one
  `.omo/rules` shard. No hook, tool, agent, feature, config schema, MCP, CLI command, installer, or
  prompt was modified, so there is no wired-in behavior for `opencode-qa` / `codex-qa` to drive. The
  runtime machinery that DOES read these files was driven directly instead (probes 3 and 4).
- **No full `bun test` run** in this evidence set. The five suites that pin this change's behavior
  were run targeted. A full-suite run belongs to the commit gate.
- **No secrets, tokens, env dumps, auth headers, or credentials** were captured. The probe reads only
  a committed rule file and prints match booleans. `rule-gate-probe.out` contains no environment data.
- The probe prints `reason=[object Object]` because `matchRule()` returns a structured reason object;
  cosmetic only, the `matched` booleans are the assertion and they are exact.

## ARTIFACTS

- `rule-gate-probe.ts` - the probe, re-runnable with `bun .omo/evidence/20260817-agents-md-shrink/rule-gate-probe.ts` (exit 0 = path-gated)
- `rule-gate-probe.out` - captured verbatim output
