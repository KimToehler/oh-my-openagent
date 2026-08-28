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

## What was omitted

No live opencode/codex session was driven here: this change is to the isolation
helper itself, not to plugin runtime behavior, and driving a session would have
tested the harness rather than the fix. The temp homes used above were created
and removed within the run; no credentials, tokens, or env dumps were captured,
so nothing required redaction.
