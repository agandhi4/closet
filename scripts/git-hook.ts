import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  failureLines,
  type HookStep,
  hookSteps,
  passLine,
  stepLabel,
} from './git-hook-output';

// The runner behind .githooks/pre-commit and pre-push: `node -r ts-node/register/transpile-only
// scripts/git-hook.ts <hook>`. It runs the same npm scripts the hook ran before (#260), in
// parallel and each into its own log, then prints one line per passing step, or a failed
// step's tail and log path. `npm run check` and `verify:push` themselves are untouched: CI,
// the local gate and developers call them directly and still see their whole output.
// docs/git-hooks.md has the why.

// The package.json script each hook stands for; its parts become the steps (git-hook-output.ts).
const HOOK_ENTRIES: Record<string, string> = {
  'pre-commit': 'check',
  'pre-push': 'verify:push',
};

const PROJECT_ROOT = path.join(__dirname, '..');

interface Running {
  step: HookStep;
  child: ChildProcess;
  logPath: string;
  started: number;
}

interface Settled {
  run: Running;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const hook = process.argv[2];
const entry = HOOK_ENTRIES[hook];
if (entry === undefined) {
  console.error(
    `git-hook: unknown hook "${hook}" (expected ${Object.keys(HOOK_ENTRIES).join(' or ')})`,
  );
  process.exit(2);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const steps = hookSteps(packageJson.scripts, entry);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `closet-${hook}-`));

console.log(`${hook}: ${steps.map(stepLabel).join('; ')}`);

// Each step leads its own process group (detached) so cancelling it reaches npm, the shell,
// concurrently and every Vitest or Playwright process under it, as concurrently's
// --kill-others-on-fail does for `npm run check`. Being outside the terminal's foreground
// group, they miss a Ctrl-C: the handlers below forward it.
function start(step: HookStep): Running {
  const logPath = path.join(logDir, `${step.name.replace(/\W/g, '_')}.log`);
  const log = fs.openSync(logPath, 'w');
  const child = spawn('npm', ['run', '-s', step.script], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  return { step, child, logPath, started: Date.now() };
}

function settle(run: Running): Promise<Settled> {
  return new Promise((resolve) => {
    run.child.on('exit', (code, signal) => resolve({ run, code, signal }));
    run.child.on('error', (error) => {
      fs.appendFileSync(run.logPath, `\n${error.message}\n`);
      resolve({ run, code: 1, signal: null });
    });
  });
}

function cancel(run: Running): void {
  if (run.child.pid === undefined || run.child.exitCode !== null) return;
  try {
    process.kill(-run.child.pid, 'SIGTERM');
  } catch (error) {
    // ESRCH: the group exited between the check and the kill.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function main(): Promise<number> {
  const runs = steps.map(start);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      runs.forEach(cancel);
      console.log(`${hook}: interrupted; logs in ${logDir}`);
      process.exit(130);
    });

  const pending = new Map(runs.map((run) => [run, settle(run)]));
  let failure: Settled | undefined;
  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.run);
    const ms = Date.now() - settled.run.started;
    const log = fs.readFileSync(settled.run.logPath, 'utf8');
    if (failure !== undefined) {
      console.log(`- ${settled.run.step.name} cancelled`);
    } else if (settled.code === 0) {
      console.log(passLine(settled.run.step, log, ms));
    } else {
      failure = settled;
      const exit = settled.signal
        ? `signal ${settled.signal}`
        : `exit ${settled.code}`;
      console.log(
        failureLines(settled.run.step, log, exit, ms, settled.run.logPath).join(
          '\n',
        ),
      );
      [...pending.keys()].forEach(cancel);
    }
  }

  if (failure === undefined) {
    fs.rmSync(logDir, { recursive: true, force: true });
    return 0;
  }
  return failure.code ?? 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`git-hook: ${String(error)}; logs in ${logDir}`);
    process.exit(1);
  },
);
