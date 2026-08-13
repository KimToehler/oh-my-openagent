# QA — `record_lesson` live harness at CURRENT HEAD

Run date: 2026-08-14 01:45–01:55 local (2026-08-13T23:45:38Z UTC start).
Worktree `/Users/tim/git/oh-my-openagent/.worktrees/record-lesson-pr1`,
branch `feat/record-lesson-tool` @ `84943a39198ad22cbca9e9bb1a0adcdef2c8ab06`.
Runtime: opencode 1.18.15, bun 1.3.14, macOS arm64.
Local build under test: `dist/index.js`,
sha256 `9fb4521346da53a6e0358187698314b86932236c80d5b36822223c279d545c56`.

**VERDICT: PASS.** All 9 plan steps pass, plus the three current-design checks
(duplicate no-op, repo-root glob rejection with rewrite, out-of-range citation
rejection). No gate was left unsatisfied.

**This directory SUPERSEDES the lock-era evidence.** `20260810-record-lesson-tool/`,
`20260813-record-lesson-lock/`, and `20260813-record-lesson-residual-risk/`
were all captured against builds that still contained `withLessonStoreLock` and the
old date-prefixed filename scheme `<YYYYMMDD>-<slug>-<6hex>.md`, which the current
build cannot generate (see `../SUPERSEDED-lock-era-evidence.md`). The `20260814-record-lesson-postlock/`
directory targets the post-lock architecture but predates the atomic-publish fix
`c2e833fab` that this run exercises. Everything below was produced by the build at
the HEAD sha above.

## WHAT WAS TESTED

The plan's 9-step mandatory live-harness QA
(`.omo/plans/2026-08-10-record-lesson-loop.md`, section "QA — PR-1"), driving the
real `opencode run` CLI against the LOCAL plugin build in an isolated sandbox, plus
three checks that exist only because of the post-lock redesign.

| Step | What it proves | Surface driven |
|---|---|---|
| 1–3 | Isolation established, real-home baseline captured before any `HOME` override | `script/agent/qa-sandbox.sh` (throwaway `XDG_*` + `CODEX_HOME`), `ls` + `shasum` of `$REAL_HOME/.omo/rules`, real + sandbox DB session counts |
| 4 | Gate enabled in the sandboxed user config; the LOCAL build is the plugin actually loaded | `$QA_HOME/.omo/omo.jsonc`, `$XDG_CONFIG_HOME/opencode/opencode.json` with `plugin: ["file://<worktree>/dist/index.js"]` |
| 4b | **CONFIG-READ GATE.** `record_lesson` is really registered in a live session | `opencode run "List the names of every tool you have available..."` |
| 5–6 | **LIVE TOOL PROOF.** `record_lesson` really executes and returns success | `opencode run "Call the record_lesson tool exactly once..."` |
| 7 | **THE CURRENT FILENAME SCHEME.** Exactly one `.md`, `<slug>-<16hexhash>.md`, no date prefix, no lock or temp residue | filesystem inspection of `$QA_HOME/.omo/rules/lessons` and the project dir |
| 8 | **READ-PATH PROOF.** The rules injector picks that exact artifact up in a later live session | `opencode run "Use the read tool on ... quote every line starting with [Rule:"` |
| 9 | The real `~/.omo/rules` and the real opencode DB were never written | listing diff, per-file content hashes, DB session counts |
| NEW A | Recording the SAME lesson twice returns a duplicate no-op and still leaves exactly one file, byte-identical | two live `record_lesson` sessions with byte-identical arguments |
| NEW B | A repo-root-anchored glob is rejected WITH a corrected-glob suggestion | live `record_lesson` call with `packages/omo-opencode/src/**/*.ts` |
| NEW C | An out-of-range citation line is rejected | live `record_lesson` call with `package.json:999999` |
| gates | Unit + type gates green | `bun test` (record-lesson + lessons schema), `bun run typecheck` |

