# Evidence: merge `origin/dev` (v5.0.0-beta.7+107) into local `dev`

Date: 2026-08-15
Local base before merge: `612c130a0` (tag `v4.19.4-202-g612c130a0`)
Remote merged: `038ed0cbb` (`v5.0.0-beta.7-107-g038ed0cbb`)
Merge base / fork point: `b072d2791` = tag `v4.19.4`
Rollback tag: `pre-merge-backup-20260815`

## WHAT WAS TESTED

Integration of 961 remote-only commits into a local branch carrying 202 local-only
commits (157 non-merge). Verified before merging that no local commit already
existed upstream (`git cherry origin/dev HEAD` reported 157 `+`, zero `-`), so no
duplicate-work or double-apply risk.

Commands run at repo root after the merge:

- `bun install` (lockfile reconciliation)
- `bun run build:schema`
- `bun run typecheck`
- `bun test`
- `bun run test:codex`
- `node --test packages/omo-codex/scripts/install-bin-links.test.mjs`

Baseline comparison run in an isolated worktree at `/tmp/baseline-dev`, checked out
at pristine `origin/dev` (`038ed0cbb`, detached), to classify every failure as
pre-existing-upstream vs merge-induced.

## WHAT WAS OBSERVED

### Conflict surface

3 conflicted files out of 2074 changed; 14 files were touched by both sides and 11
of those auto-merged clean.

| File | Nature | Resolution |
|---|---|---|
| `AGENTS.md` | 3 hunks, stale hook/tool counters on BOTH sides | Rewritten to measured ground truth |
| `docs/reference/features.md` | 2 hunks, same counter drift | Rewritten to match `AGENTS.md` |
| `bun.lock` | 10 hunks, dependency-version drift | Took upstream, regenerated via `bun install` |

### Counter resolution was measured, not picked

Neither side's numbers were correct, so the doc counters were derived from the
merged source rather than by choosing a side:

| Tier | Slots | Null on default config |
|---|---|---|
| Session | 26 | 5 (`preemptive-compaction`, `model-fallback`, `interactive-bash-session`, `goal`, `lesson-nudge`) |
| ToolGuard | 18 | 0 (`team-tool-gating` is always composed; it gates itself internally) |
| Transform | 7 | 3 (2 team + monitor) |
| Continuation | 7 | 0 |
| Skill | 2 | 0 |
| Total | 60 | 8 null, so 52 active |

Maximum 64 = 60 composed slots + 4 direct Team Mode event handlers in
`packages/omo-opencode/src/plugin/event.ts`. Hook directories on disk: 64.
Registry tools: 13 to 40.

### Gate results

- `bun run typecheck`: exit 0 across all 30 package projects.
- `bun test`: 15501 pass, 11 skip, 6 fail, 15518 tests across 2013 files.
- `bun run test:codex`: 19 fail in the `node --test` stage.

### Failure classification

One failure was genuinely merge-induced and was fixed:

- `script/agent-command-string-audit.test.ts` failed because the allowlist pins
  documentation line numbers. Resolving the `AGENTS.md` conflict moved the
  `omo doctor` mention from line 411 to 412. Updated both pins (`AGENTS.md` and
  its `CLAUDE.md` symlink) in `script/agent-command-string-audit.allowlist.json`.
  Re-ran the file: 1 pass, 0 fail.

All remaining failures reproduce identically on pristine `origin/dev` and are
therefore pre-existing upstream, not caused by this merge:

- 5 `bun test` failures (1 ast-grep pinned-binary fixture, 4 `ulw-plan` skill-loader
  dedup/resolution tests). Confirmed by running the same files in
  `/tmp/baseline-dev`: 183 pass, 5 fail, same test names.
- 3 `install-bin-links.test.mjs` runtime-wrapper failures. Confirmed in
  `/tmp/baseline-dev`: 21 tests, 18 pass, 3 fail, same test names.
- 16 `tomllib is required for TOML parse assertions` failures. Not merge-related,
  but on closer inspection not purely environmental either: the helper probed
  only `python3` and `python`, and on macOS `python3` is the 3.9 system build.
  This machine also has `python3.12` and `python3.14`, both with `tomllib`.
  Fixed separately in `e5c927d70` by probing versioned interpreters newest-first;
  `bun run test:codex` then drops from 19 failures to 3, with zero tomllib
  failures. The 3 survivors are the pre-existing runtime-wrapper failures above.

