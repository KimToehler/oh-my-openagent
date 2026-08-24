# Rules-injector delivery gaps QA

## WHAT WAS TESTED

- Ran isolated Gap 2 hook seam through real current plugin source. Command captured in [`gap2-real-hook-seam.txt`](./gap2-real-hook-seam.txt): sourced `script/agent/qa-sandbox.sh`, created sandbox project with matching `.omo/rules/mcp-prefixed-read.md`, then called `createRulesInjectorHook(...)["tool.execute.after"]` with MCP-prefixed `mcp__qa__read` and read metadata.
- Expected observable: hook appends rule banner and persists sandbox `rules-injector` state containing matching rule `realPath`.
- Existing RED and parse artifacts cover helper, directory injectors, hook seam, and rule example parsing: [`gap2-helper-red.txt`](./gap2-helper-red.txt), [`gap2-directory-injectors-red.txt`](./gap2-directory-injectors-red.txt), [`gap2-hook-seam-red.txt`](./gap2-hook-seam-red.txt), and [`gap3-rule-parse-proof.txt`](./gap3-rule-parse-proof.txt).
- Gap 1 design and failing-regression evidence: [`gap1-design-decision.md`](./gap1-design-decision.md) and [`gap1-red.txt`](./gap1-red.txt). This includes bounded current-compaction-epoch hydration and stale persisted-cache restart-path coverage.

## WHAT WAS OBSERVED

- [`gap2-real-hook-seam.txt`](./gap2-real-hook-seam.txt) records `sandbox_rules_before=0`, `rule_banner=true`, `sandbox_state_exists=true`, and persisted project rule path `<sandbox>/project/.omo/rules/mcp-prefixed-read.md`. This is binary before/after proof that an MCP-prefixed read reaches rules-injector persistence.
- Same capture records host session count unchanged at `2546` before and after, and host rules-injector file count unchanged at `0` before and after. QA used only XDG and CODEX paths made by `script/agent/qa-sandbox.sh`; no host config, Codex home, OpenCode DB, or rules-injector storage was used for writes.
- Capture records `sandbox_removed=true` and `tmux_qa_sessions_remaining=0`. No QA background PID or bound port was created; sandbox directory removed after capture.
- Existing artifacts retain pre-fix RED proof and design rationale without reproducing large test logs here.

## WHY IT IS ENOUGH

- Gap 2 highest-value failure mode is exercised through production hook creation, rule discovery, injection, and storage using an MCP-prefixed tool name. Persisted state is stronger than checking modified output alone because it proves injection completed past duplicate tracking.
- Unit RED artifacts pin exact regressions for suffix matching, both directory injectors, rules-injector hook gate, and rule-template parsing. Gap 1 design decision plus RED artifact covers compaction-epoch boundary and restart-path contract.
- Isolation capture proves real host session and rules-injector file counts did not change. Cleanup receipt proves sandbox and QA tmux resources were removed.

## WHAT WAS OMITTED

- No live model-backed OpenCode MCP session was driven. Sandbox proof invokes real plugin hook seam directly because a configured provider is required for a live session. Residual risk: OpenCode tool-event routing could differ from direct hook dispatch, though existing hook-seam RED coverage and production hook invocation reduce it.
- No actual session compaction was forced. Compaction depends on model context lifecycle and was not fabricated. Residual risk: runtime event payload and compaction timing remain unproven on a live model session; [`gap1-red.txt`](./gap1-red.txt) and restart-path coverage remain evidence for this behavior.
- Secrets, provider environment, auth headers, and full sandbox paths are omitted. Captured sandbox project path is redacted as `<sandbox>`.
