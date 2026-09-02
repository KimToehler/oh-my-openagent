# src/hooks/rules-injector/ — Conditional Rules Injection

**Generated:** 2026-05-15

## OVERVIEW

~40 files (~3.2k LOC incl. tests). The `rulesInjectorHook` — Tool Guard Tier hook that auto-injects AGENTS.md (and similar rule files) into context when a file in a directory is read, written, or edited. Proximity-based: closest rule file to the target path wins. Scanner/parser/matcher/distance primitives are re-exported from `@oh-my-opencode/rules-engine`.

## HOW IT WORKS

```
tool.execute.after (read/write/edit/multiedit)
  → Extract file path from tool output
  → Find rule files near that path (finder.ts)
  → Already injected this session? (cache.ts)
  → Inject rule content into tool output (injector.ts)
```

## TRACKED TOOLS

`["read", "write", "edit", "multiedit"]`, matched via `matchesTrackedTool` (`../../shared/tool-name-match.ts`): exact name, or a case-insensitive suffix preceded by one of `_ - . : /`. This lets MCP-prefixed forms match, such as `lean-ctx_ctx_read`, `mcp__server__read`, and `hashline_edit`. It also excludes lookalike suffixes without a separator: `todowrite` ends with `write` but has no separator before it, so it deliberately stays untracked.

One known over-match: `session_read` (a non-file tool) matches because of the `_` separator. It has no `metadata.filePath`, so `getRuleInjectionFilePath` falls back to `output.title`, which can cause one spurious, deduped rule injection per session. Accepted as harmless.

## KEY FILES

| File | Purpose |
|------|---------|
| `hook.ts` | `createRulesInjectorHook()` — wires cache + injector, handles tool events |
| `injector.ts` | `createRuleInjectionProcessor()` — orchestrates find → cache → inject |
| `finder.ts` | `findRuleFiles()` + `calculateDistance()` — locate AGENTS.md near target path |
| `rule-file-finder.ts` | Walk directory tree to find AGENTS.md / .rules files |
| `rule-file-scanner.ts` | Scan for rule files in a directory |
| `matcher.ts` | Match file paths against rule file scope |
| `rule-distance.ts` | Calculate path distance between file and rule file |
| `project-root-finder.ts` | Find project root (stops at .git, package.json) |
| `output-path.ts` | Extract file paths from tool output text |
| `cache.ts` | `createSessionCacheStore()` — per-session injection dedup |
| `storage.ts` | Persist injected paths across tool calls |
| `parser.ts` | Parse rule file content |
| `constants.ts` | Rule file names: `AGENTS.md`, `.rules`, `CLAUDE.md` |
| `types.ts` | `RuleFile`, `InjectionResult`, `RuleFileScope` |

## RULE FILE DISCOVERY

Priority (closest → farthest from target file):
1. Same directory as target file
2. Parent directories up to project root
3. Project root itself

Same-distance tie: all injected. Per-session dedup prevents re-injection.

## TRUNCATION

Uses `DynamicTruncator` — adapts injection size based on model context window (1M context models get full content, smaller models get truncated summaries).
