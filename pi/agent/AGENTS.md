## Temp files
- `/home/kinetic/scratch` — persistent scratch space
- `/tmp` — ephemeral (lost on reboot)

## Subagents
Call the `subagent` tool directly. `{agent, task}` for one run, `tasks: [...]` for parallel, `chain: [...]` for sequential handoff. Prefer `async: true`; don't block on `subagent_wait` unless this turn must return results before ending. Builtins: `scout`/`researcher` (recon), `planner`, `worker` (writes — keep to one writer), `reviewer` (review/fix, fresh context), `oracle` (advisory, forked context, decision/drift review), `context-builder`, `delegate`. Stay in control: the parent synthesizes and applies the result.

Use when:
- exploring an unfamiliar codebase (`scout`)
- researching a library/API (`researcher`)
- getting a second opinion on a risky decision (`oracle`)
- having to investigate multiple distinct topics at the same time
- offloading a long implementation while you keep working (`worker`, `async: true`).
- performing a long task that can be pipelined in large discrete steps.

Subagents are cheap - don't hesitate using as many as you want.

## Timers
Call `timer`/`heartbeat` directly instead of `sleep` for anything longer than a few seconds. `timer(seconds, message)` for one-shot waits (builds, deploys); `heartbeat(action, interval_seconds, message)` for periodic polling.

Use when:
- waiting on a CI run or deploy to finish 
- polling an API/build status
- any wait where you'd otherwise `sleep` and block the chat.
