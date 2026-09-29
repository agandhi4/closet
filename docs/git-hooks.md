# Git hooks

`.githooks/` holds two hooks; `npm install` installs them (the `prepare` script sets `core.hooksPath`, skipped where there is no `.git`, such as the Docker build). In a git worktree the relative path resolves to that worktree's own `.githooks/`.

| Hook | Runs | When |
| --- | --- | --- |
| `pre-commit` | `npm run check`: `check:static` (docs, format, lint, types) and `test:all` in parallel | every commit; the integration tier needs pgvault-dev (or `TEST_DATABASE_URL`) |
| `pre-push` | `npm run verify:push`: build, then Chromium Playwright | only a push to `main` (branches are verified by CI on their PR) |

## Quiet output (#260)

Both hooks call `scripts/git-hook.ts` instead of the npm script directly. Agents commit several times per issue and several run at once, and every line a hook prints lands in the committing agent's context: `npm run check` prints a line per Vitest file plus concurrently's prefixes, hundreds of lines for a commit that passes.

The runner reads the hook's steps from package.json (`check`'s `concurrently` parts, so `static` and `tests`; `verify:push` as one step), runs them in parallel with each step's output in its own log under the temp directory, and prints:

- a first line naming the steps;
- on success, one line per step, with Vitest's or Playwright's counts and the time, e.g. `✓ tests 4337 passed, 1 skipped in 181s`; the logs are deleted;
- on failure, the failed step, its exit, the last 40 lines of its log (the failing test's name and assertion, or the lint, format or type error, sit at the end) and the log's path; the other steps are cancelled, as `concurrently --kill-others-on-fail` does, and print `- <step> cancelled`.

The exit code is the failed step's (non-zero), 0 when all pass, 130 on Ctrl-C.

What stays the same: `npm run check` and `npm run verify:push` print their whole output when called directly, as CI, the local gate and developers do; only the hooks' presentation changed. A new part added to `check` is a step the hook runs, with no second list to update (`scripts/git-hook-output.spec.ts` pins the reading).

When a tail is not enough, read the log it names; it is kept until the temp directory is cleaned.
