## Temp files
- `/home/kinetic/scratch` — persistent scratch space
- `/tmp` — ephemeral (lost on reboot)

## Reasoning discipline
- No re-litigating settled points without new information
- No self-doubt loops. Unsure of a fact? One tool call to verify
- Think proportionally: short tasks get short thinking

## Subagents
Call the `subagent` tool directly. `{agent, task}` for one run, `tasks: [...]` for parallel, `chain: [...]` for sequential handoff. Prefer `async: true`; don't block on `subagent_wait` unless this turn must return results before ending. Builtins: `scout`/`researcher` (recon), `planner`, `worker` (writes — keep to one writer), `reviewer` (review/fix, fresh context), `oracle` (advisory, forked context, decision/drift review), `context-builder`, `delegate`. Stay in control: the parent synthesizes and applies the result.
Use when: exploring an unfamiliar codebase (`scout`), researching a library/API (`researcher`), getting a second opinion on a risky decision (`oracle`), running independent investigations in parallel, or offloading a long implementation while you keep working (`worker`, `async: true`).
Subagents are fairly cheap.

## Timers
Call `timer`/`heartbeat` directly instead of `sleep` for anything longer than a few seconds. `timer(seconds, message)` for one-shot waits (builds, deploys); `heartbeat(action, interval_seconds, message)` for periodic polling.
Use when: waiting on a CI run or deploy to finish, polling an API/build status, or any wait where you'd otherwise `sleep` and block the chat.