Isolation mechanics: `script/agent/qa-sandbox.sh` exports throwaway `XDG_DATA_HOME` /
`XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` / `CODEX_HOME` under one
`mktemp -d` root. That helper does NOT relocate `$HOME`, and omo resolves both the
user config (`packages/omo-config-core/src/loader/paths.ts`) and the default lessons
directory (`packages/omo-opencode/src/tools/record-lesson/paths.ts`) from `env.HOME`.
Every `opencode` invocation therefore additionally ran as `HOME="$QA_HOME" opencode run ...`,
which redirects the config read AND the lesson write into the sandbox at once.

Two known plan bugs were worked around rather than rediscovered, and both are visible
in the artifacts:

1. The plugin config layer key is the BLOCK form `"[opencode]"`, not the bare
   `"opencode"` the plan shows. The bare key fails the strict layer schema, the whole
   layer is silently dropped, and the gate reads 0. See `sandbox-omo-jsonc.txt`.
2. `opencode run --format json` emits ONE JSON OBJECT PER LINE, so `jq` must slurp
   (`-s`) to count across the stream, and the tool name lives at `.part.tool`.
   `tool-use-count.txt` records both the plan's expression and a correct one.

Model: `onara/unspecified-low`. `onara/sisyphus` mangles array arguments into JSON
strings at the provider level (proven with a 3-way control in an earlier run; not a
`record_lesson` defect), which would prevent the call from succeeding at all.

## WHAT WAS OBSERVED

### Step 4b — CONFIG-READ GATE: **PASS**

`config-read-proof.txt` contains the literal value:

```
1
```

The live session's own tool list (`tool-availability.json`) contains `record_lesson`,
listed between `read_mcp_resource` and `report_blocked`. The gate is `>= 1`, so the
downstream steps are not vacuous. The sandbox config the session actually loaded is in
`sandbox-omo-jsonc.txt`:

```
{ "[opencode]": {
    "lessons": {
      "enabled": true
    }
  },
  "_migrations": [
    "2026-08-reasoning-unification"
  ]
}
```

(the `_migrations` key was appended by omo's own runtime migration on first load; the
original file written by the harness is preserved by omo as `omo.jsonc.bak.2026-08-13T23-45-49-315Z`
and read `{ "[opencode]": { "lessons": { "enabled": true } } }`).

### Steps 5–6 — LIVE TOOL PROOF: **PASS**

From `tool-use-count.txt`, literal values:

```
== plan's step-6 jq expression (known-broken: the tool name lives at .part.tool) ==
1
== correct jq: .part.tool == record_lesson  (tool_use count) ==
1
== distinct callID count ==
1
== parts with state.status == completed ==
1
== grep -c record_lesson ==
1
```

(the plan expression returns 1 here only because slurping the stream lets `..` reach
`.part.tool`; run per-line as the plan writes it, it returns 0.)

Arguments the model actually passed, verbatim from the stream:

```json
{"title":"new tool families must be config gated","what_went_wrong":"A new tool family was registered unconditionally in the tool registry, so every session paid for it even when the feature was unwanted.","rule_for_next_time":"Register every new tool family behind an explicit config flag that defaults to off, and assert both the on and the off case in the registry test.","globs":["src/plugin/**/*.ts"],"citations":["packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143"],"description":"new tool families must be config gated"}
```

Tool result, verbatim:

```
Recorded lesson new-tool-families-must-be-config-gated-3ae9436b1413a7d1
Path: /private/var/folders/.../qahome/.omo/rules/lessons/new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
Applies to future sessions, not the current one.
```

Note the glob is PACKAGE-relative (`src/plugin/**/*.ts`). The plan's repo-root form is
rejected by design now, which NEW CHECK B proves separately.

### Step 7 — CURRENT FILENAME SCHEME AND NO RESIDUE: **PASS**

`lesson-dir-listing.txt`, literal:

