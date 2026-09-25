import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import autocannon from 'autocannon';
import sharp from 'sharp';
import { createScratchDatabase } from '../test/support/scratch-database';

/**
 * Builds the app, boots dist/main.js with auth off, seeds one garment with a
 * photo through the real endpoints, then runs autocannon against the pages a
 * user actually loads. Results are written per target so
 * `test:load:compare` can diff each one against the saved baseline.
 *
 * LOAD_TEST_DURATION (seconds per target, default 5) is the only knob; the
 * server otherwise inherits the environment (file storage, as in CI's local
 * and object-storage jobs). It always runs on a scratch Postgres database, and
 * DATA_PATH defaults to a fresh temp directory, so a local run never seeds
 * the development database or its photos.
 */

const BASE_URL = 'http://localhost:3000';
const CONNECTIONS = 10;
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION ?? 5);
const BASELINE_PATH = path.join(__dirname, 'results', 'baseline.json');
const RESULTS_PATH = path.join(__dirname, 'results', 'load-test-results.json');

interface Target {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** The subset of autocannon's result the summary and comparison read. */
interface AutocannonResult {
  requests: { average: number };
  latency: { average: number; p50: number; p99: number };
  throughput: { average: number };
  non2xx: number;
}

type Results = Record<string, AutocannonResult>;

async function main() {
  const isBaseline = process.argv.includes('--baseline');
  const isCompare = process.argv.includes('--compare');
  if (!Number.isFinite(DURATION_SECONDS) || DURATION_SECONDS <= 0) {
    throw new Error(
      `LOAD_TEST_DURATION must be a positive number of seconds, got ${process.env.LOAD_TEST_DURATION}`,
    );
  }

  console.log('Building app...');
  execSync('npm run build', { stdio: 'inherit' });

  const database = await createScratchDatabase('closet_load');
  const dataPath =
    process.env.DATA_PATH ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'closet-load-'));
  console.log(`Starting server (DATA_PATH=${dataPath})...`);
  let stderr = '';
  // stdout is dropped: pino-http logs every request, and an unread pipe
  // would fill up and stall the server under load.
  const server = spawn('node', ['dist/main.js'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ...database.env,
      NODE_ENV: 'production',
      AUTH_ENABLED: 'false',
      DATA_PATH: dataPath,
    },
  });
  server.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  server.on('error', (err) => {
    console.error('Server failed to start:', err);
  });

  try {
    await waitForServer(`${BASE_URL}/healthz`, server, () => stderr);

    const thumbUrl = await seedGarment();
    const targets: Target[] = [
      { name: 'wardrobe', url: `${BASE_URL}/wardrobe` },
      {
        name: 'wardrobe-fragment',
        url: `${BASE_URL}/wardrobe`,
        headers: { 'HX-Request': 'true' },
      },
      { name: 'outfits-new', url: `${BASE_URL}/outfits/new` },
      { name: 'thumb', url: `${BASE_URL}${thumbUrl}` },
    ];

    const results: Results = {};
    for (const target of targets) {
      console.log(
        `Running load test against ${target.name} (${target.url}) for ${DURATION_SECONDS}s ...`,
      );
      results[target.name] = await autocannon({
        url: target.url,
        headers: target.headers,
        connections: CONNECTIONS,
        duration: DURATION_SECONDS,
      });
    }

    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

    printSummary(results);

    const failing = Object.entries(results).filter(([, r]) => r.non2xx > 0);
    if (failing.length > 0) {
      throw new Error(
        `Non-2xx responses under load: ${failing.map(([n, r]) => `${n}=${r.non2xx}`).join(', ')}`,
      );
    }

    if (isBaseline) {
      fs.copyFileSync(RESULTS_PATH, BASELINE_PATH);
      console.log(`Baseline saved to ${BASELINE_PATH}`);
    }

    if (isCompare) {
      if (fs.existsSync(BASELINE_PATH)) {
        const baseline = JSON.parse(
          fs.readFileSync(BASELINE_PATH, 'utf-8'),
        ) as Results;
        printComparison(baseline, results);
      } else {
        console.warn('No baseline found. Run with --baseline first.');
      }
    }
  } finally {
    server.kill('SIGTERM');
    await database.drop();
    if (!process.env.DATA_PATH) {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
  }
}

