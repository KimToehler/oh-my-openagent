# Dirty lane completion live QA plan

1. Build evidence-local Git worktree with one dirty baseline file before child launch.
2. Start fake OpenAI Responses server and real `opencode serve` inside `qa-sandbox.sh` isolation, from `$OMO_QA_PROJ`.
3. Fake parent calls `task`; fake child blocks HTTP response until evidence-local release latch exists. This creates verified inflight window.
4. During inflight window, dirty distinct file and release fake child. Assert parent DB and raw SSE contain exact singular completion annotation, baseline path never counted as two.
5. Run no-new-dirty negative control in fresh evidence-local Git worktree. Assert completion notification has no `uncommitted file` annotation.
6. Record sandbox/host DB counts, process cleanup receipt, raw captures, and verdict.
