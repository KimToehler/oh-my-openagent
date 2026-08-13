# Follow-Up: Blocked-Subagent Escalation Documentation Gaps

**Origin:** Merged PR `fd8d10ef2` (blocked-subagent escalation: `report_blocked` tool + probe script).
**Scope:** Documentation only. No production code changes.
**Status:** Resolved. Three gaps closed: 6380531b7 (features.md row), 09e85aa54 (AGENTS.md counts), 2a516c28a (SKILL.md script rows). Fourth gap discovered and fixed: 8073003e7 (indexed lsp-e2e.sh). Fifth gap discovered and fixed: d6f98fce5 (docs/AGENTS.md file count).

---

## Context

The blocked-subagent escalation feature shipped `report_blocked` (a new always-on registry tool), `blocked-escalation-probe.sh` (a new opencode-qa probe script), and supporting background-agent plumbing. The implementation is complete and merged. Three documentation surfaces were not updated alongside it.

## Tracked Items

### 1. User-facing docs for `report_blocked`

**Target file:** `docs/reference/features.md`

**Gap:** `report_blocked` has no entry in the Delegation Tools table (lines 681-686). Users reading the features reference cannot discover that background subagents can self-park when blocked.

**Acceptance criteria:**
- Add a row to the Delegation Tools table in `docs/reference/features.md` for `report_blocked`.
- Description must state: callable only by background subagents; parks the calling task; wakes the parent with an actionable notification containing `reason` and `needs`; parent resumes via plain-text answer.
- Match the table formatting of the existing rows (`| **tool_name** | Description |`).

### 2. Root `AGENTS.md` tool-catalog count correction

**Target file:** `AGENTS.md` (root)

**Gap:** Line 160 says `Always on (12 registry tools)` and lists 12 tools. `report_blocked` is registered unconditionally in `packages/omo-opencode/src/plugin/tool-registry.ts` (line 62, no config gate), making the correct count 13.

**Acceptance criteria:**
- Change `Always on (12 registry tools)` to `Always on (13 registry tools)`.
- Add `report_blocked` to the tool list on that line, positioned after `background_cancel`.
- The overview line (line 61) that says `12-38 registry tools` must also update to `13-39 registry tools` (13 always-on plus 26 conditional = 39 total).
- Do NOT change any other content in `AGENTS.md`.

### 3. Register `blocked-escalation-probe.sh` in opencode-qa `SKILL.md`

**Target file:** `.agents/skills/opencode-qa/SKILL.md`

**Gap:** The script index table (starting at line 180) lists all probe/helper scripts but does not include `scripts/blocked-escalation-probe.sh`, which already exists on disk.

**Acceptance criteria:**
- Add a row to the script table in `.agents/skills/opencode-qa/SKILL.md` for `blocked-escalation-probe.sh`.
- Description in the Self-test column must state: `--self-test` mode asserts that `task` and `report_blocked` tool calls are emitted, the reminder matcher rejects a no-reminder stream and accepts a reminder marker, and the duplicate-reminder counter counts every occurrence. (Live-run behavior, where a background subagent blocks and parent receives the wake notification, belongs in the ROUTER table column, not here.)
- Include the correct category column (B for hook/event proof, matching `sse-hook-probe.sh`).
- Do NOT modify the script itself or any other part of the SKILL.md.

---

## Required QA / Evidence

Each item is a doc-only edit. Verification is:

1. **Diff correctness:** `git diff` shows only the three target files changed, only the described lines touched.
2. **Link/render check:** open `docs/reference/features.md` and `.agents/skills/opencode-qa/SKILL.md` in a Markdown renderer (or `glow` / `mdcat`) and confirm the tables render with the new row.
3. **Count arithmetic:** grep `Always on (` in `AGENTS.md` and confirm the number inside parentheses matches the count of tools listed on that line.
4. **No production code touched:** `git diff --stat` must show zero `.ts`, `.js`, `.mjs`, `.json`, `.toml`, or `dist/` files.

No isolated-harness QA (opencode-qa / codex-qa skills) is required because no code, hook, tool, or config is modified. The change is pure prose.

## Out of Scope

- Modifying production TypeScript, generated `dist/`, `package.json`, existing evidence files.
- Modifying the `report_blocked` tool itself or its tests.
- Modifying `blocked-escalation-probe.sh`.
- Any change to `packages/omo-opencode/src/`.

## Delivery

Doc-only follow-up. Land as a normal merge-commit PR if repository policy requires it (root `AGENTS.md` is a tracked file). Otherwise commit directly to the branch and merge.
