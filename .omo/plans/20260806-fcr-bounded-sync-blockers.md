# FCR bounded sync adoption blockers

1. Add red regression cases in `manager.adopt.test.ts`, `sync-task.yield.test.ts`, and `sync-session-poller.wall-clock.test.ts` for continuation ownership balance, sync ownership balance, duplicate adoption, and abort-over-yield.
2. Add required `rootDescendantAlreadyReserved` input. Mark sync spawn adoption true and continuation adoption false. In manager, reject duplicate active session adoption before side effects and register root descendants only for unreserved continuation ownership.
3. Move poller abort handling before automatic wall-clock yielding.
4. Remove evidence trailing whitespace. Run manual four-case script, required checks, write evidence, stage scoped paths, and commit once.
