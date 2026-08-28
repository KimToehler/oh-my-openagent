# qa-sandbox.sh: isolate HOME so QA cannot destroy the operator's ~/.omo

Fixes a defect that had already caused real damage: a QA run following the
documented isolation helper plus the documented mock-model recipe overwrote the
operator's live `~/.omo/omo.jsonc`. Logged as
`docs/troubleshooting/harness-findings.md` (2026-08-28), commit `6b8215f5f`.

## What was wrong

`script/agent/qa-sandbox.sh` isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `CODEX_HOME` — but never `HOME`. The
plugin's own config chain is `$HOME/.omo/omo.json[c]`, which is not an XDG path,
so it kept resolving to the real home. The script's header meanwhile claimed it
"mirrors the opencode-qa (`oqa_mk_isolated_xdg`) ... skill conventions", and
that helper (`.agents/skills/opencode-qa/scripts/lib/common.sh:69-80`) *does*
rewrite `HOME`. The advertised parity did not exist.

## What was tested

1. **Failing-first behavioral test.** Added to `script/agent-env.test.ts`: source
   the helper in a real bash subshell, read back `HOME` and `OMO_QA_ROOT`, and
   assert `HOME` moved and lives under `OMO_QA_ROOT`. It executes the script
   rather than grepping it, because the guarantee is the resulting environment,
   not the presence of a string.
2. **End-to-end destruction replay.** Created a fake home containing a real-looking
   `~/.omo/omo.jsonc` plus `~/.opencode/bin/opencode`, sourced the fixed helper,
   then performed the exact write that caused the incident.
3. **Doc-sync gates.** The three test files the AGENTS.md maintenance contract
   names.

## What was observed

Before the fix (test red, correct reason):
```
error: HOME must not remain the real home
(fail) ... #then HOME is redirected away from the real home
 4 pass  1 fail
```

After the fix:
```
$ bun test script/agent-env.test.ts
 5 pass  0 fail
```

Destruction replay, after the fix:
```
sandbox HOME=/var/folders/.../omo-qa-sandbox.XXXXXX.yMgTLBF28U/home
bin relink present: yes
QA_ROOT=/var/folders/.../omo-qa-sandbox.XXXXXX.yMgTLBF28U
--- real file after the run ---
{"REAL":"do-not-clobber"}          # survived; the mock write landed in the sandbox
```

Doc-sync gates:
```
$ bun test script/agent-env.test.ts script/agent-harness-wiring.test.ts \
           script/agents-md-dev-env.test.ts
 22 pass  0 fail
```

## Why it is enough

The replay reproduces the original incident's exact write against a controlled
home and shows the real file untouched, which is the property that failed. The
`.opencode/bin` relink is asserted in the same run, covering the one known
side effect of moving `HOME` (installed opencode wrappers resolve the real
binary through that path — the reason `oqa_preserve_home_opencode_bin` exists).
The unit test locks the environment guarantee so a future edit that drops the
`HOME` export fails CI rather than silently restoring the hazard.

Residual risk: this hardens the *shared* helper. A QA script that builds its own
sandbox without using it is unaffected, and a caller that re-exports `HOME`
after sourcing can still defeat it. Neither is reachable from the documented
path.

## Review round 2: a CRITICAL residual hole, found and closed

An independent review rejected the first version of this fix, and was right to.
Moving `HOME` closed the original clobber path but left a second, subtler one,
while the docs shipped an absolute "never reads or writes `~/.omo`" claim that
was still false.

**The hole:** project config layers are collected by walking `cwd` upward and
stopping at `$HOME` (`packages/omo-config-core/src/loader/paths.ts:75-101`), and
project layers OUTRANK the user layer. With `HOME` moved into the sandbox but
`cwd` still under the operator's real home — this repo's own layout — the walk
sails past the sandbox boundary and claims the real `~/.omo` as a *project*
layer. That beats the sandbox's user layer, and the migration engine
(`config/migration/discovery-paths.ts`, same boundary) can write to it.

Consequence: the documented mock-model recipe silently does not take effect. QA
runs against the operator's real agent/model pins — real providers, real spend —
while the evidence claims "mock provider, no network egress."

**Reproduced independently** against the real loader; same sandbox, only `cwd`
differs (full output in `project-layer-leak-proof.txt`):

```
LEAK   cwd=under-real-home  project_layers=["/tmp/realhome.../.omo/omo.jsonc"]
CLEAN  cwd=OMO_QA_PROJ      project_layers=[]
```

**Fix:** complete the `oqa_mk_isolated_xdg` mirror. That helper creates
`$root/proj` and exports `OQA_PROJ` (`common.sh:80,89`) precisely so QA runs from
a directory outside the real home; round 1 omitted it. Now exports `OMO_QA_PROJ`
(plus `OPENCODE_TEST_HOME`, also mirrored), and every doc states that
`cd "$OMO_QA_PROJ"` is mandatory, not cosmetic. Isolation is complete only when
BOTH `HOME` and `cwd` sit inside the sandbox.

Also fixed from the same review:
- **Re-source chaining.** Sourcing twice in one shell linked sandbox2 against
  sandbox1's home and orphaned the first root. Guarded via
  `OMO_QA_SANDBOX_ACTIVE`; verified the guard fires and `HOME` is not mutated.
- **Contradictory banner.** The closing `printf` still said only
  `~/.config/opencode and ~/.codex are untouched` while the header claimed all
  three. Operators read the banner, so it now prints `HOME`, `OMO_QA_PROJ`, the
  mandatory `cd`, and the git-identity caveat.
- **Undocumented losses.** Git identity and `~/.ssh` do not follow into the
  sandbox, so commits from a sandboxed shell get the wrong author. Documented.

A second test pins `OMO_QA_PROJ`'s existence and location, so the project-dir
half cannot silently regress the way it was silently missing. Gates after the
round-2 changes: **23 pass / 0 fail**.

Sharper residual risk: a QA script that sources this helper and then stays in a
repo directory under the real home is still exposed. The banner and docs are the
mitigation; there is no enforcement.

## What was omitted

No live opencode/codex session was driven here: this change is to the isolation
helper itself, not to plugin runtime behavior, and driving a session would have
tested the harness rather than the fix. The temp homes used above were created
and removed within the run; no credentials, tokens, or env dumps were captured,
so nothing required redaction.
