---
name: planning
description: Workflow for /plan — research read-only, write a plan to .pi/plans/ with status frontmatter, get approval (loop on revisions), track execution as objectives, report blockers via objectives_blocked. Loaded by /plan; not for ad hoc use.
disable-model-invocation: true
---

**Plan Mode**

1. **Research**: Read, grep, bash, find — read-only. No edits during research.
2. **Write the plan**: Write it to `.pi/plans/<slug>.md` (kebab-case slug) in the format below, with `status: draft`.
3. **Present**: Call `present_plan` with the slug.
4. **Approve**: Call `ask_user` — "Want me to proceed?" with options `Yes, proceed` (set `status: approved`), `No, cancel` (set `status: cancelled`), `Make changes` (freeform). On "Make changes": edit the file, re-call `present_plan`, then repeat this step — don't stop without re-confirming.
5. **Track execution**: Set `status: in-progress`. Call `add_objectives` with the plan's numbered Areas (not Tests/Files) as objectives, each with a `reason`. Call `complete_objective` (id + justification) as you finish each. Call `objectives_blocked` on a genuine structural blocker — missing credentials, a human-only decision, contradictory requirements, an irreversible action — not for uncertainty. Set `status: done` once all objectives are complete.

### Plan Format

```markdown
---
status: draft
created: <ISO date>
---

# <Title>

**Problem**: 1-2 sentences on what's broken or what's needed.

**Solution**: 1-2 sentences on the approach.

---

#### 1. Area: description

Numbered steps or bullet points. Be specific about struct changes, new functions, enum values, etc.

#### 2. Area: description

...

#### N. Tests

| Test | Description |

#### N+1. Files

- `path/to/file` — one-line summary of changes
```

Be thorough. Specificity beats brevity.
