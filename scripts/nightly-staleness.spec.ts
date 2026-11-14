import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/nightly-staleness.sh against canned `gh` answers: a fake gh on PATH replays a
// `gh run list --json` answer and an open-issues list, and logs every other call.
const SCRIPT = join(__dirname, 'nightly-staleness.sh');
const NOW = '2026-11-14T12:00:00Z';
const TITLE = 'Nightly has not completed a scheduled run in 48 hours';

type Run = { conclusion: string; updatedAt: string };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staleness-'));
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "run list") cat "$DIR/runs.json" ;;
  "issue list") cat "$DIR/issues.json" ;;
  *) echo "$*" | tr '\n' ' ' >>"$DIR/calls"; echo >>"$DIR/calls" ;;
esac
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function check(runs: Run[], openIssues: { number: number; title: string }[]) {
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
  writeFileSync(join(dir, 'issues.json'), JSON.stringify(openIssues));
  const result = spawnSync(SCRIPT, [], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      DIR: dir,
      GH_REPO: 'kashhq/closet',
      RUN_URL: 'https://example.test/run/1',
      NOW_EPOCH: String(Date.parse(NOW) / 1000),
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  } catch {
    // no write call was made
  }
  return { status: result.status, stdout: result.stdout.trim(), calls };
}

describe('nightly-staleness.sh', () => {
  it('opens the tracking issue when the last completed scheduled run is older than 48 h', () => {
    const r = check(
      [
        { conclusion: 'success', updatedAt: '2026-11-12T08:35:00Z' },
        { conclusion: 'success', updatedAt: '2026-11-11T08:35:00Z' },
      ],
      [],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('opened the tracking issue');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(
      /^issue create --title Nightly has not completed/,
    );
    expect(r.calls[0]).toContain('2026-11-12T08:35:00Z');
  });

  it('opens it when there is no completed scheduled run at all', () => {
    const r = check([], []);
    expect(r.stdout).toContain('opened the tracking issue');
    expect(r.calls[0]).toContain('No scheduled run has completed');
  });

  it('ignores cancelled and skipped runs when judging freshness', () => {
    const r = check(
      [
        { conclusion: 'cancelled', updatedAt: '2026-11-14T08:35:00Z' },
        { conclusion: 'skipped', updatedAt: '2026-11-13T08:35:00Z' },
        { conclusion: 'startup_failure', updatedAt: '2026-11-13T09:35:00Z' },
        { conclusion: 'success', updatedAt: '2026-11-10T08:35:00Z' },
      ],
      [],
    );
    expect(r.stdout).toContain('opened the tracking issue');
  });

  it('counts a timed-out scheduled run: its jobs ran', () => {
    const r = check(
      [{ conclusion: 'timed_out', updatedAt: '2026-11-14T08:35:00Z' }],
      [],
    );
    expect(r.stdout).toContain('no tracking issue open');
  });

  it('updates the open issue instead of opening a second one', () => {
    const r = check(
      [{ conclusion: 'failure', updatedAt: '2026-11-11T08:35:00Z' }],
      [{ number: 42, title: TITLE }],
    );
    expect(r.stdout).toContain('updated #42');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatch(/^issue edit 42 --body/);
  });

  it('does nothing when a scheduled run completed within 48 h, even a red one', () => {
    const r = check(
      [{ conclusion: 'failure', updatedAt: '2026-11-13T08:35:00Z' }],
      [],
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no tracking issue open');
    expect(r.calls).toEqual([]);
  });

  it('closes the open issue once a scheduled run has completed again', () => {
    const r = check(
      [{ conclusion: 'success', updatedAt: '2026-11-14T08:35:00Z' }],
      [{ number: 42, title: TITLE }],
    );
    expect(r.stdout).toContain('closed #42');
    expect(r.calls.map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual([
      'issue comment 42',
      'issue close 42',
    ]);
  });
});