/**
 * The two requests the garment form makes (POST /wardrobe, then the photo),
 * as in test/integration/garments.ts. Returns the versioned thumb URL the
 * wardrobe grid renders for it.
 */
async function seedGarment(): Promise<string> {
  const created = await fetch(`${BASE_URL}/wardrobe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Load test shirt', category: 'shirt' }),
    redirect: 'manual',
  });
  const location = created.headers.get('location') ?? '';
  const id = /^\/wardrobe\/(\d+)/.exec(location)?.[1];
  if (created.status !== 302 || !id) {
    throw new Error(
      `Seeding the garment failed: ${created.status} ${location || (await created.text())}`,
    );
  }

  const photo = new FormData();
  photo.append(
    'photo',
    new Blob([new Uint8Array(await jpegPhoto())], { type: 'image/jpeg' }),
    'photo.jpg',
  );
  const uploaded = await fetch(`${BASE_URL}/wardrobe/${id}/photo`, {
    method: 'POST',
    body: photo,
  });
  if (!uploaded.ok) {
    throw new Error(
      `Uploading the photo failed: ${uploaded.status} ${await uploaded.text()}`,
    );
  }

  const html = await (await fetch(`${BASE_URL}/wardrobe`)).text();
  const thumb = /\/file\/thumb\/[A-Za-z0-9._-]+\?v=\d+/.exec(html)?.[0];
  if (!thumb) {
    throw new Error('The wardrobe page does not show the seeded thumb');
  }
  console.log(`Seeded garment ${id} with thumb ${thumb}`);
  return thumb;
}

function jpegPhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
}

function waitForServer(
  url: string,
  server: ChildProcess,
  stderr: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const onExit = (code: number | null) => {
      clearInterval(interval);
      reject(
        new Error(
          `Server exited unexpectedly with code ${code}\nStderr:\n${stderr()}`,
        ),
      );
    };
    server.once('exit', onExit);

    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(url);
          if (res.ok) {
            clearInterval(interval);
            server.off('exit', onExit);
            resolve();
          }
        } catch {
          if (Date.now() - start > 30000) {
            clearInterval(interval);
            server.off('exit', onExit);
            reject(new Error('Server did not start within 30s'));
          }
        }
      })();
    }, 500);
  });
}

function printSummary(results: Results) {
  console.log('\n--- Load Test Results ---');
  for (const [name, result] of Object.entries(results)) {
    console.log(`${name}:`);
    console.log(`  Requests/sec: ${result.requests.average.toFixed(2)}`);
    console.log(`  Latency avg:  ${result.latency.average.toFixed(2)} ms`);
    console.log(`  Latency p50:  ${result.latency.p50.toFixed(2)} ms`);
    console.log(`  Latency p99:  ${result.latency.p99.toFixed(2)} ms`);
    console.log(
      `  Throughput:   ${(result.throughput.average / 1024 / 1024).toFixed(2)} MB/sec`,
    );
    if (result.non2xx > 0) {
      console.log(`  Non-2xx:      ${result.non2xx}`);
    }
  }
  console.log('-------------------------\n');
}

function printComparison(baseline: Results, current: Results) {
  console.log('--- Comparison vs Baseline ---');
  for (const [name, result] of Object.entries(current)) {
    const base = baseline[name];
    if (!base) {
      console.log(`${name}: no baseline entry (re-run with --baseline)`);
      continue;
    }
    const reqDiff = percentChange(
      base.requests.average,
      result.requests.average,
    );
    const latDiff = percentChange(base.latency.average, result.latency.average);
    console.log(`${name}:`);
    console.log(
      `  Requests/sec: ${result.requests.average.toFixed(2)} (${reqDiff})`,
    );
    console.log(
      `  Latency avg:  ${result.latency.average.toFixed(2)} ms (${latDiff})`,
    );
  }
  console.log('-------------------------------\n');
}

function percentChange(oldVal: number, newVal: number): string {
  const change = ((newVal - oldVal) / oldVal) * 100;
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
