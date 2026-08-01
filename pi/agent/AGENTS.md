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
- Always `git status` before commiting.
- Only commit your changes.
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
