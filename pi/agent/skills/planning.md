---
name: planning
description: Workflow for /plan — research read-only, write a plan to .pi/plans/ with status frontmatter, get approval (loop on revisions), track execution as tasks, report blockers via tasks_blocked. Loaded by /plan; not for ad hoc use.
disable-model-invocation: true
---

**Plan Mode**

1. **Research**: Read, grep, bash, find — read-only. No edits during research.
2. **Write the plan**: Write it to `.pi/plans/<slug>.md` (kebab-case slug) in the format below, with `status: draft`.
3. **Present**: Call `present_plan` with the slug.
4. **Approve**: Call `ask_user` — "Want me to proceed?" with options `Yes, proceed` (set `status: approved`), `No, cancel` (set `status: cancelled`), `Make changes` (freeform). On "Make changes": edit the file, re-call `present_plan`, then repeat this step — don't stop without re-confirming.
5. **Track execution**: Set `status: in-progress`. Call `add_tasks` with the plan's numbered Areas (not Files) as tasks — `reason` is why that Area is needed, `evidence` is its **Verify** line. Work one Area at a time: make the changes, write and run that Area's tests as its last step, then call `complete_task` (id + evidence) with the output you just saw — before starting the next Area. Call `tasks_blocked` on a genuine structural blocker — missing credentials, a human-only decision, contradictory requirements, an irreversible action — not for uncertainty. Set `status: done` once all tasks are complete.

### Plan Format

```markdown
---
status: draft
created: <current ISO date>
---

# <Title>

**Problem**: 1-2 sentences on what's broken or what's needed.

**Solution**: 1-2 sentences on the approach.

---

#### 1. Area: description

Numbered steps or bullet points. Be specific about struct changes, new functions, enum values, etc.

| Test | Description |
|------|-------------|
| `path/to/test` | what it pins down |

**Verify**: the command that proves this Area alone works, and what its output should be.

#### 2. Area: description

...

#### N. Files

- `path/to/file` — one-line summary of changes
```

Be thorough. Specificity beats brevity.

Every Area carries its own tests and its own **Verify** command — there is no
trailing "Tests" section. An Area whose only verification is the full suite at
the end cannot be checked off when it's finished, so its evidence ends up
reconstructed from memory hours later. If an Area has no way to prove itself in
isolation, it's the wrong shape: split it, or fold it into the Area that can.

A whole-suite run is still worth doing once at the end, but it belongs in the
last Area, not as every Area's proof.