```
== ls -la $QA_HOME/.omo/rules/lessons ==
total 8
drwxr-xr-x  3 tim  staff   96 14 Aug. 01:47 .
drwxr-xr-x  3 tim  staff   96 14 Aug. 01:47 ..
-rw-r--r--  1 tim  staff  751 14 Aug. 01:47 new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md

== ls -a (dotfile / lock / tmp residue check) ==
.
..
new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md

== .md count ==
1
== TOTAL entries (excluding . and ..) ==
1
== residue probe: lock / tmp / reclaim ==
0
== filename scheme assertion ==
basename: new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
SCHEME MATCH: <slug>-<16hexhash>.md  PASS
NO DATE PREFIX  PASS
hash segment: 3ae9436b1413a7d1.md
== project dir must NOT have a lessons dir ==
no project lessons dir  PASS
```

Four things are pinned here against the change list:

- **The lockfile is gone.** The residue probe for `*.lock`, `*.tmp`, `.reclaim-*`, and
  `.record-lesson.lock*` returns `0`, and `ls -a` shows no dotfiles at all. The total
  entry count equals the `.md` count.
- **No date prefix.** The basename does not match `^[0-9]{8}-`. The recording date
  lives in the body's `Recorded: 2026-08-13` line instead.
- **The hash in the filename IS the semantic content hash.** The filename suffix
  `3ae9436b1413a7d1` is byte-identical to the body's `Lesson hash: 3ae9436b1413a7d1`,
  which is what makes dedup structural rather than a directory scan.
- **The temp file used for atomic publication left nothing behind.** Publication writes
  `.<lessonId>.<hex>.tmp` and hard-links it onto the target, then unlinks the temp; the
  probe confirms the unlink ran.

The artifact itself (`lesson-artifact.md`), verbatim:

```
---
description: new tool families must be config gated
globs:
  - "src/plugin/**/*.ts"
---

# Lesson: new tool families must be config gated

Learned in: oh-my-openagent @ 84943a391
Learned against model: onara/unspecified-low
Recorded: 2026-08-13
Lesson id: new-tool-families-must-be-config-gated-3ae9436b1413a7d1
Lesson hash: 3ae9436b1413a7d1

## What went wrong
A new tool family was registered unconditionally in the tool registry, so every session paid for it even when the feature was unwanted.

## Rule for next time
Register every new tool family behind an explicit config flag that defaults to off, and assert both the on and the off case in the registry test.

## Evidence
- packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143
```

`repoName` rendered as the constrained value `oh-my-openagent` and the commit sha as
`84943a391`, matching the HEAD under test. Frontmatter carries `description` and
`globs` only.

### NEW CHECK A — duplicate no-op on a second live recording: **PASS**

`new-a-duplicate-noop.txt`. The second live session passed byte-identical arguments
(diff the two `input` objects in `live-record-lesson.json` and `new-a-duplicate-call.json`)
and the tool returned, verbatim:

```
Existing lesson /private/var/folders/.../qahome/.omo/rules/lessons/new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md; duplicate no-op.
```

Directory state after the second call:

```
-- lessons dir after second call --
.
..
new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
-- .md count after second call --
1
-- total entries after second call --
1
```

And the existing file was not rewritten:

```
-- file hash BEFORE second call --
78f821e24a48a3155181874fe309b269b01409718ca2055d98d147cd5fc410f3  .../new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
-- file hash AFTER second call --
78f821e24a48a3155181874fe309b269b01409718ca2055d98d147cd5fc410f3  .../new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
```

This is dedup by construction: the second caller derived the same semantic hash, so it
targeted the same path, lost the exclusive create, read a matching `Lesson hash:` line,
and returned the no-op without writing.

### NEW CHECK B — repo-root-anchored glob rejected with a rewrite: **PASS**

`new-bc-rejections.txt`. Input glob `packages/omo-opencode/src/**/*.ts`, and the tool
returned, verbatim:

```
Error: glob is anchored above its nearest project marker: packages/omo-opencode/src/**/*.ts. Use src/**/*.ts instead.
```

The suggestion is the actual corrected glob, not generic advice: `packages/omo-opencode`
carries its own project marker, so the rules matcher would evaluate the pattern relative
to that package, and the anchored form could never match.

### NEW CHECK C — out-of-range citation line rejected: **PASS**

Same file. Input citation `package.json:999999` against a 242-line `package.json`, and
the tool returned, verbatim:

```
Error: unverifiable citation: package.json:999999 (invalid or missing line)
```

