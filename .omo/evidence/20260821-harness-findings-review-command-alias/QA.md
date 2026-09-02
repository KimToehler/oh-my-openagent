# QA — `.opencode/command/harness-findings-review.md` slash-command alias

## What was tested

Adding `.opencode/command/harness-findings-review.md` as a thin alias that loads the
`harness-findings-review` skill, so the command appears in the OpenCode TUI slash-command
autocomplete.

Background: the skill lives at `.agents/skills/harness-findings-review/SKILL.md`. Project
`.agents/skills` discovery runs through `loadProjectAgentsSkills()` which is gated behind
`includeClaudeSkills` in `packages/omo-opencode/src/plugin-handlers/command-config-handler.ts`
(line 100). The user's `~/.omo/omo.jsonc` sets `[opencode].claude_code.skills: false`, so all
14 `.agents/skills` entries are discarded before reaching `params.config.command`.
`.opencode/command/*.md` is loaded by `loadOpencodeProjectCommands()` (line 96), which is
NOT gated — hence the alias.

Surface driven: the real project command loader,
`packages/claude-code-compat-core/src/features/claude-code-command-loader/loader.ts:177`
`loadOpencodeProjectCommands()`, executed against this repo via `bun`.

## What was observed

Before — `loadProjectAgentsSkills(repo)` returns 14 skills including the target, proving the
skill file itself parses and is discoverable:

```
agents_count=14 harness_keys=["harness-findings-review"]
agents_keys=["codex-qa","get-unpublished-changes","github-triage",
 "harness-findings-review","hyperplan","omomomo","opencode-qa","pre-publish-review",
 "publish","remove-deadcode","security-research","tech-debt-audit","work-with-pr",
 "work-with-pr-workspace/iteration-1/benchmark"]
```

…yet the TUI only ever offered the ungated sets: `.opencode/command/*.md` (5 files) and
`.opencode/skills/*` (5 dirs). The target was in neither.

After — `loadOpencodeProjectCommands(repo)`:

```
keys=["get-unpublished-changes","harness-findings-review","omomomo","publish",
      "remove-deadcode","security-research"]
hfr_desc="(opencode-project) Review, triage, and re-verify the harness findings log at
          docs/troubleshooting/harness-findings.md"
```

The command is registered with the expected `(opencode-project)` scope prefix.

Structural parity against the existing `security-research.md` alias (same pattern, same
loader path):

```
sec_open=2 sec_close=2 sec_userreq=2 sec_args=2
hfr_open=2 hfr_close=2 hfr_userreq=2 hfr_args=2
structural_match=true
```

Template body resolves to `skill(name="harness-findings-review")`, matching the established
alias form. (The doubled tag counts are the loader's own wrapping and appear identically on
the pre-existing command, so they are not a defect introduced here.)

Isolation: read-only probes plus one new file. `git status --porcelain` before the change
showed a single unrelated modified file (`packages/omo-senpi/plugin/extensions/omo-task.js`),
untouched by this work. No user config, no `~/.omo`, no opencode DB written. Temporary probe
scripts were removed in the same command that ran them.

## Why it is enough

The claim is narrow — "this file makes the command discoverable" — and it was verified by
executing the exact production loader that populates `params.config.command`, not by
inspection. Scope parity with an already-shipped alias covers rendering/format risk. The
change adds one file to a directory whose contents are additive by construction, so
regression risk to other commands is limited to a name collision, and the returned key list
confirms none.

Not covered: a live TUI keystroke test of the autocomplete dropdown. The dropdown is fed
from the same `config.command` record this probe reads, so the residual risk is a TUI-side
filter, not discovery.

## What was omitted

Nothing redacted. No secrets, tokens, or credentials were read or emitted; the user config
was inspected only for the two boolean flags named above.

## Residual risk / follow-up

The underlying defect stands: project-scope `.agents/skills` — the repo's declared migration
target — is gated behind a `claude_code` interop flag, while `.opencode/skills` is not. Any
project skill placed only under `.agents/skills` is invisible to the TUI whenever a user sets
`claude_code.skills: false`. This alias fixes one skill, not the class. Worth a separate PR to
ungate project `.agents/skills` discovery.
