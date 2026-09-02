---
name: review-work
description: "Post-implementation merge gate and review orchestrator. Launches 5 parallel background sub-agents: Oracle (goal/constraint verification), Oracle (code quality, run twice cross-engine when two differently-backed reviewers exist), Oracle (security), unspecified-high (hands-on QA execution), unspecified-high (context mining from GitHub/git/Slack/Notion). All must pass for review to pass. This IS the security lane - a process that points at a separate security review is satisfied by running this. USE before merging any PR whose change is production code that is multi-file, cross-cutting, or adds a new surface; SKIP for typo, formatting, docs-only, dependency-bump, or revert changes, and state that you skipped it. Triggers: 'review work', 'review my work', 'review changes', 'QA my work', 'verify implementation', 'check my work', 'validate changes', 'post-implementation review', 'ready to merge', 'before merging'."
---
## Codex Harness Tool Compatibility

This skill may include examples copied from the OpenCode harness. In Codex, do not call OpenCode-only tools such as `call_omo_agent(...)`, `task(...)`, `background_output(...)`, or `team_*(...)` literally. Translate those examples to Codex native tools:

| OpenCode example | Codex tool to use |
| --- | --- |
| `call_omo_agent(subagent_type="explore", ...)` | `multi_agent_v1.spawn_agent({"message":"TASK: act as an explorer. ...","agent_type":"explorer","fork_context":false})` |
| `call_omo_agent(subagent_type="librarian", ...)` | `multi_agent_v1.spawn_agent({"message":"TASK: act as a librarian. ...","agent_type":"librarian","fork_context":false})` |
| `task(subagent_type="plan", ...)` | `multi_agent_v1.spawn_agent({"message":"TASK: act as a planning agent. ...","agent_type":"plan","fork_context":false})` |
| `task(subagent_type="oracle", ...)` for final verification | `multi_agent_v1.spawn_agent({"message":"TASK: act as a rigorous reviewer. ...","agent_type":"lazycodex-gate-reviewer","fork_context":false})` |
| `task(category="...", ...)` for implementation or QA | `multi_agent_v1.spawn_agent({"message":"TASK: act as an implementation or QA worker. ...","fork_context":false})` |
| `background_output(task_id="...")` | `multi_agent_v1.wait_agent(...)` for mailbox signals |
| `team_*(...)` | Use Codex native subagents via `multi_agent_v1.spawn_agent` and `multi_agent_v1.wait_agent`; use `multi_agent_v1.send_input` and `multi_agent_v1.close_agent` only when exposed in the active tools list |

Role-specific behavior must be described in a self-contained `message`. Use `fork_context: false` to start the child with only the initial prompt (no parent history); use `fork_context: true` only when full parent history is truly required. Include any required conversation context, files, diffs, constraints, and requested skill names directly in the spawned agent's `message`. OMO installs these selectable agent roles into `~/.codex/agents/`: `explorer`, `librarian`, `plan`, `momus`, `metis`, `lazycodex-code-reviewer`, `lazycodex-qa-executor`, and `lazycodex-gate-reviewer` — pass the matching name as `agent_type` so the child gets that role's model and instructions. If the spawn tool exposes no `agent_type` parameter, omit it and describe the role inside `message`. If a code block below conflicts with this section, this section wins.

Codex exposes ONE of two subagent tool surfaces per session; check your own tool list and route accordingly. If `multi_agent_v1.*` tools exist, use the table above as written. If instead a flat `spawn_agent` with a required `task_name` exists (`multi_agent_v2`), rewrite every `multi_agent_v1.*` example: `multi_agent_v1.spawn_agent({...,"fork_context":false})` becomes `spawn_agent({"task_name":"<lowercase_digits_underscores>","message":...,"agent_type":...,"fork_turns":"none"})` (`"all"` only when full parent history is truly required); `send_input` becomes `send_message`; do not call `close_agent`/`resume_agent` (finished agents end on their own; `followup_task` re-tasks one, `interrupt_agent` stops one); `wait_agent` takes only `timeout_ms` and returns on any child mailbox activity. `agent_type` works the same on both surfaces. If a code block below conflicts with this section, this section wins.

For work likely to exceed one wait cycle, require the child to send `WORKING: <task> - <current phase>` before long passes and `BLOCKED: <reason>` only when progress stops. A `multi_agent_v1.wait_agent` timeout only means no new mailbox update arrived. Treat a running child as alive. Fallback only when the child is completed without the deliverable, ack-only after followup, explicitly `BLOCKED:`, or no longer running.

## Codex Subagent Reliability

Every `multi_agent_v1.spawn_agent` message must be self-contained. Start with
`TASK: <imperative assignment>`, then name `DELIVERABLE`, `SCOPE`, and
`VERIFY`. State that it is an executable assignment, not a context
handoff. Role or specialty instructions belong inside `message`.
Use `fork_context: false` unless full history is truly
required; paste only the review context that worker needs.

