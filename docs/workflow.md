# Workflow: the flow per issue slice

The root AGENTS.md Workflow section names each step and its non-negotiables; this is each step in full (moved here on 2026-10-13 to keep AGENTS.md under its size cap).

1. **A branch** `<issue>-<slug>` (e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel.
2. **The fast loop locally**: the spec being worked on, and the pre-commit `npm run check` (~80 s).
3. **Push and open a PR** that links the issue (`Part of #12` / `Closes #12`): `make pr BODY_FILE=<file> [TITLE=…] [DRAFT=1]` (devkit/bin/pr_create.sh) opens it on origin, never on gh's default repo.
4. **The local gate verifies**: `make gate PR=<n>` runs the Makefile's `ci-*` jobs the diff can affect (`scripts/ci/gate_plan.sh`) on the PR merged into `origin/main`, on a throwaway Postgres 18 container, and posts `local-gate`. Fork PRs are refused (public repo). Actions only publishes.
5. **An independent review** of the PR diff.
6. **Codex's go-ahead** (owner, 2026-09-27): `python3 -I ~/projects/solo/claude-kit/plugins/work-loop/bin/codex_gate.py wait agandhi4/closet <pr> --on-limit self-review` asks `@codex review` of the head commit and sets the required `codex-review` status. It passes once Codex reviewed that SHA and every thread is resolved. Answer each thread (`threads agandhi4/closet <pr>`, same script): fix what's valid or reply with the reason it isn't, then `reply <thread> "…" --resolve`. Every push needs a new `wait`. Docs-only PRs skip Codex (status "docs-only"); batch pushes to spare quota. **At its usage limit (`error`), an adversarial Claude review stands in** and, once addressed, `CODEX_FALLBACK=1 make merge PR=<n>` posts the `codex-review` fallback naming the reason it observed in Codex's state (devkit #237); never post that status by hand.
7. **The merge**: `make merge PR=<n>` (devkit/bin/pr_merge.sh) squash-merges only a head whose `local-gate` and `codex-review` are success, and only while `main` is still the one the gate tested (else: re-gate); never `gh pr merge` directly. Merging publishes the image, then deploys.

The owner may stop any PR (comment or close).
