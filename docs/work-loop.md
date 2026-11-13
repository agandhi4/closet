# Work loop profile (closet)

The coordinator's reference for the claude-kit `work-loop` skill. It overrides the skill's bundled
`REPOS.md` closet profile, which still describes the local gate and `closet_merge_queue.sh`. Both
were retired by devkit's 2026-11-02 change: no pre-merge gate, and the publisher's check_tree
proves main.

- **Worker / branch:** `core:implementer` or `general-purpose`, branch `<n>-<slug>`, one git
  worktree per issue at `../closet-<branch>`.
- **Setup (worktree):** `export PATH=$HOME/.local/share/mise/installs/node/22.23.3/bin:$PATH`,
  then `make install` (it sets the hooks and fills `devkit/` from the pin: closet no longer vendors
  devkit, #532), then `npm ci`.
- **Worker env:** a Playwright port per worker (`PORT=3100 + issue mod 900`). Never
  pattern-kill processes (another worker's server dies too).
- **Fast checks:** the spec being worked on, then `make ci-quick ci-unit ci-db` (each brings its
  own throwaway Postgres container), plus `PORT=<own> make ci-e2e` when a page or `public/js`
  changed. **Also run the touched integration specs under the shifted clock** (the gate's
  `clock-db` jobs, 30 and 365 days: `GATE_JOBS_CLOCK` in `scripts/ci/gate_plan.sh`). Only the
  publisher runs those jobs, and a date-dependent spec turned main red on 2026-11-13 (#581). Metrics
  are a report, not a gate (devkit 2026-11-13): no `ci-metrics` or tighten in PR work.
- **Slots: two.** Three or more full suites at once put this 10-core Mac at load 27 (2026-11-13),
  past the tiers' time budgets (ci-db 110 s, ci-e2e 180 s).
- **Review:** `@codex review` on the PR, waited with the skill's `codex_gate.py wait`. When Codex
  is at its limit, `make review PR=<n>` (a local Opus round). The skill's hand-set
  `codex-review` status is NOT accepted by devkit's `make merge`. Docs-only PRs owe none.
  `make merge PR=<n>` refuses until the rounds allow it (P0/P1 block below the cap). It also runs
  a round on a head no round has seen, and files the open P2/P3 findings as issues: close those a
  later commit already fixed. Plans for auth, security and migrations get a Sonnet plan check
  before code; it caught a deadlock, a token race and a CSRF hole on 2026-11-13.
- **Merge:** `make merge PR=<n>`, run from the PR's worktree. Remove the worktree only after GitHub
  reports MERGED (a refused merge once had its branch deleted by a chained cleanup). It squash-merges the reviewed head and
  deletes the branch. The owner granted standing merge authority on 2026-11-12. No auto-merge,
  merge driver or sweeper: main has no required checks.
- **Deploy:** automatic. The publisher host runs check_tree on main within its 3 h window,
  moves `latest`, and the hourly autoupdater pulls it. A red main files a `main-red`, `ratchet`
  or `flaky` issue. A new env var still needs its homelab `stacks/closet` line.
- **Migrations:** Drizzle. The later branch deletes its migration and regenerates it; never
  hand-merge the journal. One migration-adding issue in flight at a time.
- **Headless worker:** not enrolled.
- **Ledger:** `~/.local/state/closet-gate/ledger.tsv`.
