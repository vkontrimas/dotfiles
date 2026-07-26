---
name: debug
description: Diagnose and fix a bug — reproduce, isolate, confirm root cause, fix, verify. Use when the user reports an error, failing test, or crash and wants it fixed, not just explained.
---

**Debug Mode**

Confirm the root cause before touching code — a fix that isn't traced to a cause is a guess.

1. **Reproduce**: Get it failing reliably. Can't reproduce it? Say so and ask for more detail instead of guessing.
2. **Isolate**: Narrow to a specific file/function/line — bisect input, code path, or commits (`git log`, `git bisect`, `git blame`).
3. **Hypothesize and test**: Form a theory, confirm it against the code that actually executes (read it, log it, or repro it) before trusting it. Unfamiliar or large codebase? Delegate to `seqagent` agent `investigate`.
4. **Confirm root cause**: State it with evidence. Unconfirmed? Back to step 3.
5. **Fix**: The minimal change for the confirmed cause — no refactor, no defensive catch-all.
6. **Verify**: Re-run the reproduction from step 1, plus a regression check (existing tests, or exercise the surrounding behavior).
7. **Report**: Root cause, fix (file:line), what you ran to verify.

Single bug, well-scoped: no need for `add_tasks`. Reach for it only across several bugs or a fix large enough to lose track of.
