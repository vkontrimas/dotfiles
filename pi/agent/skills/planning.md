---
name: planning
description: Workflow for /plan — research read-only, write a plan to .pi/plans/ with status frontmatter, get approval (loop on revisions), track execution as tasks, report blockers via tasks_blocked. Loaded by /plan; not for ad hoc use.
disable-model-invocation: true
---

**Plan Mode**

1. **Research**: Read, grep, bash, find — read-only. No edits during research.
2. **Write the plan**: Write it to `.pi/plans/<slug>.md` (kebab-case slug) in the format below, with `status: draft`. Use the ISO date from "Current date" at the top of context for `created`. Struct/function/field level, not full code. Final draft only — strip any "actually"/"wait"/dead ends before presenting.
3. **Present**: Call `present_plan` with the slug.
4. **Approve**: Call `ask_user` — "Want me to proceed?" with options `Yes, proceed` (set `status: approved`), `No, cancel` (set `status: cancelled`), `Make changes` (freeform). On "Make changes": edit the file, re-call `present_plan`, then repeat this step — don't stop without re-confirming.
5. **Track execution**: Set `status: in-progress`. Call `add_tasks` with the plan's numbered Tasks (not Files) — `reason` is why the task is needed, `evidence` is its Verify row. One task at a time: make the changes, run its Verify row, then `complete_task` (id + evidence) before starting the next. Call `tasks_blocked` on a genuine structural blocker (missing credentials, a human-only decision, contradictory requirements, an irreversible action) — not for uncertainty. Set `status: done` once all tasks are complete.

### Plan Format

```markdown
---
status: draft
created: <ISO date, from "Current date" at the top of context>
---

# <Title>

**Problem**: 1-2 sentences on what's broken or what's needed.

**Solution**: 1-2 sentences on the approach.

---

#### 1. Task: description

Bullet points at struct/function/field level — what changes and why, not the code itself.

| Test | Description |
|------|-------------|
| `path/to/test` | what it pins down |

| Verify | Expected |
|--------|----------|
| command that proves this task alone works | what it should show |

#### 2. Task: description

...

#### N. Files

- `path/to/file` — one-line summary of changes
```

Specificity means naming the exact struct/function/field touched, not
pasting the implementation.

Every task carries its own Test and Verify tables — no trailing "Tests"
section. A task that can't be verified alone is the wrong shape: split it, or
fold it into one that can. A whole-suite run still belongs once, in the last
task's Verify table.
