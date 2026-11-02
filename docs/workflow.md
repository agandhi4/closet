# Workflow: the flow per issue slice

The root AGENTS.md Workflow section names each step and its non-negotiables; this is each step in full (moved here on 2026-10-13 to keep AGENTS.md under its size cap).

1. **A branch** `<issue>-<slug>` (e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel.
2. **The fast loop locally**: the spec being worked on, and the pre-commit `npm run check` (~80 s).
3. **Push and open a PR** that links the issue (`Part of #12` / `Closes #12`): `make pr BODY_FILE=<file> [TITLE=…] [DRAFT=1]` (devkit/bin/pr_create.sh) opens it on origin, never on gh's default repo.
4. **No pre-merge gate** (devkit 2026-11-02): main is proven at deploy, when linux-box's publisher runs every job of `scripts/ci/gate_plan.sh` on it (`devkit/bin/check_tree.sh`, at most once per 3 h window, a `main-red` issue on red). Run the `ci-*` targets your change touches before you push. Actions runs only the nightly checks and manual runs.
5. **An independent review** of the PR diff.
6. **A review round**: comment `@codex review`, or run `make review PR=<n>` (a local `claude -p` round, its record posted on the PR) when Codex is out of budget. Answer each P0/P1 finding once: fix what's valid or reply with the reason it isn't. Docs-only PRs owe no round.
7. **The merge**: `make merge PR=<n>` (devkit/bin/pr_merge.sh) decides on the review rounds, at most the plan's `DEVKIT_REVIEW_ROUNDS` (3): below the cap a P0/P1 finding wants another round, at the cap only P0 refuses, and P2 and below (P1 too at the cap) are filed as issues. Never `gh pr merge` directly. Merging publishes the image, then deploys.

The owner may stop any PR (comment or close).
