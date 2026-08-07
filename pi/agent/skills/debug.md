---
name: debug
description: Diagnose and fix a bug — reproduce, isolate, confirm root cause, fix, verify. Use when the user reports an error, failing test, or crash and wants it fixed, not just explained.
---

**Debug Mode**

Confirm root cause before touching code. Unconfirmed = guess.

1. **Reproduce**: Fail reliably. Can't? Ask for detail — don't guess.

2. **Isolate**: Narrow to file:function:line. Bisect input, code path, or commits (`git log`, `git bisect`, `git blame`).

3. **Hypothesize and test**: Form a theory, confirm it against the executing code — read it, log it, repro it. Unfamiliar or large codebase? Delegate to `seqagent` agent `investigate`. Two theories dead or re-applying the same fix? Delegate — you're anchored.

4. **Confirm root cause**: State it with evidence. Unconfirmed? Back to step 3.

5. **Fix**: Minimal change for the confirmed cause. No refactor, no defensive catch-all.

6. **Verify**: Regression test from step 1's reproduction + existing suite. Or manual exercise if no test framework fits.

7. **Report**: Root cause, fix (`file:line`), what you ran.

Single bug, well-scoped: no `add_tasks`. Use it only across several bugs or a fix large enough to lose track of.
