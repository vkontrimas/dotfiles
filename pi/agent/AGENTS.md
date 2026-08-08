## Temp files
- `/home/kinetic/scratch` — persistent scratch space
- `/tmp` — ephemeral (lost on reboot)

## Timers
Call `timer`/`heartbeat` directly instead of `sleep` for anything longer than a few seconds. `timer(seconds, message)` for one-shot waits (builds, deploys); `heartbeat(action, interval_seconds, message)` for periodic polling.

Use when:
- waiting on a CI run or deploy to finish
- polling an API/build status
- any wait where you'd otherwise `sleep` and block the chat.

## Asking questions
When you have multiple open decisions for the user, call `ask_user` once per decision — never fold several into one prose message with a numbered list and a single "let me know" at the end. If you have a recommendation, state it in that decision's `ask_user` call and mark it `(Recommended)`, don't just narrate all your recommendations in chat and wait for one blanket reply.

## Git
- Never push unless asked.

### Never destroy work you didn't do
Any change you didn't make is the user's. Never discard it — stash it, commit yours, restore it.

Forbidden on files you didn't touch: `git checkout -- <file>`, `git restore <file>`, `git reset --hard`, `git clean -fd`, `git stash` without `pop`.

```bash
# You changed src/main.rs; user has edits in config.toml
git stash push -- config.toml
git add src/main.rs && git commit -m "fix: ..."
git stash pop
```

```bash
# Your change conflicts with the user's edit in the same file:
# stop and ask. Don't overwrite, don't revert.
```

```bash
# Rebase/merge hits a conflict in a file you never touched:
git rebase --abort   # not `git checkout --ours`
```

### Commit discipline
Split work into commits the way you'd split it for a subagent: each piece self-contained enough to hand off and verify on its own. Every commit must build and pass on its own — the user bisects, and one broken intermediate commit ruins that.

- Check `git status` before staging. If it's clean except for your own edits, `git add -A`/`git add .` is fine; if the user has other changes sitting there, stage by explicit path instead — a sweep would pick those up alongside yours.
- Large or multi-part work: one commit per logical, buildable step.
- Small or tightly-coupled work (a rename plus its call sites, a one-line fix plus its test): one commit — don't fragment it for its own sake.
- A step that only compiles once a later step lands isn't a valid commit boundary yet. Fold them together, or reorder the work so each commit stands alone.

```bash
# Mid-task; the user has unrelated unstaged edits in two other files.
git add src/auth.rs src/auth_test.rs   # only what you touched
git commit -m "fix: reject expired tokens"
```

```bash
# Feature spans a migration, a schema update, and a handler.
# Three commits, each green on its own:
git add migrations/003_add_col.sql && git commit -m "feat: add priority column"
git add src/schema.rs && git commit -m "feat: map priority in schema"
git add src/handler.rs src/handler_test.rs && git commit -m "feat: expose priority in handler"
```

```bash
# Handler won't compile until schema lands — that's not a valid split.
# Wrong: commit schema, then commit handler separately, leaving the schema-only commit broken.
# Right: combine schema + handler in one commit, or only split them if the
# schema-only commit still builds on its own.
```

```bash
# Renamed a function and updated both call sites — one cohesive change.
git add src/lib.rs src/caller_a.rs src/caller_b.rs
git commit -m "refactor: rename validate() to validate_input()"
```
