# QA evidence — `harness-findings-review` skill

**Change:** adds `.agents/skills/harness-findings-review/SKILL.md` (manual-invocation triage
skill for `docs/troubleshooting/harness-findings.md`) and registers it in `docs/AGENTS.md`.

**Branch:** `harness-findings-review` · **Base:** `dev` · **Date:** 2026-08-17

## WHAT WAS TESTED

The change is docs/skill-only — no runtime code path is modified — so the surface that
matters is **skill discovery and parse**: does OpenCode's real loader find this SKILL.md,
parse its frontmatter, and expose the full body?

Driven surface: `discoverProjectAgentsSkills()` from
`packages/skills-loader-core/src/features/opencode-skill-loader/loader.ts:173`, the same
function the plugin uses to discover project `.agents/skills/`. Invoked directly against two
project roots via `bun`, not mocked.

Artifact: [`loader-probe.txt`](loader-probe.txt) (verbatim command output).

1. **Control run** — main checkout `/Users/tim/git/oh-my-openagent`, where the skill does
   NOT exist (it lives only in the worktree). Confirms the probe can produce a negative.
2. **Subject run** — worktree root, where the skill does exist.
3. **Frontmatter validation** — YAML parsed with `python3 -c` + `yaml.safe_load`; asserts
   the 1024-char frontmatter limit, exactly the two required keys, and `name` matching the
   directory.

## WHAT WAS OBSERVED

| Check | Result |
|---|---|
| Skills found, main checkout (control) | 13 — `harness-findings-review` **absent**, as expected |
| Skills found, worktree | 14 — `harness-findings-review` **present** |
| Resolved path | `.worktrees/harness-findings-review/.agents/skills/harness-findings-review/SKILL.md` |
| Scope | `project` |
| Description parsed | 454 chars (loader prefixes `(project - Skill) `; raw frontmatter value is 436) |
| Frontmatter total | 482 chars, under the 1024 limit |
| Frontmatter keys | exactly `description`, `name` |
| Body exposed via `definition.template` | 7643 chars |
| Body contains mandatory cross-check step | true |
| Body contains manual-only clause | true |
| Body contains append-never-rewrite rule | true |

The 13 → 14 delta between control and subject is the isolation proof: the loader picked up
this specific file and nothing else changed.

**Two probe defects found and corrected during QA** (recorded because they nearly produced
a false negative and a false positive):

- First probe read `skill.description` and printed `undefined`. The field is
  `skill.definition.description`; the skill was fine, the probe was wrong. Had this not been
  chased, the change would have been reported as a parse failure.
- Second probe called `hit.lazyContent?.()` and threw `TypeError: hit.lazyContent is not a
  function`. `lazyContent` is an object (`{ loaded, content, load }`), and the eagerly
  available body is `definition.template`. Corrected to assert on `template`.

**Not proven by this evidence:** the skill was NOT loaded through the live `skill()` tool in
this session. `skill(name="harness-findings-review")` returned not-found while the file
exists only in the worktree, which is consistent with source — discovery resolves against
the project directory (`loader.ts:173-179`) and results are cached by key in
`skill-discovery.ts:6-38`, with no file-watch invalidation. Expect availability in the main
checkout after this PR merges, plus an OpenCode restart for deterministic visibility.

## WHY IT IS ENOUGH

The change adds no executable code — no hook, tool, agent, config schema, or MCP is touched,
so there is no lifecycle event to assert on the wire. The complete risk surface is "does the
harness see and correctly parse this file", and that is exercised end-to-end here against
the real loader, with a negative control proving the probe discriminates.

Content correctness is asserted structurally rather than by eyeball: the three load-bearing
rules (mandatory cross-check, manual-only invocation, append-never-rewrite) are confirmed
present in the parsed body, so a truncated or mis-parsed file would fail the check.

Residual risk is low and bounded: a wrong-but-parseable instruction in the skill body. That
surfaces on first real use, and the skill ends at a proposal rather than mutating anything,
so a bad run costs a review pass and not a broken repo.

## WHAT WAS OMITTED

- No secrets, tokens, credentials, or env dumps are involved; nothing required redaction.
- Probe scripts were written to `/tmp/hfr-qa/` and are deliberately not committed — they are
  throwaway harnesses, fully reproduced by the command block in `loader-probe.txt`.
- Neither `opencode-qa` nor `codex-qa` was run: this change touches no file under
  `packages/omo-opencode/` or `packages/omo-codex/`. Verified with `git diff --name-only`
  against `dev` — only `.agents/skills/` and `docs/` paths appear.