Neither rejection wrote anything. Directory state spanning both B and C:

```
== lessons dir count before B/C ==
1
== lessons dir after B and C ==
.
..
new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md
== .md count after ==
1
== total entries after (residue check) ==
1
```

Both rejections fired before the write path, so there is no partial artifact and no
temp residue.

### Step 8 — READ-PATH PROOF: **PASS**

`injected-rule-banners.txt`, literal, from a session that only ever read a source file:

```
== STEP 8: injected rule banners (sorted unique) ==
[Rule: .omo/rules/lessons/new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md]
```

That is the exact file from step 7 with the exact new-scheme id. The full injected block
the model saw (`injected-rule-block.txt`, from the `read` tool output part, lines
1006–1025 of that output):

```
[Rule: .omo/rules/lessons/new-tool-families-must-be-config-gated-3ae9436b1413a7d1.md]
[Match: glob: src/plugin/**/*.ts]

# Lesson: new tool families must be config gated

Learned in: oh-my-openagent @ 84943a391
Learned against model: onara/unspecified-low
Recorded: 2026-08-13
Lesson id: new-tool-families-must-be-config-gated-3ae9436b1413a7d1
Lesson hash: 3ae9436b1413a7d1

## What went wrong
A new tool family was registered unconditionally in the tool registry, so every session paid for it even when the feature was unwanted.

## Rule for next time
Register every new tool family behind an explicit config flag that defaults to off, and assert both the on and the off case in the registry test.

## Evidence
- packages/omo-opencode/src/plugin/tool-registry-core-tools.ts:143
```

The `[Match: glob: src/plugin/**/*.ts]` line proves the package-relative glob matched
`packages/omo-opencode/src/plugin/tool-registry-core-tools.ts` through the nearest
project marker, which is the behavior NEW CHECK B enforces on the write side. No copy
was made or possible: the write target and the injector's scan directory are the same
path under `HOME=$QA_HOME`.

### Step 9 — ISOLATION: **PASS**

`isolation.txt`, literal:

```
-- real user rules listing AFTER --
total 16
drwxr-xr-x   4 tim  staff   128 23 Juli 16:47 .
drwx------@ 18 tim  staff   576 13 Aug. 17:54 ..
-rw-r--r--   1 tim  staff  1796 23 Juli 16:47 worktree-parallel-safety.md
-rw-r--r--   1 tim  staff  1798 23 Juli 11:50 worktrees.md

-- diff of listing BEFORE vs AFTER --
LISTING IDENTICAL  PASS

-- content hashes BEFORE vs AFTER --
BYTE-IDENTICAL  PASS
-- hashed file count --
2

-- real $HOME/.omo/rules/lessons must NOT exist --
absent  PASS

-- real opencode DB session count BEFORE --
1962
-- real opencode DB session count AFTER --
1962

-- sandbox DB session count BEFORE --
no db yet
-- sandbox DB session count AFTER --
6
```

Six live sessions were created, all six landed in the sandbox DB, and the real DB
count is unchanged at 1962. The real `~/.omo/rules` is byte-identical by per-file
sha256 (2 files, both hashes unchanged) and never grew a `lessons/` subdirectory.
The worktree's own `.omo/rules/lessons` was also never created.

### Gates

`bun-test.txt`: `bun test packages/omo-opencode/src/tools/record-lesson/ packages/omo-opencode/src/config/schema/lessons.test.ts`

```
 138 pass
 0 fail
 270 expect() calls
Ran 138 tests across 9 files. [359.00ms]
BUNTEST_EXIT=0
```

`typecheck.txt`: `bun run typecheck` (tsgo across the root, `script/`, and all 27
workspace packages) ends with `TYPECHECK_EXIT=0`.

## WHY IT IS ENOUGH

The gate that makes the rest meaningful is step 4b: `config-read-proof.txt` = `1`
proves the sandboxed `[opencode]` layer was really read and the tool really registered
in a live session, so no later assertion is vacuously true. The plugin under test is
pinned to the local build by absolute path in the sandbox `opencode.json`
(`sandbox-opencode-config.json`), and that file's sha256 is recorded in
`run-context.txt`, so the run cannot be silently exercising the user's installed omo.

