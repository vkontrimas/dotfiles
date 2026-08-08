---
name: planning
description: Workflow for /plan — research read-only, ask clarifying questions on open decisions, write a plan to .pi/plans/ with status frontmatter, get approval (loop on revisions), track execution as tasks, report blockers via tasks_blocked. Loaded by /plan; not for ad hoc use.
disable-model-invocation: true
---

**Plan Mode**

1. **Research**: Read, grep, bash, find — read-only. No edits during research.
2. **Ask clarifying questions**: Before writing or presenting the plan, call `ask_user` once per open decision research surfaced — architecture choice (e.g. `Redis (Recommended)` vs `in-memory map` for session state), implementation strategy (e.g. `debounce in the UI (Recommended)` vs `de-dupe at the API`), scope (e.g. `just the reported call site (Recommended)` vs `all four affected ones`, `allowMultiple: true` if independent), or a likely misconception (e.g. they name a file that doesn't exist but `auth.ts` looks like what they meant, or a term that seems typoed/misremembered). Mark your pick `(Recommended)`, add `Let's discuss`, set `allowFreeform: true`. "Let's discuss" means talk it out in messages, not an answer — resolve it, then re-ask. Skip if there's only one reasonable way; don't re-ask once answered.

   Same discipline as the global `ask_user` rule, applied per open decision: if research surfaced N of them, that's N separate `ask_user` calls, each waited on before the next is asked.
3. **Write the plan**: Write it to `.pi/plans/<slug>.md` (kebab-case slug) in the format below, with `status: draft`. Run `date -I` for the `created` date. Struct/function/field level, not full code. Final draft only — strip any "actually"/"wait"/dead ends before presenting.
4. **Present**: Call `present_plan` with the slug.
5. **Approve**: Call `ask_user` — "Want me to proceed?" with options `Yes, proceed` (set `status: approved`), `No, cancel` (set `status: cancelled`), `Let's discuss`, `allowFreeform: true`. "Let's discuss" means talk it out, then re-ask. Freeform feedback: edit the file, re-call `present_plan`, repeat this step — don't stop without re-confirming. `present_plan` also flags if the file changed since it was last presented (e.g. the user edited it directly in the opened editor) and returns the current on-disk content — treat that as feedback too: read it, fold it into the plan, don't overwrite it with a stale version.
6. **Track execution**: Set `status: in-progress`. Call `add_tasks` with the plan's numbered Tasks (not Files) — `reason` is why the task is needed, `evidence` is its Verify row. One task at a time: make the changes, run its Verify row, then `complete_task` (id + evidence) before starting the next. Call `tasks_blocked` on a genuine structural blocker (missing credentials, a human-only decision, contradictory requirements, an irreversible action) — not for uncertainty. Call `cancel_task` (id + reason) when a task turns out unnecessary — e.g. an earlier task's changes already covered it, or `ask_user` feedback during **Approve** cut a task's feature from scope — never to give up on work you just haven't gotten to yet; that's still open, not cancelled. `cancel_task` vs `tasks_blocked`: cancel what no longer needs doing, block on what still needs doing but can't proceed right now. Set `status: done` once all tasks are complete or cancelled.

### Plan Format

```markdown
---
status: draft
created: <ISO date, from `date -I`>
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