Review lanes are leaf agents: a lane does its own reading, running, and
judging inline and never spawns sub-reviewers of its own. Reviewers are
one-shot: a lane ends at its verdict; a re-review after fixes is a fresh
spawn scoped to the delta plus current evidence, never a `followup_task`
to a long-lived reviewer carrying stale context.

Plan and reviewer agents may run for a long time; spawn them in the background and keep doing independent root work. Between `multi_agent_v1.wait_agent` calls, back off — double the timeout up to ~5 minutes — instead of spinning short cycles.

Treat child status as a progress signal, not a timeout counter. For
work likely to exceed one wait cycle, require the child to send
`WORKING: <task> - <current phase>` before long reading, testing, or
review passes, and `BLOCKED: <reason>` only when it cannot progress.
While any child is active, keep the parent visibly alive with active
subagent count, agent names, latest `WORKING:` phase, and whether the
parent is waiting for mailbox updates. Track spawned agent names
locally. Use `multi_agent_v1.wait_agent` for mailbox signals, not proof of completion.
A timeout only means no new mailbox update arrived. Treat a running child as alive.
Fallback only when the child is
completed without the deliverable, ack-only after followup, explicitly
`BLOCKED:`, or no longer running. Then mark that review lane
`INCONCLUSIVE`, do not count it as PASS or approval, close if safe, and
respawn a smaller `fork_context: false` reviewer with the missing
deliverable. Preserve completed lane results immediately. If the retry
budget is exhausted, keep the lane `INCONCLUSIVE` and still emit a final
aggregate result.

# Review Work - 5-Agent Parallel Review Orchestrator

Launch 5 specialized sub-agents in parallel to review completed implementation work from every angle. All 5 must pass for the review to pass. If even ONE fails, the review fails.

The 5 agents cover complementary concerns - together they form a comprehensive review that no single reviewer could match:

| # | Agent | Type | Role | Focus Level |
|---|-------|------|------|-------------|
| 1 | Goal Verifier | Oracle | Did we build what was asked? | MAIN |
| 2 | QA Executor | unspecified-high | Does it actually work? | MAIN |
| 3 | Code Reviewer | Oracle | Is the code well-written? | MAIN |
| 4 | Security Auditor | Oracle | Is it secure? | MAIN |
| 5 | Context Miner | unspecified-high | Did we miss any context? | MAIN |

---

## When to use

Five parallel lanes, three of them high-cost reasoning agents, is the right
weight for a change that can plausibly be wrong in a way review would catch. It
is the wrong weight for a change whose failure mode is "it does not compile".
Run the full gate when the change is production code AND at least one of the
following is true.

| Context | Run the full 5 lanes? |
|---|---|
| Multi-file change to production code | **Yes** |
| Adds a new surface: endpoint, tool, hook, agent, CLI command, config key | **Yes** |
| Cross-cutting change: touches auth, persistence, concurrency, money, PII | **Yes** |
| Changes a security boundary, permission check, or input-handling path | **Yes** |
| Before merging a non-trivial PR | **Yes** |
| Inheriting unfamiliar code, or reviewing someone else's branch | **Yes** |
| Single-file change with an obvious blast radius | Lanes 1 and 3 only |
| Typo, comment, formatting, lint-only, generated-file refresh | **No** |
| Dependency bump with no code change and a green lockfile diff | **No** |
| Documentation-only change (`*.md`, no code path) | **No** |
| Revert of a commit that was itself reviewed | **No** |
| Per-slice review during execution, before the work is finished | **No** - review the finished branch instead |

Two rules keep the gate honest.

**Skipping is a decision you state, not one you make silently.** When you skip,
say which rule let you skip and what the change was. "Skipped review-work:
dependency bump, lockfile-only diff" is a complete record. Silence is not.

**Partial runs are legitimate.** A single-file production change usually needs
goal conformance and code quality, not hands-on QA and context mining. Run the
lanes that can find something, name the ones you did not run, and do not call
the result a passed full review.

The cost asymmetry runs one way. A skipped review on a change that needed one
ships a defect; a review run on a change that did not need one costs minutes.
When genuinely unsure, run it.

---

## Relationship to other gates

This skill is one gate among several, and the boundaries matter because a gap
between two gates is where defects live.

| Gate | Covers | Runs when |
|---|---|---|
| Per-slice code review | One slice, local quality, as it is written | During execution |
| `integration-review` | Composition failures across the whole branch: duplication, naming drift, uneven APIs, missing abstractions, dead code, doc drift | End of multi-slice work |
| **`review-work`** (this) | Goal conformance, hands-on QA, code quality, **security**, missed context | Before a PR handoff or merge |
| Harness-specific QA | Whether the change works against the real runtime, with recorded evidence | Whenever the change touches that harness |

`integration-review` and `review-work` are complements, not alternatives.
`integration-review` reads the whole change at once and asks "is this
well-composed?". `review-work` asks "is this correct, does it run, is it safe,
and did we miss anything?". A large branch usually wants both, in that order:
compose first, then verify.

