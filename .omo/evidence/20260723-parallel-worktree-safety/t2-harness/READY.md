# t2-harness — parallel-worktree-safety QA harness: READY

Status: **BUILT + SELF-TESTED + ISOLATION-PROVEN. Awaiting the start-work
skill override to run the behavioral proof.**

A slim, ONE-run QA harness that proves whether an OmO `start-work` skill
OVERRIDE changes Atlas's parallel-dispatch behavior. This is for a user-config
change (a skill override in `~/.config/opencode/skills/`), not shipped code.

## What was built

Three scripts (copies stored beside this file):

1. **`make-sandbox.sh`** — creates an ISOLATED throwaway git repo (own mktemp
   dir, `git init -b main`, seeds `src/{a,b,c,d}.ts` + `locales/messages.de.json`,
   commits on `main`, branches to `task`). Writes a grammar-valid Prometheus
   plan `.omo/plans/race-test.md` with ONE wave of 4 todos matching row grammar
   `- [ ] N. <title>`, each carrying the NEW `Files:` field:
   - todo 1 → `src/a.ts, locales/messages.de.json`
   - todo 2 → `src/b.ts, locales/messages.de.json`  (OVERLAPS todo 1 via de.json)
   - todo 3 → `src/c.ts`  (disjoint)
   - todo 4 → `src/d.ts`  (disjoint)
   Each todo has a trivial edit instruction, an agent-executable Acceptance
   line, and `Commit: Y`. Prints `SANDBOX_REPO=<path>`.

2. **`run-scenario.sh [--with-override] <sandbox-repo>`** — sources the repo's
   `script/agent/qa-sandbox.sh` (fresh `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/
   `XDG_STATE_HOME`/`XDG_CACHE_HOME` + `CODEX_HOME` under mktemp), copies the
   user's real provider auth (`~/.local/share/opencode/auth.json`) into the
   isolated data dir, registers the OmO plugin (read from the real
   `opencode.json` plugin array, currently `["oh-my-openagent@4.19.1"]`) plus
   `oh-my-openagent.json` model routing into the isolated config. With
   `--with-override` it ALSO copies `~/.config/opencode/skills/{start-work,
   ulw-plan}` into the isolated `$XDG_CONFIG_HOME/opencode/skills/` (READ-ONLY
   copy); without it, baseline. Then `cd`s into the sandbox repo and runs
   `opencode run --format json "start work on the race-test plan"`, capturing
   full stdout JSON. Prints `CAPTURE=<path>`.

3. **`assert-dispatch.sh <session-json> <sandbox-repo>`** — PASS/FAIL report:
   - **(i) burst-overlap**: extracts subagent-spawn tool calls
     (`task`/`spawn_agent`/`call_omo_agent`/`team_task_create`) with timestamps;
     two overlapping-de.json lanes (todo1&2) within `BURST_WINDOW_MS` (default
     1500ms) = FAIL under `MODE=override` (they must be serialized), expected
     under `MODE=baseline`.
   - **(ii) git-add-broad**: any `git add -A` / `git add --all` / `git add .`
     in any bash tool call = FAIL.
   - **(iii) out-of-scope**: any committed file (`git log --name-only` on
     `task`) outside the union of declared `Files:` scopes (ignoring the seed
     plan/gitignore) = FAIL.
   - **`--self-test`**: feeds a synthetic transcript with a planted
     `git add -A`, a same-burst de.json overlap, and a stray committed file;
     asserts the detector flags ALL THREE. **Verified PASS (rc=0).**

## Verification done

- `bash -n` clean on all three scripts.
- `assert-dispatch.sh --self-test` → **PASS** (see `self-test.out`): detector
  flagged all 3 planted violations.
- Isolation proof (see `isolation-proof.txt`): real opencode DB session count
  **681 before == 681 after** a full dry run of `run-scenario.sh`. The spawned
  opencode created its session in the ISOLATED DB only; the real DB was never
  touched.

## Why the full behavioral proof is not run yet

- The override skills do NOT exist yet: `~/.config/opencode/skills/` currently
  contains only `lean-ctx` (no `start-work`, no `ulw-plan`). Per the task,
  building + self-test + isolation proof is the deliverable until the overrides
  land.
- Separately, the user's `oh-my-openagent.json` routes every agent to a custom
  `onara/*` provider that does not resolve inside the throwaway sandbox
  (baseline dry run errored with `UnknownError`). Before the real proof, EITHER
  point the isolated `oh-my-openagent.json` at a provider/model that resolves
  headless, OR ensure the copied `auth.json` provider works in isolation.

## How to run the proof once the override files exist

```bash
cd /tmp/pwsafety-qa.0flcSB   # (or wherever these 3 scripts live)

# 1) build a fresh isolated sandbox repo
SR=$(bash make-sandbox.sh | sed -n 's/^SANDBOX_REPO=//p')

# 2a) BASELINE run (no override skills) -> expect overlapping lanes co-dispatched
CAP_BASE=$(bash run-scenario.sh "$SR" | sed -n 's/^CAPTURE=//p')
MODE=baseline bash assert-dispatch.sh "$CAP_BASE" "$SR"

# 2b) OVERRIDE run (copies ~/.config/opencode/skills/{start-work,ulw-plan})
SR2=$(bash make-sandbox.sh | sed -n 's/^SANDBOX_REPO=//p')   # fresh repo
CAP_OVR=$(bash run-scenario.sh --with-override "$SR2" | sed -n 's/^CAPTURE=//p')
MODE=override bash assert-dispatch.sh "$CAP_OVR" "$SR2"
```

PROOF = the override run's report shows **CHECK (i) burst-overlap: PASS
(override)** (the two de.json lanes were NOT co-dispatched), **(ii) PASS**
(no `git add -A`), and **(iii) PASS** (no out-of-scope commits) — while the
baseline run shows the overlap co-dispatched. That delta is the evidence the
override changed Atlas's parallel-dispatch behavior.

Note on provider: if the sandbox can't resolve `onara/*`, edit the isolated
`$XDG_CONFIG_HOME/opencode/oh-my-openagent.json` (inside the sandbox root
printed by run-scenario.sh) to a resolvable model, or adjust run-scenario.sh
to rewrite the model routing before the `opencode run`.

## Cleanup

Each run prints its sandbox root (`omo-qa-sandbox.*` and `pwsafety-repo.*`
under the OS temp dir). Remove with `rm -rf` when done. The scripts never write
outside temp dirs and never touch the real `~/.config/opencode`,
`~/.codex`, or `~/.local/share/opencode/opencode.db`.