### Generated-artifact handling

Four generated bundles were locally modified before the merge and were discarded
(backed up to `/tmp/dirty-bundles-backup-20260815.patch` and reachable via the
`pre-merge-backup-20260815` tag). Upstream had rewritten the same bundles heavily
(114 commits on `omo.js` alone), so keeping stale local copies would have produced
pointless conflicts. After `bun install` regenerated several bundles, those
regenerated artifacts were reverted so the merge commit records upstream's
committed artifacts rather than machine-local build output.

`bun run build:schema` regenerated `assets/omo.schema.json` and
`assets/oh-my-opencode.schema.json`; the output matched what the merge already
staged, confirming no post-merge schema drift.

## WHY IT IS ENOUGH

The merge is a history integration, not a behavior change: the only hand-authored
edits are three documentation counter blocks and two line-number pins in a lint
allowlist. Correctness of those counters was verified against the merged source
rather than asserted. Every gate the repository defines was executed, and each
residual failure was reproduced on unmodified upstream in an isolated worktree,
which isolates the merge as the variable and rules it out as the cause.

Residual risk is confined to areas neither side's tests cover, and is low because
the two change sets were nearly disjoint: local work sat almost entirely in
`packages/omo-opencode/` while upstream work concentrated in `omo-senpi`,
`senpi-task`, and the new `memory-core` package.

## WHAT WAS OMITTED

- No live harness QA (`opencode-qa` / `codex-qa`) was run. This change introduces
  no new plugin behavior of its own; it integrates upstream commits that carry
  their own evidence, and the only authored edits are documentation and a lint
  allowlist. Live-harness QA remains required for the next change that actually
  alters plugin behavior.
- The 3 runtime-wrapper failures in `install-bin-links.test.mjs` were not fixed.
  They are pre-existing on upstream and out of scope for a merge.
- Full raw logs were kept out of this directory. They live at
  `/tmp/merge-buntest.log`, `/tmp/merge-codex.log`, `/tmp/baseline-6.log`, and
  `/tmp/baseline-codex.log`. No credentials, tokens, or environment dumps are
  reproduced here.

## FOLLOW-UP: rebuild after the merge (commit `c5f109176`)

The merge commit was created from a build that predated it: `bun install`'s
postinstall built at 16:22, the merge landed at 16:37. Rebuilding afterwards
revealed that the five generated bundles reverted during conflict resolution were
not machine noise but genuine drift.

Diagnosis. The Codex installer bundle header carries a
`omo-codex-install:<sourceDigest>:<bodyDigest>` marker. After rebuild the source
digest was unchanged and only the body digest moved, and the embedded module path
went from `posthog-node@5.35.12` to `posthog-node@5.49.1`. The drift was therefore
entirely a dependency bump, not a source change.

Root cause. Upstream `origin/dev` had `posthog-node: ^5.34.3` in the root manifest
with `5.35.12` in the lockfile. Our pre-merge branch had `^5.48.1` with `5.48.1`.
The merge kept our manifest constraint and upstream's lockfile pin, which cannot
be satisfied together, so the `bun install` run during conflict resolution
resolved it to `5.49.1`. That bump was already committed inside the merge
commit's `bun.lock` without being recorded anywhere.

Resolution. `c5f109176` makes it explicit: both declaring manifests are aligned to
`^5.49.1` (root, and `packages/telemetry-core`, the actual consumer, which still
carried upstream's `^5.34.3`), and the stale bundles are rebuilt. Caret matches
the convention for this dependency; exact pins in this repo are reserved for
host-coupled packages such as the opencode SDK, senpi, and bun-types.

Verification for that commit:

- Build determinism: two consecutive `bun run build` runs produced byte-identical
  hashes for every regenerated bundle.
- No machine-local contamination: zero `/Users/tim` occurrences in the artifacts.
  The `/opt/homebrew` matches are hardcoded bun/node runtime search paths present
  in upstream's committed bundle at the same count, not build contamination.
- `bun run typecheck` exit 0.
- `bun test`: 15502 pass, 11 skip, 5 fail. The `agent-command-string-audit`
  failure is gone, and the 5 survivors are the ones already proven pre-existing.
- `bun run test:codex`: 3 fail, all the known runtime-wrapper tests, zero tomllib.
- `script/codex-install-bundle-freshness.test.ts`: 2 pass. This gate reads the
  bundle from the git index, so it was run against the staged artifact.
