# Workflow: the flow per issue slice

The root AGENTS.md Workflow section names each step and its non-negotiables; this is each step in full (moved here on 2026-10-13 to keep AGENTS.md under its size cap).

1. **A branch** `<issue>-<slug>` (e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel.
2. **The fast loop locally**: the spec being worked on, and the pre-commit `npm run check` (~80 s).
3. **Push and open a PR** that links the issue (`Part of #12` / `Closes #12`).
4. **The local gate verifies**: `make gate PR=<n>` runs the Makefile's `ci-*` jobs the diff can affect (`scripts/ci/gate_plan.sh`) on the PR merged into `origin/main`, on a throwaway Postgres 18 container, and posts `local-gate`. Fork PRs are refused (public repo). Actions only publishes.
5. **An independent review** of the PR diff.
6. **Codex's go-ahead** (owner, 2026-09-27): `~/.claude/scripts/agent-worker/codex_gate.py wait agandhi4/closet <pr>` asks `@codex review` of the head commit and sets the required `codex-review` status. It passes once Codex reviewed that SHA and every thread is resolved. Answer each thread (`threads agandhi4/closet <pr>`, same script): fix what's valid or reply with the reason it isn't, then `reply <thread> "…" --resolve`. Every push needs a new `wait`. Docs-only PRs skip Codex (status "docs-only"); batch pushes to spare quota. **At its usage limit (`error`), an adversarial Claude review stands in** and, once addressed, sets `codex-review` success ("Claude adversarial review (Codex at limit)").
7. **The merge queue** (`closet_merge_queue.sh`) then gates and squash-merges pinned to the gated head; never `gh pr merge --auto`. Merging publishes the image, then deploys.

The owner may stop any PR (comment or close).