**`review-work` IS the security lane.** Lane 4 is a dedicated security audit.
Any gate that routes security elsewhere with a "use a separate security review"
pointer is satisfied by running this skill - there is no third gate to chase,
and no separate invocation to remember. If a review process names both, running
`review-work` discharges the security obligation. Reach for a standalone
security audit only when the change is security-critical enough to want more
than one lane on it: a new authentication path, a change to a trust boundary, or
anything handling untrusted input at scale.

The one gap worth naming: `review-work` reviews the change. It does not review
the plan that produced the change. If the work was driven by a written plan,
lane 1 below is where plan conformance is checked.

---

## Cross-engine lane assignment

Two reviewers backed by the same model are two samples, not two opinions. They
share training data, share blind spots, and agree with each other for reasons
that have nothing to do with the code being correct. Agreement between them
reads like confirmation and is not.

Genuine cross-engine review needs reviewers whose *backends* differ, not whose
prompts differ. Where the harness can supply that, use it.

**Lane 3 (code quality) is the cross-engine lane.** Code quality is the
judgment call most improved by a genuinely different reader: what one model
treats as idiomatic another flags as a foot-gun. When two differently-backed
reviewers are available, run lane 3 twice - once per engine - on identical
input, and merge their findings with the reconciliation procedure below. The
lane produces ONE verdict, not two.

**Lane 1 (goal and constraint verification) is where a plan-critic engine
fits.** Checking an implementation against a stated goal and a fixed constraint
list is conformance checking, which is what a plan critic does well. If the
harness offers a dedicated plan/spec critic, lane 1 is the only lane it belongs
in - and only when the work was driven by a written plan, with that plan as the
input.

**A plan critic cannot review a code diff.** It expects a plan or spec as input
and will reject, or worse silently mishandle, a raw diff. Never route lanes 2
through 5 to one. The same applies to any pre-planning consultant. Reviewing
code is the reasoning agent's job.

**Determining what is actually available.** Do not infer a reviewer's backend
from its name, and do not hardcode model identifiers into a review plan. Model
routing is per-user configuration: two differently-named agents can resolve to
the same backend, and one agent can resolve to different backends for different
users. Check the harness's own agent and model configuration to find which
reviewers are backed differently.

**When a second engine is not available, say so.** Run lane 3 once and record
the lane as single-engine. A single-engine lane 3 is a valid PASS - it is simply
a weaker one, and the report should not imply cross-validation that did not
happen. Never fabricate a second opinion by running the same backend twice under
a different label.

---

## Reconciling findings

This procedure applies to any lane that produced findings, and is mandatory for
a two-engine lane 3. It is the step that converts raw reviewer output into
something worth acting on.

**Dedup first.** Same defect, same location, same reason means one finding, not
two. Note when both engines flagged it - independent agreement across different
backends is real signal, unlike agreement between two samples of one model.
Keep correctness findings ahead of style ones.

**Then validate every surviving finding against the actual code.** A reviewer's
verdict is input, not instruction. Read the cited lines and the enclosing
function. Trace callers and callees when the claim depends on them. Where a
finding claims a regression, check what the merge base actually contained rather
than trusting the description. Classify each:

- **CONFIRMED** - the failure path is reproducible in the code. Fix it.
- **PLAUSIBLE** - realistic but state-dependent. Fix if low-risk and in scope; otherwise surface with a recommendation.
- **REFUTED** - factually wrong, already guarded, or pure style asserted as a defect. Quote the line that disproves it.
- **INTENTIONAL** - a deliberate documented choice. Cite the comment, commit, or design note.

Shipping a fix for a defect that does not exist is its own regression. A
disproved finding is recorded as rejected with its evidence, never silently
dropped - the reader needs to see it was considered.

**Report in three buckets**, most severe first: fixed (with the verification
result), confirmed but not fixed (with the reason and a recommendation), and
reviewed and dismissed (one line each with the evidence).

---

## Phase 0: Gather Review Context

Before launching agents, collect these inputs. Extract from conversation history first - the user's original request, constraints discussed, and decisions made are usually already in the thread. Only ask if truly missing.

<required_inputs>

- **GOAL**: The original objective. What was the user trying to achieve? Pull from the initial request in this conversation.
- **CONSTRAINTS**: Rules, requirements, or limitations. Tech stack restrictions, performance targets, API contracts, design patterns to follow, backward compatibility needs.
- **BACKGROUND**: Why this work was needed. Business context, user stories, related systems, prior decisions that informed the approach.
- **CHANGED_FILES**: Auto-collect via `git diff --name-only HEAD~1` or against the appropriate base (branch point, specific commit).
- **DIFF**: Auto-collect via `git diff HEAD~1` or against the appropriate base.
- **FILE_CONTENTS**: Read the full content of each changed file (not just the diff). Inline it in the Oracle prompts. Oracle has `read`/`grep`/`glob`, so it CAN open files itself, but every lookup is a round-trip the orchestrator already paid for - front-load the content and let Oracle spend its budget on reasoning.
- **RUN_COMMAND**: How to start/run the application. Check `package.json` scripts, `Makefile`, `docker-compose.yml`, or ask the user.

</required_inputs>


