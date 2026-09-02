#!/usr/bin/env bash
# make-sandbox.sh - create an ISOLATED throwaway git repo used as the target
# workspace for the parallel-worktree-safety QA proof. This repo is NOT any
# real repo: it is a fresh mktemp dir with its own `git init`.
#
# It seeds four TS files + a locales JSON, commits on `main`, branches to
# `task`, and writes a grammar-valid Prometheus plan `.omo/plans/race-test.md`
# with ONE wave of 4 implementation todos. Each todo carries the NEW `Files:`
# field being tested (the field the start-work override is supposed to consume
# for lane-disjointness). Todos 1 & 2 OVERLAP via locales/messages.de.json;
# todos 3 & 4 are disjoint.
#
# Prints the sandbox repo path on the last line as: SANDBOX_REPO=<path>

set -euo pipefail

SANDBOX_ROOT="$(mktemp -d -t pwsafety-repo.XXXXXX)"
REPO="$SANDBOX_ROOT/repo"
mkdir -p "$REPO"
cd "$REPO"

git init -q -b main
git config user.email "qa@example.com"
git config user.name "QA Harness"
git config commit.gpgsign false

mkdir -p src locales .omo/plans
printf 'export const x = 1\n' > src/a.ts
printf 'export const x = 1\n' > src/b.ts
printf 'export const x = 1\n' > src/c.ts
printf 'export const x = 1\n' > src/d.ts
printf '{"k1":"v1"}\n' > locales/messages.de.json

cat > .omo/plans/race-test.md <<'PLAN_EOF'
# Race Test Plan

Prometheus plan exercising the start-work parallel-dispatch override. One wave
of four implementation todos. Each todo declares a `Files:` scope. Todos 1 and
2 share `locales/messages.de.json` and therefore must NOT run in the same
parallel spawn burst under the override; todos 3 and 4 are disjoint.

## Goal

Apply four small, independent edits, each committed separately, without any
lane touching a file outside its declared `Files:` scope.

## Wave 1

- [ ] 1. Add key k2 to the German locale for feature a
  Files: src/a.ts, locales/messages.de.json
  Instruction: In locales/messages.de.json append a new key "k2" with value "a" so the object becomes {"k1":"v1","k2":"a"}. Do not touch any other file's contents except src/a.ts if strictly required.
  Acceptance: `jq -e '.k2 == "a"' locales/messages.de.json` exits 0.
  Commit: Y

- [ ] 2. Add key k3 to the German locale for feature b
  Files: src/b.ts, locales/messages.de.json
  Instruction: In locales/messages.de.json append a new key "k3" with value "b". Do not touch any other file's contents except src/b.ts if strictly required.
  Acceptance: `jq -e '.k3 == "b"' locales/messages.de.json` exits 0.
  Commit: Y

- [ ] 3. Bump the constant in feature c
  Files: src/c.ts
  Instruction: In src/c.ts change the line to `export const x = 3`.
  Acceptance: `grep -q 'export const x = 3' src/c.ts`.
  Commit: Y

- [ ] 4. Bump the constant in feature d
  Files: src/d.ts
  Instruction: In src/d.ts change the line to `export const x = 4`.
  Acceptance: `grep -q 'export const x = 4' src/d.ts`.
  Commit: Y
PLAN_EOF

git add -A
git commit -q -m "seed: initial workspace + race-test plan"
git branch task
git checkout -q task

echo "[make-sandbox] seeded isolated repo, branch 'task' checked out" >&2
echo "SANDBOX_REPO=$REPO"
