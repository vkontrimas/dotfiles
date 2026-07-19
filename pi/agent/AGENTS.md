## Temp files
- `/home/kinetic/scratch` — persistent scratch space
- `/tmp` — ephemeral (lost on reboot)

## Timers
Call `timer`/`heartbeat` directly instead of `sleep` for anything longer than a few seconds. `timer(seconds, message)` for one-shot waits (builds, deploys); `heartbeat(action, interval_seconds, message)` for periodic polling.

Use when:
- waiting on a CI run or deploy to finish
- polling an API/build status
- any wait where you'd otherwise `sleep` and block the chat.