Review PRs and branches from a dedicated review worktree only: create or attach one with `git worktree add <path> <branch>` before collecting changed files, diff, file contents, or running checks, then immediately lock it with `git worktree lock <path> --reason "review:<pr-or-branch>"`. The main worktree is read-only context; never checkout, test, or edit the review branch there.

**Auto-collection sequence:**

```bash
# 1. Get changed files
git diff --name-only HEAD~1  # or: git diff --name-only main...HEAD

# 2. Get diff
git diff HEAD~1  # or: git diff main...HEAD

# 3. Detect run command
# Check package.json -> "scripts.dev" or "scripts.start"
# Check Makefile -> default target
# Check docker-compose.yml -> services
```

**CRITICAL:** If the collected range (CHANGED_FILES or DIFF) is empty, the work is likely already merged or you are standing on the wrong branch. Do NOT review an empty range - stop and ask the user for an explicit commit range (e.g. the merge commit's `^1..HEAD` or a specific `commit-a..commit-b` range).

For GOAL, CONSTRAINTS, BACKGROUND - review the full conversation history. The user's original message almost always contains the goal. Constraints often emerge during discussion. If anything critical is ambiguous, ask ONE focused question - not a checklist.

---

## Phase 1: Launch 5 Agents

Launch ALL 5 in a single turn. Every agent uses `run_in_background=true`. No sequential launches. No waiting between them.

**Oracle agents are read-only, not blind.** Oracle is denied `write`, `edit`, `apply_patch`, and `task`, and is explicitly granted `read`, `grep`, and `glob`. It can open any file in the repo and verify a claim against the tree.

Front-load DIFF + FILE_CONTENTS + all context into the prompt anyway - that is what makes the review fast - but NEVER tell Oracle it cannot read files. That instruction is false, and it makes Oracle guess from memory instead of checking. A reviewer that reasons about timing constants or line numbers from a paraphrase will produce confident, wrong findings. Tell it the context is provided for speed and that it should verify anything load-bearing against the actual files.

**unspecified-high agents are autonomous** - they can read files, run commands, and use tools. Give them goals and pointers, not raw content dumps.

**Verify every blocker before you act on it.** Reviewer verdicts are input, not instruction. Before fixing a reported blocker, reproduce it yourself: run the failing command, execute the arithmetic, read the cited line. Reviewers do return confidently-wrong findings, and shipping a "fix" for a defect that does not exist is its own regression. A finding you disproved gets recorded as rejected with the evidence, not silently dropped.

**Scope your verification runs to the whole repo, not just the changed directories.** A scoped `test <dir>` run can be green while CI fails: duplicated or re-exporting test files outside your diff still exercise the code you changed. Run whatever CI runs before you call a review passed.

---

### Agent 1: Goal & Constraint Verification (Oracle) - MAIN

This agent answers: "Did we build exactly what was asked, within the rules we were given?"

```
task(
  subagent_type="oracle",
  run_in_background=true,
  load_skills=[],
  description="Verify implementation against original goal and constraints",
  prompt="""
<review_type>GOAL & CONSTRAINT VERIFICATION</review_type>

<original_goal>
{GOAL - paste the user's original request and any clarifications}
</original_goal>

<constraints>
{CONSTRAINTS - every rule, requirement, or limitation discussed}
</constraints>

<background>
{BACKGROUND - why this work was needed, broader context}
</background>

<changed_files>
{CHANGED_FILES - list of modified file paths}
</changed_files>

<file_contents>
{FILE_CONTENTS - full content of every changed file, clearly delimited per file}
</file_contents>

<diff>
{DIFF - the actual git diff}
</diff>

Review whether this implementation correctly and completely achieves the stated goal within the given constraints. Be obsessively thorough - the point of this review is to catch what the implementer missed.

REVIEW CHECKLIST:

1. **Goal Completeness**: Break the goal into every sub-requirement (explicit AND implied). For each, mark ACHIEVED / MISSED / PARTIAL. Missing even one implied requirement that a reasonable engineer would have addressed = PARTIAL at minimum.

2. **Constraint Compliance**: List every constraint. For each, verify compliance with specific code evidence. A constraint violated = automatic FAIL.

3. **Requirement Gaps**: Requirements the user clearly wanted but didn't spell out. Things implied by the goal or background that a thoughtful engineer would have included.

4. **Over-Engineering**: Anything added that wasn't requested - unnecessary abstractions, extra features, premature optimizations, speculative generality. Flag these as scope creep.

5. **Edge Cases**: Given the goal, what inputs or scenarios would break this? Trace through at least 5 edge cases mentally.

6. **Behavioral Correctness**: Walk through the code logic for 3+ representative scenarios. Does the code actually produce the expected behavior in each case?

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<confidence>HIGH / MEDIUM / LOW</confidence>
<summary>1-3 sentence overall assessment</summary>
<goal_breakdown>
  For each sub-requirement:
  - [ACHIEVED/MISSED/PARTIAL] Requirement description
  - Evidence: specific code reference or gap
</goal_breakdown>
<constraint_compliance>
  For each constraint:
  - [ACHIEVED/MISSED] Constraint description - evidence
</constraint_compliance>
<findings>
  - [PASS/FAIL/WARN] Category: Description
  - File: path (line range if applicable)
  - Evidence: specific code or logic reference
</findings>
<blocking_issues>Issues that MUST be fixed. Empty if PASS.</blocking_issues>
""")
```

---

### Agent 2: QA via App Execution (unspecified-high) - MAIN

This agent answers: "Does it actually work when you run it?"

The QA agent follows a structured process: brainstorm scenarios exhaustively first, then self-review and augment, then create a task list, then execute systematically.

```
task(
  category="unspecified-high",
  run_in_background=true,
  load_skills=["browser:control-in-app-browser", "playwright", "dev-browser"],
  description="QA by actually running and using the application",
  prompt="""
<review_type>QA - HANDS-ON APP EXECUTION</review_type>

<original_goal>
{GOAL}
</original_goal>

<constraints>
{CONSTRAINTS}
</constraints>

<changed_files>
{CHANGED_FILES}
</changed_files>

<run_command>
{RUN_COMMAND - how to start the application, or "unknown" if not determined}
</run_command>

You are a QA engineer. Your job is to RUN the application and verify it works through hands-on testing. You do not review code - you test behavior.

If the orchestrator already ran the `visual-qa` dual-oracle gate on this same build, consume that verdict instead of re-running it - your lane covers hands-on behavior the visual gate does not.

MANDATORY PROCESS (follow in order):

### Step 1: Scenario Brainstorm

Before touching the app, write down EVERY test scenario you can think of. Be exhaustive. Think about:

- **Happy paths**: The primary use cases this implementation enables. What's the main thing the user wanted to do?
- **Boundary conditions**: Empty inputs, maximum-length inputs, zero values, negative numbers, special characters, unicode, very large datasets.
- **Error paths**: Invalid inputs, network failures, missing files, permission denied, timeout conditions.
- **Regression scenarios**: Existing features that touch the same code paths. Things that worked before and must still work.
- **State transitions**: What happens when you do things out of order? Rapid repeated actions? Concurrent usage?
- **UX scenarios** (if applicable): Layout on different sizes, keyboard navigation, screen reader compatibility, loading states, error messages.
- **Integration points**: Does this feature interact with external services, databases, or other modules? Test those boundaries.

Write each scenario as a one-liner with expected behavior. Aim for 15-30 scenarios minimum.

### Step 2: Scenario Augmentation

Review your scenario list with fresh eyes. For each scenario, ask:
- "What could go wrong here that I haven't considered?"
- "What would a malicious or careless user do?"
- "What environmental conditions could affect this?" (disk full, slow network, expired tokens)

Add at least 5 more scenarios from this reflection. Group scenarios by priority: P0 (must pass), P1 (should pass), P2 (nice to pass).

### Step 3: Create Task List

Convert your augmented scenario list into a structured task list (use TaskCreate/TaskUpdate or your todo system). Each task = one test scenario with:
- Test name
- Steps to execute
- Expected result
- Priority (P0/P1/P2)

### Step 4: Execute Systematically

Work through the task list in priority order (P0 first). For each test:

1. Execute the test steps
2. Record actual result
3. Compare with expected result
4. Mark PASS or FAIL
5. If FAIL: capture evidence (screenshot, terminal output, error message)
6. Mark the task complete

**Execution guidance by app type:**
- **Web app**: In Codex, use `browser:control-in-app-browser` first for browser work that does not need an authenticated user session. Fall back to playwright/dev-browser when the Browser plugin is unavailable, lacks the needed action, or the test specifically needs a persistent/authenticated browser profile. Navigate, click, fill forms, and verify visual output through the chosen browser surface.
- **CLI tool**: Run commands with various arguments, pipe inputs, check exit codes and output.
- **Library/SDK**: Write and execute a test script that imports and exercises the public API.
- **Backend API**: Use curl/httpie to hit endpoints with various payloads, verify response codes and bodies.
- **Mobile/Desktop**: If not directly runnable, write integration tests and execute them.

If the app cannot be started (build failure), that's an immediate FAIL - no need to continue.

### Step 5: Compile Results

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<confidence>HIGH / MEDIUM / LOW</confidence>
<summary>1-3 sentence overall assessment</summary>
<scenario_coverage>
  Total scenarios: N
  P0: X tested, Y passed
  P1: X tested, Y passed
  P2: X tested, Y passed
</scenario_coverage>
<test_results>
  For each test:
  - [PASS/FAIL] Test name (Priority)
  - Steps: What you did
  - Expected: What should happen
  - Actual: What actually happened
  - Evidence: Screenshot path or terminal output snippet (if FAIL)
</test_results>
<blocking_issues>P0 or P1 failures only. Empty if PASS.</blocking_issues>
""")
```

---

### Agent 3: Code Quality Review (Oracle, Auditor) - MAIN - CROSS-ENGINE LANE

This agent answers: "Is the code well-written, maintainable, and consistent with the codebase?"

This is the lane to run twice when the harness offers two differently-backed
reviewers - see "Cross-engine lane assignment" above. Launch Oracle with the
prompt below, then launch Auditor with the identical prompt. Auditor is the
independent second-engine lane only; keep Oracle in every other Oracle lane.
Reconcile findings into ONE lane verdict using "Reconciling findings".
Independent agreement between different backends raises confidence; a
disagreement is the finding worth reading first. If only one reviewer backend
exists, run it once and record the lane as single-engine.

```
task(
  subagent_type="oracle",
  run_in_background=true,
  load_skills=[],
  description="Review overall code quality, patterns, and architecture",
  prompt="""
<review_type>CODE QUALITY REVIEW</review_type>

<changed_files>
{CHANGED_FILES}
</changed_files>

<file_contents>
{FILE_CONTENTS - full content of changed files AND neighboring files that show existing patterns}
</file_contents>

<diff>
{DIFF}
</diff>

<background>
{BACKGROUND}
</background>

You are a senior staff engineer conducting a code review. Your standard: "Would I approve this PR without comments?"

REVIEW DIMENSIONS (examine each):

1. **Correctness**: Logic errors, off-by-one, null/undefined handling, race conditions, resource leaks, unhandled promise rejections.

2. **Pattern Consistency**: Does new code follow the codebase's established patterns? Compare with the neighboring files provided. Introducing a new pattern where one already exists = finding.

3. **Naming & Readability**: Clear variable/function/type names? Self-documenting code? Would another engineer understand this without explanation?

4. **Error Handling**: Errors properly caught, logged, and propagated? No empty catch blocks? No swallowed errors? User-facing errors are helpful?

5. **Type Safety**: Any `as any`, `@ts-ignore`, `@ts-expect-error`? Proper generic usage? Correct type narrowing? (If TypeScript/typed language)

6. **Performance**: N+1 queries? Unnecessary re-renders? Blocking I/O on hot paths? Memory leaks? Unbounded growth?

7. **Abstraction Level**: Right level of abstraction? No copy-paste duplication? But also no premature over-abstraction?

8. **Testing**: New behaviors covered by tests? Tests are meaningful, not just coverage padding? Test names describe scenarios?

9. **API Design**: Public interfaces clean and consistent with existing APIs? Breaking changes flagged?

10. **Tech Debt**: Does this introduce new tech debt? Or create coupling that will be painful to change?

Categorize each finding by severity:
- **CRITICAL**: Will cause bugs, data loss, or crashes in production
- **MAJOR**: Significant quality issue that should be fixed before merge
- **MINOR**: Improvement worth making but not blocking
- **NITPICK**: Style preference, optional

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<confidence>HIGH / MEDIUM / LOW</confidence>
<summary>1-3 sentence overall assessment</summary>
<findings>
  - [CRITICAL/MAJOR/MINOR/NITPICK] Category: Description
  - File: path (line range)
  - Current: what the code does now
  - Suggestion: how to improve
</findings>
<blocking_issues>CRITICAL and MAJOR items only. Empty if PASS.</blocking_issues>
""")

task(
  subagent_type="auditor",
  run_in_background=true,
  load_skills=[],
  description="Independent second-engine code quality review",
  prompt="""
<review_type>CODE QUALITY REVIEW</review_type>

<changed_files>
{CHANGED_FILES}
</changed_files>

<file_contents>
{FILE_CONTENTS - full content of changed files AND neighboring files that show existing patterns}
</file_contents>

<diff>
{DIFF}
</diff>

<background>
{BACKGROUND}
</background>

You are a senior staff engineer conducting a code review. Your standard: "Would I approve this PR without comments?"

REVIEW DIMENSIONS (examine each):

1. **Correctness**: Logic errors, off-by-one, null/undefined handling, race conditions, resource leaks, unhandled promise rejections.

2. **Pattern Consistency**: Does new code follow the codebase's established patterns? Compare with the neighboring files provided. Introducing a new pattern where one already exists = finding.

3. **Naming & Readability**: Clear variable/function/type names? Self-documenting code? Would another engineer understand this without explanation?

4. **Error Handling**: Errors properly caught, logged, and propagated? No empty catch blocks? No swallowed errors? User-facing errors are helpful?

5. **Type Safety**: Any `as any`, `@ts-ignore`, `@ts-expect-error`? Proper generic usage? Correct type narrowing? (If TypeScript/typed language)

6. **Performance**: N+1 queries? Unnecessary re-renders? Blocking I/O on hot paths? Memory leaks? Unbounded growth?

7. **Abstraction Level**: Right level of abstraction? No copy-paste duplication? But also no premature over-abstraction?

8. **Testing**: New behaviors covered by tests? Tests are meaningful, not just coverage padding? Test names describe scenarios?

9. **API Design**: Public interfaces clean and consistent with existing APIs? Breaking changes flagged?

10. **Tech Debt**: Does this introduce new tech debt? Or create coupling that will be painful to change?

Categorize each finding by severity:
- **CRITICAL**: Will cause bugs, data loss, or crashes in production
- **MAJOR**: Significant quality issue that should be fixed before merge
- **MINOR**: Improvement worth making but not blocking
- **NITPICK**: Style preference, optional

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<confidence>HIGH / MEDIUM / LOW</confidence>
<summary>1-3 sentence overall assessment</summary>
<findings>
  - [CRITICAL/MAJOR/MINOR/NITPICK] Category: Description
  - File: path (line range)
  - Current: what the code does now
  - Suggestion: how to improve
</findings>
<blocking_issues>CRITICAL and MAJOR items only. Empty if PASS.</blocking_issues>
""",
)
```

---

### Agent 4: Security Review (Oracle) - MAIN

This agent answers: "Are there security vulnerabilities in these changes?"

This lane is focused, not optional. It comments exclusively on security and
stays silent on style, architecture, and functionality unless those directly
create a security risk - a narrow remit, run at full weight. This is the lane
that discharges the security obligation for the whole gate, so a FAIL here fails
the review exactly like any other lane.

```
task(
  subagent_type="oracle",
  run_in_background=true,
  load_skills=[],
  description="Security-focused review of implementation changes",
  prompt="""
<review_type>SECURITY REVIEW (supplementary)</review_type>

<changed_files>
{CHANGED_FILES}
</changed_files>

<file_contents>
{FILE_CONTENTS - full content of changed files}
</file_contents>

<diff>
{DIFF}
</diff>

You are a security engineer. Review this diff exclusively for security vulnerabilities and anti-patterns. Ignore code style, naming, architecture - unless it directly creates a security risk.

SECURITY CHECKLIST:

1. **Input Validation**: User inputs sanitized? SQL injection, XSS, command injection, SSRF vectors?
2. **Auth & AuthZ**: Authentication checks where needed? Authorization verified for each action? Privilege escalation paths?
3. **Secrets & Credentials**: Hardcoded secrets, API keys, tokens in code or config? Secrets in logs?
4. **Data Exposure**: Sensitive data in logs? PII in error messages? Over-exposed API responses?
5. **Dependencies**: New dependencies added? Known CVEs? Suspicious or unnecessary packages?
6. **Cryptography**: Proper algorithms? No custom crypto? Secure random? Proper key management?
7. **File & Path**: Path traversal? Unsafe file operations? Symlink following?
8. **Network**: CORS configured correctly? Rate limiting? TLS enforced? Certificate validation?
9. **Error Leakage**: Stack traces exposed to users? Internal details in error responses?
10. **Supply Chain**: Lockfile updated consistently? Dependency pinning?

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<severity>CRITICAL / HIGH / MEDIUM / LOW / NONE</severity>
<summary>1-3 sentence overall assessment</summary>
<findings>
  - [CRITICAL/HIGH/MEDIUM/LOW] Category: Description
  - File: path (line range)
  - Risk: What could an attacker do?
  - Remediation: Specific fix
</findings>
<blocking_issues>CRITICAL and HIGH items only. Empty if PASS.</blocking_issues>
""")
```

---

### Agent 5: Context Mining (unspecified-high) - MAIN

This agent answers: "Did we miss any context that should have informed this implementation?"

```
task(
  category="unspecified-high",
  run_in_background=true,
  load_skills=["git-master"],
  description="Mine all accessible contexts for missed requirements or background knowledge",
  prompt="""
<review_type>CONTEXT MINING - MISSED REQUIREMENTS & BACKGROUND</review_type>

<original_goal>
{GOAL}
</original_goal>

<constraints>
{CONSTRAINTS}
</constraints>

<changed_files>
{CHANGED_FILES}
</changed_files>

<background>
{BACKGROUND}
</background>

You are an investigator. Your mission: search every accessible information source to find context that should have informed this implementation but might have been missed. The question: "Is there something we should have known but didn't?"

SOURCES TO SEARCH (use every available tool):

1. **Git History** (ALWAYS search):
   - `git log --oneline -20 -- {each changed file}` - recent changes and their reasons
   - `git blame {critical sections}` - who wrote what and when
   - `git log --all --grep="{keywords from goal}"` - related commits
   - Look for reverted commits, TODO/FIXME/HACK comments in history

2. **GitHub** (if `gh` CLI available):
   - `gh issue list --search "{keywords}"` - related open/closed issues
   - `gh pr list --search "{keywords}" --state all` - related PRs and their review comments
   - Check if any issue is specifically linked to this work
   - Look at review comments on past PRs touching these files

3. **Communication Channels** (if MCP tools available):
   - Slack: search for messages mentioning the feature, file names, or related keywords
   - Notion: search for design docs, RFCs, ADRs related to this feature
   - Discord: relevant discussions

4. **Codebase Cross-References** (ALWAYS search):
   - Files that import or reference the changed modules
   - Tests that might need updating due to behavior changes
   - Documentation (README, docs/, comments) that references changed behavior
   - Config files that might need corresponding updates
   - Related features in the same domain

WHAT TO LOOK FOR:

- Requirements mentioned in issues/PRs that the implementation misses
- Past decisions explaining WHY code was written a certain way - and whether new changes respect those reasons
- Related systems or features affected by these changes
- Warnings from previous developers (PR review comments, inline TODOs, commit messages)
- Migration or deprecation notes that affect the changed code
- Design decisions documented outside the codebase (Notion, Slack, ADRs)

OUTPUT FORMAT:
<verdict>PASS or FAIL</verdict>
<confidence>HIGH / MEDIUM / LOW</confidence>
<summary>1-3 sentence overall assessment</summary>
<sources_searched>
  - [SEARCHED/SKIPPED] Source name - what was searched (or why it wasn't accessible)
</sources_searched>
<discovered_context>
  For each discovery:
  - Source: Where found (git commit abc123, GitHub issue #42, Slack message, etc.)
  - Finding: What was found
  - Relevance: How it relates to the current work
  - Impact: [BLOCKING / IMPORTANT / FYI]
</discovered_context>
<missed_requirements>Requirements the implementation should address but doesn't. Empty if none.</missed_requirements>
<blocking_issues>BLOCKING items only. Empty if PASS.</blocking_issues>
""")
```

## Phase 2: Wait & Collect

After launching all 5 agents in one turn, wait for completions in bounded
cycles. Do not treat a timeout, ack-only reply, or empty child result as
a PASS.

As each completes, collect via the Codex mapping above (`multi_agent_v1.wait_agent`,
then the child's substantive final result). Preserve completed lane
results immediately; never lose a PASS/FAIL because another lane is
still running. Store each verdict independently:

| Agent | Verdict | Notes |
|-------|---------|-------|
| 1. Goal Verification | pending/PASS/FAIL/INCONCLUSIVE | - |
| 2. QA Execution | pending/PASS/FAIL/INCONCLUSIVE | - |
| 3. Code Quality | pending/PASS/FAIL/INCONCLUSIVE | - |
| 4. Security | pending/PASS/FAIL/INCONCLUSIVE | - |
| 5. Context Mining | pending/PASS/FAIL/INCONCLUSIVE | - |

Do NOT deliver the final report until ALL 5 lanes have a terminal state:
PASS, FAIL, or INCONCLUSIVE.
If a lane remains silent after the reliability followup, record it as
inconclusive and respawn a smaller reviewer/worker for that exact lane.
If it still remains unfinished after that retry, close the still-running
agent if safe, keep the lane INCONCLUSIVE, and emit the final aggregate
review result with the incomplete lane named. Do not spin in repeated
wait/followup cycles. Do not use `multi_agent_v1.send_input` as an interrupt; queued
followups are not cancellation.

After ALL 5 lanes reach a terminal state and before delivering the verdict, tear down the review worktree: run `git worktree unlock <path>` followed by `git worktree remove <path>`. The lanes above run inside that worktree, so removing it earlier destroys their working directory; a crashed review leaves the locked tree as a recoverable marker for manual cleanup.

---

## Phase 3: Deliver Verdict

<verdict_logic>

ALL 5 agents returned PASS → **REVIEW PASSED**
ANY agent returned FAIL → **REVIEW FAILED - criteria not met**
ANY lane is INCONCLUSIVE and none failed → **REVIEW INCONCLUSIVE - not approved**

A deliberately partial run (see "When to use") is scored the same way over the
lanes you ran, and reported as **REVIEW PASSED (PARTIAL - lanes N, M)** naming
the lanes you skipped and why. A partial pass is never reported as a full one.
Skipping a lane is a scoping decision made before launch; dropping a lane after
it returned FAIL is not a partial run, it is a failed review.

</verdict_logic>

Compile the final report in this format:

```markdown
# Review Work - Final Report

## Overall Verdict: PASSED / FAILED / INCONCLUSIVE

| # | Review Area | Agent Type | Verdict | Confidence |
|---|------------|------------|---------|------------|
| 1 | Goal & Constraint Verification | Oracle | PASS/FAIL/INCONCLUSIVE | HIGH/MED/LOW |
| 2 | QA Execution | unspecified-high | PASS/FAIL/INCONCLUSIVE | HIGH/MED/LOW |
| 3 | Code Quality | Oracle (name each engine; "single-engine" if only one) | PASS/FAIL/INCONCLUSIVE | HIGH/MED/LOW |
| 4 | Security | Oracle | PASS/FAIL/INCONCLUSIVE | Severity |
| 5 | Context Mining | unspecified-high | PASS/FAIL/INCONCLUSIVE | HIGH/MED/LOW |

## Blocking Issues
[Aggregated from all agents - deduplicated, prioritized]

## Key Findings
[Top 5-10 most important findings across all agents, grouped by theme]

## Recommendations
[If FAILED: exactly what to fix, in priority order]
[If PASSED: non-blocking suggestions worth considering]
```

If FAILED - be specific. The user should know exactly what to fix and in what order. No vague "consider improving X" - state the problem, the file, and the fix.

If PASSED - keep it short. Highlight any non-blocking suggestions, but don't turn a passing review into a lecture.