Every claim about the current design is backed by an artifact the live tool produced,
not by reading source:

- Lock removal and atomic publication are proven negatively and positively at once: the
  residue probe returns `0` entries beyond the single `.md`, meaning neither a lockfile
  nor the publication temp file survives, and the artifact is complete and parseable.
- The filename scheme is proven by regex assertion on the actual basename plus the
  equality between the filename suffix and the body's `Lesson hash:` line, which is
  exactly the property that makes dedup structural.
- Dedup is proven end to end by a second real session, not by a unit test: same
  arguments, `duplicate no-op` return, one file, unchanged sha256.
- The two rejection paths are proven with the literal error strings the model received,
  including the corrected glob, and with a directory count unchanged across both.
- The read path is proven from a session that never called `record_lesson`, so the
  injector genuinely rediscovered the artifact from disk.
- Isolation is proven on three independent axes: directory listing, per-file content
  hashes, and DB session attribution (6 sandbox sessions, real count flat at 1962).

Residual risk this run does NOT cover, stated plainly rather than implied:

- **Concurrency is out of scope here.** This is the single-writer live-CLI QA the plan
  mandates. The multi-process fork behavior under high contention was the subject of
  `20260814-record-lesson-postlock/`, which drove real parallel OS processes; the
  atomic-publish commit `c2e833fab` targets exactly that, but re-proving it needs that
  harness, not `opencode run`.
- **The `lessons.enabled` / `lessons.storage` user-layer-only precedence rule** is
  exercised only in its positive direction here (the user-layer `[opencode]` block did
  enable the tool). A project-layer override being ignored is covered by unit tests in
  the 138-test suite, not by a live session in this run.
- **The cap paths** (200 files, 3000 body chars) are unit-covered, not driven live.

## WHAT WAS OMITTED

- Provider credentials: the sandbox `auth.json` was copied from the real home so live
  sessions could authenticate, and it is NOT reproduced in this directory. No token,
  key, or `Authorization` header appears in any captured artifact.
- `sandbox-opencode-config.json` keeps the config the sessions loaded but replaces the
  `provider` block with `provider_keys_only` (the list `["anthropic","onara","openai"]`),
  because the full model catalog is long and irrelevant to every assertion here.
- Sandbox paths are machine-local `mktemp` paths. They appear in tool output verbatim
  where the literal value is part of the proof, and are elided to `...` in prose where
  the prefix adds nothing.
- The captured `*.json` files are the raw `opencode run --format json` event streams,
  trimmed of nothing.
- No environment dump is included. The sandbox environment is fully described by
  `script/agent/qa-sandbox.sh` plus the `HOME="$QA_HOME"` override documented above.
- The four `*.stderr.txt` files are retained and are all zero bytes; no session emitted
  an error to stderr.

## FILES

| File | Contents |
|---|---|
| `run-context.txt` | HEAD sha, opencode/bun versions, `dist/index.js` sha256, UTC start |
| `tool-availability.json` | Live tool-list session (step 4b) |
| `config-read-proof.txt` | `1` — the config-read gate |
| `sandbox-omo-jsonc.txt` | The sandboxed `[opencode]` layer omo actually read |
| `sandbox-opencode-config.json` | Sandbox opencode config, provider catalog elided, showing the local `dist/index.js` plugin path |
| `live-record-lesson.json` | Successful live `record_lesson` session (step 5) |
| `tool-use-count.txt` | Plan vs correct jq counts, plus live args and result |
| `lesson-dir-listing.txt` | **Step 7 gate**: filename scheme, residue probe, project-dir negative assertion |
| `lesson-artifact.md` | The live-produced lesson artifact |
| `new-a-duplicate-call.json` | Second live session with byte-identical arguments |
| `new-a-file-hash-before.txt` | sha256 of the artifact captured before the duplicate call (the AFTER hash is inside `new-a-duplicate-noop.txt`) |
| `new-a-duplicate-noop.txt` | **NEW CHECK A**: duplicate no-op return, count, unchanged hash |
| `new-b-repo-root-glob.json` | Live session with a repo-root-anchored glob |
| `new-c-bad-citation-line.json` | Live session with `package.json:999999` |
| `new-bc-rejections.txt` | **NEW CHECKS B and C**: literal error strings, unchanged directory |
| `live-injection.json` | Live read-path session (step 8) |
| `injected-rule-banners.txt` | The `[Rule: ...]` banner naming the step-7 file |
| `injected-rule-block.txt` | The full lesson block as injected into model context |
| `real-user-rules-{before,after}.txt` | Real `~/.omo/rules` listing around the run |
| `real-user-rules-hashes-{before,after}.txt` | Per-file sha256 of the same |
| `real-db-session-count-{before,after}.txt` | `1962` / `1962` |
| `sandbox-db-session-count-{before,after}.txt` | `no db yet` / `6` |
| `isolation.txt` | **Step 9 gate**: all isolation assertions in one place |
| `bun-test.txt` | 138 pass, 0 fail |
| `typecheck.txt` | `TYPECHECK_EXIT=0` |

