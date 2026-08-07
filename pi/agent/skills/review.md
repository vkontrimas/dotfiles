---
name: review
description: Workflow for reviewing code — scope, read, analyze, report findings ranked by severity. Use when asked to review a PR, branch, diff, file, or the whole codebase. Loaded by /skill:review; not for ad hoc use.
disable-model-invocation: true
---

**Review Mode**

Read-only diagnostic. Do not edit code unless asked after the report.

1. **Scope**: Diff (`git diff`), branch, path, or directory. Unclear? Ask once with `ask_user`. 10+ files or ~10k+ LOC? Delegate to `seqagent` agent `review`. Otherwise do it yourself.

2. **Read**: Top-down — public interface first, then internals. For diffs, read both sides. Note entry points, call graph, dependencies.

3. **Check**: Run linter, type checker, tests, build — whatever is available. Failures are findings. Nothing obvious? Skip and note it.

4. **Analyze**: Every finding gets `file:line`, severity, one-line rationale.

   - **Correctness** — logic errors, wrong operator, unreachable code, unhandled branches
   - **Security** — injection, credential leaks, unsafe deserialization, missing authz
   - **Robustness** — missing error handling, silent failures, resource leaks, races
   - **Performance** — N+1 queries, blocking I/O on hot paths, unbounded growth
   - **Maintainability** — dead code, God objects, deep nesting, duplicated logic
   - **Consistency** — style violations, mixed patterns, config drift

5. **Rank**:
   - **Critical** — data loss, security breach, production crash. Must fix.
   - **Major** — incorrect behavior under common conditions. Fix before merge.
   - **Minor** — style, clarity, edge case.
   - **Suggestion** — alternative approach, optimization.

6. **Report**: Write to `.pi/reviews/<slug>.md`. If the user wants fixes, use `add_tasks` for Critical and Major items.

### Report Format

```markdown
---
date: <ISO date>
scope: <branch, paths, or commit range>
---

# Review: <Title>

**Summary**: 1-2 sentences. Green/yellow/red.

## Critical

| # | Location | Issue |
|---|----------|-------|
| 1 | `path/file:42` | One-line description |

## Major

| # | Location | Issue |
|---|----------|-------|
| 1 | `path/file:17` | One-line description |

## Minor

...

## Suggestions

...

## Notes

- Gaps in coverage, items needing context
```

Every finding cites `file:line`. One issue per row. No fixes in the report — diagnosis only. Omit sections with zero findings.
