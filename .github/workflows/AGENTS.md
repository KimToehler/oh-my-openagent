# .github/workflows/ - CI/CD Pipeline Reference

**Generated:** 2026-08-17

## OVERVIEW

11 GitHub Actions workflows covering tests, publish, marketplace sync, and repo hygiene. This file is the single source of truth for the workflow reference; root [`AGENTS.md`](../../AGENTS.md) only points here.

## WORKFLOWS

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR to master/dev | Tests, typecheck, build, codex-compatibility (`bun run test:codex`, ubuntu/macos/windows), auto-commit schema on master push, draft "next" release on dev push (blocks master-targeting PRs) |
| `publish.yml` | manual dispatch | Test, typecheck, preflight-trust (OIDC verify workspace packages), dual npm publish (`oh-my-opencode` + `oh-my-openagent`) + `lazycodex-ai` npm alias (`publish_lazycodex`, default on) + automatic Codex marketplace sync to `code-yeongyu/lazycodex` on every **stable** release (no toggle; gated on empty `dist_tag`, needs `LAZYCODEX_SYNC_TOKEN`), 12 platform launcher packages, GitHub release, merge to master |
| `publish-platform.yml` | called by publish.yml | 12 generated Node launcher packages for darwin/linux/windows |
| `sisyphus-agent.yml` | @mention or manual dispatch | AI agent handles issues/PRs |
| `refresh-model-capabilities.yml` | weekly cron / dispatch | Refresh model capabilities from models.dev API |
| `cla.yml` | issue_comment / PR | CLA assistant for contributors |
| `lint-workflows.yml` | push/PR touching `.github/workflows/**` | actionlint only (`shellcheck=""` disables shellcheck) |
| `web-ci.yml` | push/PR to master/dev touching `packages/web/**`, `docs/**`, or the workflow file itself | format-check, lint, type-check, next build, opennextjs-cloudflare build |
| `web-deploy.yml` | push to master/dev touching `packages/web/**`, `docs/**`, or the workflow file itself, OR manual dispatch | Cloudflare Workers deploy via `cloudflare/wrangler-action@v3` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets) |
| `package-labels.yml` | issues opened/edited + pull_request_target | Auto-applies package labels (`opencode` / `lazycodex` / `lazycodex-generated`) |
| `stats.yml` | weekly cron (Sun) / dispatch | Runs [`script/stats.ts`](../../script/stats.ts) (npm + GitHub-release download counts) |

Cross-checked against the 11 files actually present in this directory; no undocumented workflow found and no documented workflow is missing from disk.

## MASTER/DEV BRANCH RULES

- PRs targeting `master` are hard-blocked and MUST target `dev` instead.
- Root tests run through plain `bun test` in one process; there is no sharding or split isolation runner.
- `packages/web/**` has its own package-level CI workflow (`web-ci.yml` above), separate from the root `ci.yml` suite.
- Windows builds run on `windows-latest` rather than being cross-compiled, to avoid Bun segfaults.

## PUBLISH DETAIL (`publish.yml`)

- `publish_lazycodex` (default **true**) publishes the npm alias `lazycodex-ai`: rewrites root `package.json` name to `lazycodex-ai` + version to the release + optionalDeps `oh-my-opencode-*` to `oh-my-openagent-*`, skips when `registry.npmjs.org/lazycodex-ai/${VERSION}` exists, publishes `--access public --provenance --tag latest`, then restores `package.json`. (The bare `lazycodex` npm name was unpublished 2026-05-30; `lazycodex-ai` is the live package.)
- Codex marketplace sync is automatic for every stable release (no manual toggle; the old `sync_lazycodex_marketplace` input was removed). The release-job steps are gated on `needs.release-metadata.outputs.dist_tag == ''` (stable only; prereleases skip) and require secret `LAZYCODEX_SYNC_TOKEN` (enforced up-front by the `preflight-trust` token check, also gated on stable). They check out `code-yeongyu/lazycodex`, build the plugin + lsp-tools-mcp + lsp-daemon + git-bash-mcp, run [`script/sync-lazycodex-marketplace.ts`](../../script/sync-lazycodex-marketplace.ts) `<source-root> <lazycodex-root>`, then `git push origin HEAD:main`.

Parent: root [`AGENTS.md`](../../AGENTS.md).