## REPRODUCE

```bash
cd /Users/tim/git/oh-my-openagent/.worktrees/record-lesson-pr1
bun run build && git checkout -- packages/omo-codex/ packages/omo-senpi/
source script/agent/qa-sandbox.sh
export REAL_HOME="$HOME"
export QA_HOME="$OMO_QA_ROOT/qahome"; mkdir -p "$QA_HOME/.omo"

# NOTE the BRACKETED harness key; a bare "opencode" key silently disables the gate.
cat > "$QA_HOME/.omo/omo.jsonc" <<'JSON'
{ "[opencode]": { "lessons": { "enabled": true } } }
JSON

mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME/opencode"
cp "$REAL_HOME/.local/share/opencode/auth.json" "$XDG_DATA_HOME/opencode/auth.json"
jq -n --slurpfile r "$REAL_HOME/.config/opencode/opencode.json" --arg pl "file://$PWD/dist/index.js" \
  '{"$schema":"https://opencode.ai/config.json", provider:$r[0].provider, plugin:[$pl]}' \
  > "$XDG_CONFIG_HOME/opencode/opencode.json"

# gate — must print >= 1
HOME="$QA_HOME" opencode run "List the names of every tool you have available. Output the bare names only, one per line. Do not call any tool." \
  --model onara/unspecified-low --format json | grep -c record_lesson

# step 5 — PACKAGE-RELATIVE glob; the plan's repo-root glob is rejected by design
HOME="$QA_HOME" opencode run "Call the record_lesson tool exactly once. ... globs: [\"src/plugin/**/*.ts\"] ..." \
  --model onara/unspecified-low --format json > live-record-lesson.json

# step 7 gate — one .md, new scheme, no residue
ls -a "$QA_HOME/.omo/rules/lessons"
[ -e "$PWD/.omo/rules/lessons" ] && echo FAIL || echo PASS

# NEW A — rerun the step-5 command verbatim; expect "duplicate no-op." and still one file
# NEW B — same shape with globs: ["packages/omo-opencode/src/**/*.ts"]
# NEW C — same shape with citations: ["package.json:999999"]

# step 8 — read-path
HOME="$QA_HOME" opencode run "Use the read tool on packages/omo-opencode/src/plugin/tool-registry-core-tools.ts and then quote verbatim every line in that tool output that starts with [Rule: or [Match:." \
  --model onara/unspecified-low --format json > live-injection.json
grep -o '\[Rule: [^]]*\]' live-injection.json | sort -u
```

`opencode run` can exceed a two-minute foreground cap, so each invocation above was run
detached to a log file and polled.

Teardown performed: sandbox root removed (`rm -rf "$OMO_QA_ROOT"`, which contains
`$QA_HOME`, all XDG dirs, `CODEX_HOME`, the sandbox DB, and all run logs); the
`/tmp/rl-qa` scratch directory removed; no opencode server was started; no tmux session
was created; `OMO_LESSONS_DIR` was never set.
