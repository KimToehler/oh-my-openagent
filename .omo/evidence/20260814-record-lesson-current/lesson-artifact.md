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
