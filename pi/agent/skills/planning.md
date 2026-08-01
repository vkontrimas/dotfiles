---
name: planning
description: Workflow for /plan — research read-only, ask clarifying questions on open decisions, write a plan to .pi/plans/ with status frontmatter, get approval (loop on revisions), track execution as tasks, report blockers via tasks_blocked. Loaded by /plan; not for ad hoc use.
disable-model-invocation: true
---

**Plan Mode**

1. **Research**: Read, grep, bash, find — read-only. No edits during research.
2. **Ask clarifying questions**: Before writing or presenting the plan, call `ask_user` once per open decision research surfaced — architecture choice (e.g. `Redis (Recommended)` vs `in-memory map` for session state), implementation strategy (e.g. `debounce in the UI (Recommended)` vs `de-dupe at the API`), or scope (e.g. `just the reported call site (Recommended)` vs `all four affected ones`, `allowMultiple: true` if independent). Mark your pick `(Recommended)`, set `allowFreeform: true`. Skip if there's only one reasonable way to do the whole thing; don't re-ask once answered.
3. **Write the plan**: Write it to `.pi/plans/<slug>.md` (kebab-case slug) in the format below, with `status: draft`. Use the ISO date from "Current date" at the top of context for `created`. Struct/function/field level, not full code. Final draft only — strip any "actually"/"wait"/dead ends before presenting.
4. **Present**: Call `present_plan` with the slug.
5. **Approve**: Call `ask_user` — "Want me to proceed?" with options `Yes, proceed` (set `status: approved`), `No, cancel` (set `status: cancelled`), `allowFreeform: true` for change requests. On freeform feedback: edit the file, re-call `present_plan`, then repeat this step — don't stop without re-confirming.
6. **Track execution**: Set `status: in-progress`. Call `add_tasks` with the plan's numbered Tasks (not Files) — `reason` is why the task is needed, `evidence` is its Verify row. One task at a time: make the changes, run its Verify row, then `complete_task` (id + evidence) before starting the next. Call `tasks_blocked` on a genuine structural blocker (missing credentials, a human-only decision, contradictory requirements, an irreversible action) — not for uncertainty. Set `status: done` once all tasks are complete.

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
